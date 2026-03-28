// api/analyze.js
// Three-pass contract analysis.
// If Claude analysis fails after a successful Stripe payment, auto-refund and log.

import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const VALID_PROMO = 'BYS2026NZ';

// ── LOGGING ────────────────────────────────────────────────────────────────
// Structured logs appear in Vercel's log dashboard (Project → Logs).
function logFailure(event, data) {
  console.error(`[BYS:${event}]`, JSON.stringify({ ...data, timestamp: new Date().toISOString() }));
}

// ── REFUND HELPER ──────────────────────────────────────────────────────────
async function issueRefund(sessionId, reason) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session.payment_intent) {
    logFailure('REFUND_SKIPPED', { sessionId, reason: 'no payment_intent on session' });
    return null;
  }
  const refund = await stripe.refunds.create({
    payment_intent: session.payment_intent,
    reason: 'fraudulent', // closest Stripe enum — means "not as described / error"
  });
  logFailure('REFUND_ISSUED', {
    sessionId,
    paymentIntent: session.payment_intent,
    refundId: refund.id,
    amountRefunded: refund.amount,
    currency: refund.currency,
    failureReason: reason,
  });
  return refund;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    content, type, wasFree, tradeType, promoCode, sessionId,
    pass2RiskRules, pass2LanguageRules, pass3FormattingRules,
  } = req.body;

  if (!content) return res.status(400).json({ error: 'No contract content provided' });

  // ── FREE / PAYMENT GATE ────────────────────────────────────────────────
  const hasValidPromo = typeof promoCode === 'string' && promoCode.trim() === VALID_PROMO;

  if (!hasValidPromo) {
    const cookieHeader = req.headers.cookie || '';
    const alreadyUsedFree = cookieHeader.split(';').some(c => c.trim().startsWith('bys_free_used='));
    if (wasFree && alreadyUsedFree) {
      return res.status(403).json({ error: 'Free review already used for this device. Payment required.' });
    }
  }

  // Track whether this is a real paid review (for refund logic)
  const isPaidReview = !wasFree && !hasValidPromo && !!sessionId;

  const tradeContext = tradeType ? `The subcontractor is a ${tradeType}.` : 'Trade type not specified.';

  // ── PROMPT CONFIG ──────────────────────────────────────────────────────
  const riskClassificationRules = pass2RiskRules || `RISK CLASSIFICATION RULES — follow strictly:

Only classify CRITICAL if:
- Payment may be withheld indefinitely or is entirely discretionary
- Liability is unlimited and clearly extends beyond the subcontractor's own work
- Scope requires unlimited/undefined additional work with no variation protection
- A clause directly attempts to remove statutory rights under NZ law

Only classify HIGH for meaningful financial risk beyond normal industry standards.
A 7-day termination clause, standard retention, or minor scope ambiguity = MEDIUM or LOW.
Be conservative — understate risk rather than over-flag reasonable contracts.`;

  const languageRules = pass2LanguageRules || `LANGUAGE RULES:
- No specific dollar figures — use relative language: "could exceed the contract value", "could create cashflow pressure"
- No section numbers (e.g. "ss 18-22") — reference acts by name only
- Probabilistic language: "may be inconsistent with" not "breaches", "could conflict with" not "violates"
- No catastrophic personal language — keep grounded in contract impact
- No statistical claims unless directly supported by the contract`;

  const formattingRules = pass3FormattingRules || `FORMATTING:
- No markdown in suggested questions — plain text only, no asterisks
- No dollar figures — relative language only
- No section numbers — act names only
- Use "may/could/might" throughout, never "will/is/won't"
- No alarmist personal language`;

  try {
    // ── PASS 1: Extract clauses ──────────────────────────────────────────
    const pass1Messages = type === 'pdf'
      ? [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: content } },
            { type: 'text', text: `Extract all clauses relating to payment, liability, scope, retention, insurance, termination, or disputes. Return JSON array only. Each item: { id: string, title: string, text: string }. ${tradeContext}` },
          ],
        }]
      : [{
          role: 'user',
          content: `Extract all clauses relating to payment, liability, scope, retention, insurance, termination, or disputes. Return JSON array only — no other text. Each item: { id: string, title: string, text: string }. ${tradeContext}\n\nCONTRACT:\n${content}`,
        }];

    const pass1 = await client.messages.create({ model: 'claude-opus-4-5', max_tokens: 4000, messages: pass1Messages });
    let clauses = [];
    try { clauses = JSON.parse(pass1.content[0].text.replace(/```json|```/g, '').trim()); } catch { clauses = []; }

    // ── PASS 2: Risk-score each clause ───────────────────────────────────
    const pass2 = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `NZ construction contract risk analyst. ${tradeContext}

${riskClassificationRules}

${languageRules}

Return JSON array only. Each item:
- id (string)
- risk_level: "critical"|"high"|"medium"|"low"
- summary: 1–2 sentences, "may/could" language
- financial_impact: relative language, no dollar figures
- negotiation_tip: plain text, no asterisks/markdown
- tradie_impact: plain-English site/cashflow consequence
- legal_context: act names only, no section numbers

CLAUSES:
${JSON.stringify(clauses, null, 2)}`,
      }],
    });

    let risks = [];
    try { risks = JSON.parse(pass2.content[0].text.replace(/```json|```/g, '').trim()); } catch { risks = []; }

    const riskCounts = risks.reduce((acc, r) => { const l = r.risk_level || 'low'; acc[l] = (acc[l] || 0) + 1; return acc; }, {});

    let verdict = 'safe';
    if (riskCounts.critical > 0) verdict = 'danger';
    else if (riskCounts.high > 0) verdict = 'caution';

    // ── PASS 3: Plain-English report ─────────────────────────────────────
    const verdictEmoji = verdict === 'danger' ? '🔴' : verdict === 'caution' ? '🟡' : '🟢';
    const verdictLabel = verdict === 'danger'
      ? 'HIGH RISK — you may want to avoid signing this as it stands'
      : verdict === 'caution'
      ? 'MEDIUM RISK — raise these issues before signing'
      : 'LOW RISK — this contract appears reasonable to proceed with';

    const pass3 = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Plain-English contract risk report for a NZ subcontractor. ${tradeContext}

