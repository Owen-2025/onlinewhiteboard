import { json, readSession, readJSON, writeJSON } from './_lib.js';

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per board doc

export default async function handler(req, res) {
  const uid = readSession(req);
  if (!uid) return json(res, 401, { error: 'not signed in' });
  const path = `boards/${uid}.json`;

  if (req.method === 'GET') {
    const doc = await readJSON(path);
    return json(res, 200, { doc });
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const doc = req.body;
    if (!doc || !Array.isArray(doc.pages)) return json(res, 400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(res, 413, { error: 'Board too large to sync' });
    doc.savedAt = Date.now();
    await writeJSON(path, doc);
    return json(res, 200, { ok: true, savedAt: doc.savedAt });
  }

  return json(res, 405, { error: 'method not allowed' });
}
