import crypto from 'node:crypto';
import { put, head, del } from '@vercel/blob';

const SECRET = process.env.AUTH_SECRET || '';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json').send(JSON.stringify(body));
}

export function userId(email) {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

export function makeSession(uid, days = 30) {
  const exp = Date.now() + days * 864e5;
  const payload = `${uid}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)wb_session=([^;]+)/);
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!uid || !exp || !sig) return null;
  if (sign(`${uid}.${exp}`) !== sig) return null;
  if (Date.now() > +exp) return null;
  return uid;
}

export function sessionCookie(token, maxAge) {
  return `wb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/* ---- blob-backed JSON storage ---- */
export async function readJSON(pathname) {
  try {
    const meta = await head(pathname, { token: BLOB_TOKEN });
    // cache-bust: overwritten blobs are CDN-cached, which breaks fresh reads
    const base = meta.downloadUrl || meta.url;
    const url = base + (base.includes('?') ? '&' : '?') + 'cb=' + Date.now();
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${BLOB_TOKEN}`, 'cache-control': 'no-cache' },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function writeJSON(pathname, data) {
  await put(pathname, JSON.stringify(data), {
    access: 'private',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}

export async function deleteBlob(pathname) {
  try { await del(pathname, { token: BLOB_TOKEN }); } catch {}
}

/* ---- presence ----
   list() on Vercel Blob is only eventually consistent — a brand-new client's
   blob can take several seconds to appear in a prefix listing. So instead of
   listing, we keep a small "roster" file (a plain exact-key read, which IS
   consistent) naming which clientIds might be active, and fetch each of
   those by exact key.

   Presence data (a cursor position, a display name) isn't sensitive, so it's
   stored as *public* blobs with a predictable URL. That lets reads skip the
   head()-then-fetch() round trip that private blobs require (head() just to
   learn a signed download URL) — a read is a single fetch, which matters a
   lot when this runs on a fast poll loop. */
let publicBase = null; // cached "https://<store>.public.blob.vercel-storage.com", learned from any write

async function writePublicJSON(pathname, data) {
  const blob = await put(pathname, JSON.stringify(data), {
    access: 'public',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
  if (!publicBase) {
    const u = new URL(blob.url);
    publicBase = `${u.protocol}//${u.host}`;
  }
}

async function readPublicJSON(pathname) {
  if (publicBase) {
    try {
      const r = await fetch(`${publicBase}/${pathname}?cb=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
  }
  // cold start / not cached yet — fall back to the slower head()+fetch path once
  return readJSON(pathname);
}

const ROSTER_TTL = 30000;    // drop a roster entry if not renewed within this long
const ROSTER_WRITE_MIN = 3000; // only rewrite the roster this often per client

export async function putPresence(id, clientId, data) {
  await writePublicJSON(`presence/${id}/${clientId}.json`, data);

  const rosterPath = `presence/${id}/_roster.json`;
  const roster = (await readPublicJSON(rosterPath)) || {};
  const now = Date.now();
  const lastWritten = roster[clientId];
  if (lastWritten == null || now - lastWritten > ROSTER_WRITE_MIN) {
    roster[clientId] = now;
    for (const cid of Object.keys(roster)) {
      if (now - roster[cid] > ROSTER_TTL) delete roster[cid];
    }
    await writePublicJSON(rosterPath, roster);
  }
}

export async function listPresences(id) {
  const roster = (await readPublicJSON(`presence/${id}/_roster.json`)) || {};
  const clientIds = Object.keys(roster);
  const results = await Promise.all(clientIds.map(cid => readPublicJSON(`presence/${id}/${cid}.json`)));
  return results.filter(Boolean);
}

export async function deletePresence(id, clientId) {
  try { await del(`presence/${id}/${clientId}.json`, { token: BLOB_TOKEN }); } catch {}
  try {
    const rosterPath = `presence/${id}/_roster.json`;
    const roster = await readPublicJSON(rosterPath);
    if (roster && clientId in roster) {
      delete roster[clientId];
      await writePublicJSON(rosterPath, roster);
    }
  } catch {}
}