${formattingRules}

Never say "do not sign" — say "you may want to avoid signing this as it stands".
No dollar figures. No section numbers. Use "may/could/might" throughout.

Structure:

${verdictEmoji} FINAL VERDICT
${verdictLabel}
[One plain sentence — no dollar figures, no section numbers]

💸 WHAT THIS COULD COST YOU
[Bullet points — relative language only]

🚨 CRITICAL ISSUES
[Each critical/high clause:
**Issue title (Clause reference)**
Plain "may/could" explanation
💬 Suggested question to raise: plain text question — no asterisks]

⚠️ THINGS TO WATCH
[Medium-risk items, numbered, with 💬 Suggested question where useful]

✅ LOOKS FINE
[Low-risk items as bullets]

❓ QUESTIONS TO ASK BEFORE SIGNING
[3–5 plain questions]

📋 PLAIN ENGLISH SUMMARY
[2–3 sentence overview]

RISK DATA:
${JSON.stringify(risks, null, 2)}`,
      }],
    });

    const report = pass3.content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');

    const lines = report.split('\n').filter(l => l.trim());
    const vi = lines.findIndex(l => /FINAL VERDICT/i.test(l));
    const verdictReason = vi >= 0 && lines[vi + 2] ? lines[vi + 2].trim() : '';

    // Mark free review as used (skip if promo)
    if (wasFree && !hasValidPromo) {
      res.setHeader('Set-Cookie', ['bys_free_used=1; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000; Path=/']);
    }

    return res.status(200).json({ report, verdict, verdictReason, riskCounts, clauses: clauses.length });

  } catch (err) {
    // ── ANALYSIS FAILED ────────────────────────────────────────────────────
    // If this was a real paid review, auto-refund and log everything.
    if (isPaidReview) {
      logFailure('ANALYSIS_FAILED_PAID', {
        sessionId,
        tradeType,
        contentLength: typeof content === 'string' ? content.length : 'pdf',
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 5).join(' | '),
      });

      try {
        await issueRefund(sessionId, err.message);
        return res.status(500).json({ error: 'ANALYSIS_FAILED_REFUNDED' });
      } catch (refundErr) {
        // Refund itself failed — log both errors so you can manually refund
        logFailure('REFUND_FAILED', {
          sessionId,
          analysisError: err.message,
          refundError: refundErr.message,
          action: 'MANUAL_REFUND_REQUIRED',
        });
        // Still return the refunded error to the user — you'll fix it manually from the log
        return res.status(500).json({ error: 'ANALYSIS_FAILED_REFUNDED' });
      }
    }

    // Free or promo review — just log and return generic error
    logFailure('ANALYSIS_FAILED_FREE', {
      tradeType,
      error: err.message,
    });
    return res.status(500).json({ error: 'Analysis failed — please try again.' });
  }
}
