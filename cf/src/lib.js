/* ---------- responses ---------- */
export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/* ---------- crypto (Web Crypto — no Node compat needed) ---------- */
const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt: toHex(salt), hash: toHex(bits) };
}

export async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return toHex(sig);
}

export async function userId(email) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(email));
  return toHex(digest).slice(0, 24);
}

export async function makeSession(secret, uid, days = 30) {
  const exp = Date.now() + days * 864e5;
  const payload = `${uid}.${exp}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function readSession(request, secret) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wb_session=([^;]+)/);
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!uid || !exp || !sig) return null;
  if ((await hmac(secret, `${uid}.${exp}`)) !== sig) return null;
  if (Date.now() > +exp) return null;
  return uid;
}

export function sessionCookie(token, maxAge) {
  return `wb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/* ---------- KV-backed JSON storage ---------- */
export async function readJSON(kv, key) {
  const v = await kv.get(key);
  return v ? JSON.parse(v) : null;
}
export async function writeJSON(kv, key, data, opts) {
  await kv.put(key, JSON.stringify(data), opts);
}
export async function deleteKey(kv, key) {
  await kv.delete(key);
}

/* ---------- presence ----------
   Cloudflare KV's list() is also only eventually consistent for brand-new
   keys, same issue as Vercel Blob — so we keep the same small "roster" of
   active clientIds (a single exact-key read/write) instead of listing. */
const ROSTER_TTL = 60000; // Cloudflare KV requires expirationTtl >= 60s, so this can't go lower
const ROSTER_WRITE_MIN = 3000;
const PRESENCE_TTL_SEC = 60; // KV's native TTL cleans up abandoned entries for free

export async function putPresence(kv, id, clientId, data) {
  await writeJSON(kv, `presence:${id}:${clientId}`, data, { expirationTtl: PRESENCE_TTL_SEC });

  const rosterKey = `presence:${id}:_roster`;
  const roster = (await readJSON(kv, rosterKey)) || {};
  const now = Date.now();
  const lastWritten = roster[clientId];
  if (lastWritten == null || now - lastWritten > ROSTER_WRITE_MIN) {
    roster[clientId] = now;
    for (const cid of Object.keys(roster)) {
      if (now - roster[cid] > ROSTER_TTL) delete roster[cid];
    }
    await writeJSON(kv, rosterKey, roster, { expirationTtl: ROSTER_TTL / 1000 + 10 });
  }
}

export async function listPresences(kv, id) {
  const roster = (await readJSON(kv, `presence:${id}:_roster`)) || {};
  const clientIds = Object.keys(roster);
  const results = await Promise.all(clientIds.map(cid => readJSON(kv, `presence:${id}:${cid}`)));
  return results.filter(Boolean);
}

export async function deletePresence(kv, id, clientId) {
  await deleteKey(kv, `presence:${id}:${clientId}`);
  const rosterKey = `presence:${id}:_roster`;
  const roster = await readJSON(kv, rosterKey);
  if (roster && clientId in roster) {
    delete roster[clientId];
    await writeJSON(kv, rosterKey, roster, { expirationTtl: ROSTER_TTL / 1000 + 10 });
  }
}
