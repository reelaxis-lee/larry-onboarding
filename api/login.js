/**
 * api/login.js — Vercel proxy to Mac Mini webhook server.
 * Forwards login/status/2fa requests to the Mac Mini without
 * exposing the webhook secret or URL to the client.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookUrl || !webhookSecret) {
    return res.status(503).json({ error: 'Login service not configured.' });
  }

  const { action } = req.query;

  try {
    let upstream;

    if (action === 'start' && req.method === 'POST') {
      const { nickname, email, password } = req.body;
      upstream = await fetch(`${webhookUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': webhookSecret },
        body: JSON.stringify({ nickname, email, password }),
      });

    } else if (action === 'status' && req.method === 'GET') {
      const { sessionId } = req.query;
      upstream = await fetch(`${webhookUrl}/status/${sessionId}`, {
        headers: { 'x-webhook-secret': webhookSecret },
      });

    } else if (action === 'verify' && req.method === 'POST') {
      const { sessionId, code } = req.body;
      upstream = await fetch(`${webhookUrl}/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': webhookSecret },
        body: JSON.stringify({ sessionId, code }),
      });

    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const data = await upstream.json();
    return res.status(upstream.status).json(data);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(502).json({ error: 'Could not reach login service. Please try again.' });
  }
};
