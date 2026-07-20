import { json, userId, hashPassword, verifyPassword, makeSession, readSession, sessionCookie, readJSON, writeJSON } from './_lib.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // whoami
    const uid = readSession(req);
    if (!uid) return json(res, 200, { user: null });
    const acct = await readJSON(`users/${uid}.json`);
    return json(res, 200, { user: acct ? { email: acct.email } : null });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  const { action, email: rawEmail, password } = req.body || {};

  if (action === 'logout') {
    res.setHeader('set-cookie', sessionCookie('', 0));
    return json(res, 200, { ok: true });
  }

  const email = String(rawEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter a valid email address' });
  if (typeof password !== 'string' || password.length < 8)
    return json(res, 400, { error: 'Password must be at least 8 characters' });

  const uid = userId(email);
  const path = `users/${uid}.json`;

  if (action === 'signup') {
    if (await readJSON(path)) return json(res, 409, { error: 'An account with that email already exists — log in instead' });
    const { salt, hash } = hashPassword(password);
    await writeJSON(path, { email, salt, hash, created: Date.now() });
    res.setHeader('set-cookie', sessionCookie(makeSession(uid), 30 * 86400));
    return json(res, 200, { user: { email } });
  }

  if (action === 'login') {
    const acct = await readJSON(path);
    if (!acct || !verifyPassword(password, acct.salt, acct.hash))
      return json(res, 401, { error: 'Wrong email or password' });
    res.setHeader('set-cookie', sessionCookie(makeSession(uid), 30 * 86400));
    return json(res, 200, { user: { email } });
  }

  return json(res, 400, { error: 'unknown action' });
}
