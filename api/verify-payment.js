// api/verify-payment.js
// Confirms that a Stripe Checkout session has been paid.
// Called immediately after the user returns from Stripe with ?session_id=...
// Returns { paid: boolean } — frontend proceeds to analysis only if true.

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[verify-payment] STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ error: 'Payment service not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === 'paid';
    return res.status(200).json({ paid });
  } catch (err) {
    console.error('[verify-payment] Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
};
