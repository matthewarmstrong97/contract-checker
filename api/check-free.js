// api/check-free.js
// Checks whether this browser has already used its free review.
// Uses an HttpOnly cookie — no database required.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const used = cookies['bys_free_used'] === '1';

  return res.status(200).json({ hasFree: !used });
};

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach((part) => {
    const [key, ...val] = part.trim().split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  });
  return cookies;
}
