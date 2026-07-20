import crypto from 'node:crypto';
import { put, head, del, list } from '@vercel/blob';

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

/* ---- presence: one small blob per client, listed by prefix ---- */
export async function putPresence(id, clientId, data) {
  await put(`presence/${id}/${clientId}.json`, JSON.stringify(data), {
    access: 'private',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}

export async function listPresences(id) {
  const { blobs } = await list({ prefix: `presence/${id}/`, token: BLOB_TOKEN });
  const results = await Promise.all(blobs.map(async b => {
    try {
      const base = b.downloadUrl || b.url;
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
  }));
  return results.filter(Boolean);
}

export async function deletePresence(id, clientId) {
  try { await del(`presence/${id}/${clientId}.json`, { token: BLOB_TOKEN }); } catch {}
}
