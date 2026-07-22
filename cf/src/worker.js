import {
  json, hashPassword, verifyPassword, userId, makeSession, readSession, sessionCookie,
  readJSON, writeJSON, deleteKey, putPresence, listPresences, deletePresence,
} from './lib.js';

const MAX_BYTES = 20 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[a-zA-Z0-9_-]{8,32}$/;
const CLIENT_RE = /^[a-zA-Z0-9_-]{6,40}$/;

function randomId(bytes = 9) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/** Returns a 429 Response if the limiter says no, otherwise null. Fails open if the
 *  binding is missing (e.g. local dev) so a config hiccup never takes the whole API down. */
async function rateLimited(env, limiter, request) {
  const rl = env[limiter];
  if (!rl) return null;
  try {
    const { success } = await rl.limit({ key: clientIp(request) });
    if (!success) return json(429, { error: 'Too many requests — please slow down and try again shortly' });
  } catch {}
  return null;
}

/* ---------- /api/auth ---------- */
async function handleAuth(request, env) {
  const { KV, AUTH_SECRET } = env;

  if (request.method === 'GET') {
    const uid = await readSession(request, AUTH_SECRET);
    if (!uid) return json(200, { user: null });
    const acct = await readJSON(KV, `users:${uid}`);
    return json(200, { user: acct ? { email: acct.email } : null });
  }

  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  const body = await readBody(request);
  const { action, email: rawEmail, password } = body || {};

  if (action !== 'logout') {
    const limited = await rateLimited(env, 'RL_AUTH', request);
    if (limited) return limited;
  }

  if (action === 'logout') {
    return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  const email = String(rawEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json(400, { error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8) return json(400, { error: 'Password must be at least 8 characters' });

  const uid = await userId(email);
  const key = `users:${uid}`;

  if (action === 'signup') {
    if (await readJSON(KV, key)) return json(409, { error: 'An account with that email already exists — log in instead' });
    const { salt, hash } = await hashPassword(password);
    await writeJSON(KV, key, { email, salt, hash, created: Date.now() });
    const token = await makeSession(AUTH_SECRET, uid);
    return json(200, { user: { email } }, { 'set-cookie': sessionCookie(token, 30 * 86400) });
  }

  if (action === 'login') {
    const acct = await readJSON(KV, key);
    if (!acct || !(await verifyPassword(password, acct.salt, acct.hash))) return json(401, { error: 'Wrong email or password' });
    const token = await makeSession(AUTH_SECRET, uid);
    return json(200, { user: { email } }, { 'set-cookie': sessionCookie(token, 30 * 86400) });
  }

  return json(400, { error: 'unknown action' });
}

/* ---------- /api/board (multi-board) ---------- */
function indexKey(uid) { return `boards:${uid}:_index`; }
function boardKey(uid, id) { return `boards:${uid}:${id}`; }

async function readIndex(KV, uid) {
  return (await readJSON(KV, indexKey(uid))) || { activeId: null, items: {} };
}

async function handleBoard(request, env, url) {
  const { KV, AUTH_SECRET } = env;
  const uid = await readSession(request, AUTH_SECRET);
  if (!uid) return json(401, { error: 'not signed in' });
  const id = url.searchParams.get('id');

  if (request.method === 'GET') {
    if (id) {
      if (!ID_RE.test(id)) return json(400, { error: 'bad id' });
      const doc = await readJSON(KV, boardKey(uid, id));
      if (!doc) return json(404, { error: 'Board not found' });
      const idx = await readIndex(KV, uid);
      if (idx.activeId !== id) { idx.activeId = id; await writeJSON(KV, indexKey(uid), idx); }
      return json(200, { doc, name: idx.items[id]?.name || 'Untitled board' });
    }
    const idx = await readIndex(KV, uid);
    const boards = Object.entries(idx.items)
      .map(([bid, meta]) => ({ id: bid, name: meta.name, updatedAt: meta.updatedAt }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return json(200, { boards, activeId: idx.activeId });
  }

  if (request.method === 'POST') {
    const limited = await rateLimited(env, 'RL_CREATE', request);
    if (limited) return limited;
    const body = await readBody(request);
    const { doc, name } = body || {};
    if (!doc || !Array.isArray(doc.pages)) return json(400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(413, { error: 'Board too large to save' });
    const bid = randomId();
    const now = Date.now();
    doc.savedAt = now;
    await writeJSON(KV, boardKey(uid, bid), doc);
    const idx = await readIndex(KV, uid);
    idx.items[bid] = { name: (name || 'Untitled board').slice(0, 60), updatedAt: now };
    idx.activeId = bid;
    await writeJSON(KV, indexKey(uid), idx);
    return json(200, { id: bid, name: idx.items[bid].name });
  }

  if (request.method === 'PUT') {
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    const doc = await readBody(request);
    if (!doc || !Array.isArray(doc.pages)) return json(400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(413, { error: 'Board too large to sync' });
    const now = Date.now();
    doc.savedAt = now;
    await writeJSON(KV, boardKey(uid, id), doc);
    const idx = await readIndex(KV, uid);
    if (!idx.items[id]) idx.items[id] = { name: 'Untitled board', updatedAt: now };
    else idx.items[id].updatedAt = now;
    idx.activeId = id;
    await writeJSON(KV, indexKey(uid), idx);
    return json(200, { ok: true, savedAt: now });
  }

  if (request.method === 'PATCH') {
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    const body = await readBody(request);
    const name = body?.name;
    if (!name || !name.trim()) return json(400, { error: 'bad name' });
    const idx = await readIndex(KV, uid);
    if (!idx.items[id]) return json(404, { error: 'Board not found' });
    idx.items[id].name = name.trim().slice(0, 60);
    await writeJSON(KV, indexKey(uid), idx);
    return json(200, { ok: true });
  }

  if (request.method === 'DELETE') {
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    const idx = await readIndex(KV, uid);
    delete idx.items[id];
    if (idx.activeId === id) idx.activeId = Object.keys(idx.items)[0] || null;
    await writeJSON(KV, indexKey(uid), idx);
    await deleteKey(KV, boardKey(uid, id));
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}

/* ---------- /api/share ---------- */
async function handleShare(request, env, url) {
  const { KV } = env;

  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    const rev = url.searchParams.get('rev');
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    const cur = await readJSON(KV, `shared:${id}`);
    if (!cur) return json(404, { error: 'Board not found' });
    if (+rev === cur.rev) return json(200, { rev: cur.rev });
    return json(200, { rev: cur.rev, doc: cur.doc });
  }

  if (request.method === 'POST') {
    const limited = await rateLimited(env, 'RL_CREATE', request);
    if (limited) return limited;
    const body = await readBody(request);
    const doc = body?.doc;
    if (!doc || !Array.isArray(doc.pages)) return json(400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(413, { error: 'Board too large to share' });
    const id = randomId();
    await writeJSON(KV, `shared:${id}`, { doc, rev: 1, created: Date.now() });
    return json(200, { id, rev: 1 });
  }

  if (request.method === 'PUT') {
    const body = await readBody(request);
    const { id, doc } = body || {};
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    if (!doc || !Array.isArray(doc.pages)) return json(400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(413, { error: 'Board too large' });
    const cur = await readJSON(KV, `shared:${id}`);
    if (!cur) return json(404, { error: 'Board not found' });
    const rev = cur.rev + 1;
    await writeJSON(KV, `shared:${id}`, { doc, rev, created: cur.created, updated: Date.now() });
    return json(200, { rev });
  }

  return json(405, { error: 'method not allowed' });
}

/* ---------- /api/presence ---------- */
async function handlePresence(request, env, url) {
  const { KV } = env;

  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!ID_RE.test(id || '')) return json(400, { error: 'bad id' });
    const active = await listPresences(KV, id);
    return json(200, { presences: active });
  }

  if (request.method === 'POST') {
    const body = await readBody(request);
    const { id, clientId, name, color, x, y, page } = body || {};
    if (!ID_RE.test(id || '') || !CLIENT_RE.test(clientId || '')) return json(400, { error: 'bad request' });
    if (typeof x !== 'number' || typeof y !== 'number') return json(400, { error: 'bad coords' });
    await putPresence(KV, id, clientId, {
      clientId,
      name: String(name || 'Guest').slice(0, 24),
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f6df5',
      x, y,
      page: Number.isFinite(+page) ? +page : 0,
      ts: Date.now(),
    });
    return json(200, { ok: true });
  }

  if (request.method === 'DELETE') {
    const body = await readBody(request);
    const { id, clientId } = body || {};
    if (ID_RE.test(id || '') && CLIENT_RE.test(clientId || '')) await deletePresence(KV, id, clientId);
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
}

/* ---------- router ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth') return handleAuth(request, env);
    if (url.pathname === '/api/board') return handleBoard(request, env, url);
    if (url.pathname === '/api/share') return handleShare(request, env, url);
    if (url.pathname === '/api/presence') return handlePresence(request, env, url);

    // clean URL -> the actual asset filename
    if (url.pathname === '/app') {
      return env.ASSETS.fetch(new URL('/app.html', url));
    }

    return env.ASSETS.fetch(request);
  },
};
