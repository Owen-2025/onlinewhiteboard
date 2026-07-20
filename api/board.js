import crypto from 'node:crypto';
import { json, readSession, readJSON, writeJSON, deleteBlob } from './_lib.js';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per board doc
const ID_RE = /^[a-zA-Z0-9_-]{8,32}$/;

function indexPath(uid) { return `boards/${uid}/_index.json`; }
function boardPath(uid, id) { return `boards/${uid}/${id}.json`; }

async function readIndex(uid) {
  return (await readJSON(indexPath(uid))) || { activeId: null, items: {} };
}

export default async function handler(req, res) {
  const uid = readSession(req);
  if (!uid) return json(res, 401, { error: 'not signed in' });
  const { id } = req.query;

  if (req.method === 'GET') {
    if (id) {
      if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
      const doc = await readJSON(boardPath(uid, id));
      if (!doc) return json(res, 404, { error: 'Board not found' });
      const idx = await readIndex(uid);
      if (idx.activeId !== id) { idx.activeId = id; await writeJSON(indexPath(uid), idx); }
      return json(res, 200, { doc, name: idx.items[id]?.name || 'Untitled board' });
    }
    const idx = await readIndex(uid);
    const boards = Object.entries(idx.items)
      .map(([bid, meta]) => ({ id: bid, name: meta.name, updatedAt: meta.updatedAt }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return json(res, 200, { boards, activeId: idx.activeId });
  }

  if (req.method === 'POST') {
    const { doc, name } = req.body || {};
    if (!doc || !Array.isArray(doc.pages)) return json(res, 400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(res, 413, { error: 'Board too large to save' });
    const bid = crypto.randomBytes(9).toString('base64url');
    const now = Date.now();
    doc.savedAt = now;
    await writeJSON(boardPath(uid, bid), doc);
    const idx = await readIndex(uid);
    idx.items[bid] = { name: (name || 'Untitled board').slice(0, 60), updatedAt: now };
    idx.activeId = bid;
    await writeJSON(indexPath(uid), idx);
    return json(res, 200, { id: bid, name: idx.items[bid].name });
  }

  if (req.method === 'PUT') {
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    const doc = req.body;
    if (!doc || !Array.isArray(doc.pages)) return json(res, 400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(res, 413, { error: 'Board too large to sync' });
    const now = Date.now();
    doc.savedAt = now;
    await writeJSON(boardPath(uid, id), doc);
    const idx = await readIndex(uid);
    if (!idx.items[id]) idx.items[id] = { name: 'Untitled board', updatedAt: now };
    else idx.items[id].updatedAt = now;
    idx.activeId = id;
    await writeJSON(indexPath(uid), idx);
    return json(res, 200, { ok: true, savedAt: now });
  }

  if (req.method === 'PATCH') {
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    const { name } = req.body || {};
    if (!name || !name.trim()) return json(res, 400, { error: 'bad name' });
    const idx = await readIndex(uid);
    if (!idx.items[id]) return json(res, 404, { error: 'Board not found' });
    idx.items[id].name = name.trim().slice(0, 60);
    await writeJSON(indexPath(uid), idx);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE') {
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    const idx = await readIndex(uid);
    delete idx.items[id];
    if (idx.activeId === id) idx.activeId = Object.keys(idx.items)[0] || null;
    await writeJSON(indexPath(uid), idx);
    await deleteBlob(boardPath(uid, id));
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'method not allowed' });
}
