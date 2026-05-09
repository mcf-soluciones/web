/**
 * POST /api/auth/cuentas
 *   body: { password: string }
 *
 * Validates the password against CUENTAS_PASSWORD (Vercel env var). Returns
 * { success: true } on match, 401 otherwise. The frontend sets a sessionStorage
 * flag on success and routes the accountant into gastos-only mode.
 *
 * This is a UI-level gate. The underlying /api/gastos/* and /api/reports/*
 * endpoints are not protected — anyone with the URL can still call them.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const expected = process.env.CUENTAS_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: 'CUENTAS_PASSWORD not configured on the server' });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'password is required' });
    }
    // Constant-time comparison to dodge timing oracles. Lengths must match too.
    if (password.length !== expected.length) {
      return res.status(401).json({ error: 'invalid password' });
    }
    let mismatch = 0;
    for (let i = 0; i < password.length; i++) {
      mismatch |= password.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (mismatch !== 0) return res.status(401).json({ error: 'invalid password' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('auth/cuentas error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
