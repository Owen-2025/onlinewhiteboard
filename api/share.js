import crypto from 'node:crypto';
import { json, readJSON, writeJSON } from './_lib.js';

const MAX_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[a-zA-Z0-9_-]{8,32}$/;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { id, rev } = req.query;
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    const cur = await readJSON(`shared/${id}.json`);
    if (!cur) return json(res, 404, { error: 'Board not found' });
    // if the client is already at this revision, skip the (potentially large) doc
    if (+rev === cur.rev) return json(res, 200, { rev: cur.rev });
    return json(res, 200, { rev: cur.rev, doc: cur.doc });
  }

  if (req.method === 'POST') {
    // create a new shared board from the supplied doc
    const doc = req.body?.doc;
    if (!doc || !Array.isArray(doc.pages)) return json(res, 400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(res, 413, { error: 'Board too large to share' });
    const id = crypto.randomBytes(9).toString('base64url'); // 12 chars
    await writeJSON(`shared/${id}.json`, { doc, rev: 1, created: Date.now() });
    return json(res, 200, { id, rev: 1 });
  }

  if (req.method === 'PUT') {
    const { id, doc } = req.body || {};
    if (!ID_RE.test(id || '')) return json(res, 400, { error: 'bad id' });
    if (!doc || !Array.isArray(doc.pages)) return json(res, 400, { error: 'bad doc' });
    if (JSON.stringify(doc).length > MAX_BYTES) return json(res, 413, { error: 'Board too large' });
    const cur = await readJSON(`shared/${id}.json`);
    if (!cur) return json(res, 404, { error: 'Board not found' });
    const rev = cur.rev + 1;
    await writeJSON(`shared/${id}.json`, { doc, rev, created: cur.created, updated: Date.now() });
    return json(res, 200, { rev });
  }

  return json(res, 405, { error: 'method not allowed' });
}
