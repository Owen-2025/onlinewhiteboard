import { json, putPresence, listPresences, deletePresence } from './_lib.js';

const ID_RE = /^[a-zA-Z0-9_-]{8,32}$/;
const CLIENT_RE = /^[a-zA-Z0-9_-]{6,40}$/;
const STALE_MS = 8000; // treat a cursor as "left" if it hasn't updated in this long

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { id } = req.query;
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    const all = await listPresences(id);
    const now = Date.now();
    const active = all.filter(p => p && now - p.ts < STALE_MS);
    return json(res, 200, { presences: active });
  }

  if (req.method === 'POST') {
    const { id, clientId, name, color, x, y, page } = req.body || {};
    if (!ID_RE.test(id || '') || !CLIENT_RE.test(clientId || '')) return json(res, 400, { error: 'bad request' });
    if (typeof x !== 'number' || typeof y !== 'number') return json(res, 400, { error: 'bad coords' });
    await putPresence(id, clientId, {
      clientId,
      name: String(name || 'Guest').slice(0, 24),
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f6df5',
      x, y,
      page: Number.isFinite(+page) ? +page : 0,
      ts: Date.now(),
    });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    const { id, clientId } = req.body || {};
    if (ID_RE.test(id || '') && CLIENT_RE.test(clientId || '')) await deletePresence(id, clientId);
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'method not allowed' });
}
