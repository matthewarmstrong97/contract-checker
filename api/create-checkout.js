// api/create-checkout.js
// Creates a Stripe Checkout session for a single $29 NZD contract review.
// The frontend redirects the user to session.url, then Stripe redirects back
// to ?session_id=... so verify-payment.js can confirm payment before analysis.

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { returnUrl } = req.body;

  if (!returnUrl) {
    return res.status(400).json({ error: 'returnUrl is required' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[create-checkout] STRIPE_SECRET_KEY is not set');
    return res.status(500).json({ error: 'Payment service not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'nzd',
            product_data: {
              name: 'Contract Review — Before You Sign',
              description: 'AI-powered risk analysis for your subcontract',
            },
            unit_amount: 2900, // $29.00 NZD in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}?cancelled=true`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout] Stripe error:', err.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
