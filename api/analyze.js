// api/analyze.js
// Three-pass contract analysis via Claude API.
// A valid promo code completely bypasses the cookie-based free-check.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_PROMO = 'BYS2026NZ';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { content, type, wasFree, tradeType, promoCode } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'No contract content provided' });
  }

  // ── FREE / PAYMENT GATE ───────────────────────────────────────────────────
  // Valid promo code: skip ALL free-check and cookie logic entirely.
  // No promo: enforce cookie-based free-check as normal.
  const hasValidPromo = typeof promoCode === 'string' && promoCode.trim() === VALID_PROMO;

  if (!hasValidPromo) {
    const cookieHeader = req.headers.cookie || '';
    const alreadyUsedFree = cookieHeader.split(';').some(c => c.trim().startsWith('bys_free_used='));

    if (wasFree && alreadyUsedFree) {
      return res.status(403).json({
        error: 'Free review already used for this device. Payment required.'
      });
    }
  }

  const tradeContext = tradeType ? `The subcontractor is a ${tradeType}.` : 'Trade type not specified.';

  try {
    // ── PASS 1: Extract clauses ───────────────────────────────────────────────
    const pass1Messages = type === 'pdf'
      ? [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: content } },
            { type: 'text', text: `Extract all clauses from this subcontract relating to payment, liability, scope, retention, insurance, termination, or disputes. Return a JSON array only — no other text. Each item: { id: string, title: string, text: string }. ${tradeContext}` },
          ],
        }]
      : [{
          role: 'user',
          content: `Extract all clauses from this subcontract relating to payment, liability, scope, retention, insurance, termination, or disputes. Return a JSON array only — no other text. Each item: { id: string, title: string, text: string }. ${tradeContext}\n\nCONTRACT:\n${content}`,
        }];

    const pass1 = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: pass1Messages,
    });

    let clauses = [];
    try {
      clauses = JSON.parse(pass1.content[0].text.replace(/```json|```/g, '').trim());
    } catch { clauses = []; }

    // ── PASS 2: Risk-score each clause ────────────────────────────────────────
    const pass2 = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a NZ construction contract risk analyst. ${tradeContext}

For each clause, return a JSON array only — no other text. Each item must include:
- id (string — same as input)
- risk_level: "critical" | "high" | "medium" | "low"
- summary: 1–2 sentences using "may/could" language
- financial_impact: estimated dollar impact where possible
- negotiation_tip: exact wording the subcontractor could use
- tradie_impact: real-world consequence on site or cashflow
- legal_context: relevant NZ legislation (CCA 2002, CCLA 2017, Fair Trading Act, Building Act 2004)

Prioritise: payment delays, unlimited liability, scope creep, retention misuse, unfair obligations.

CLAUSES:
${JSON.stringify(clauses, null, 2)}`,
      }],
    });

    let risks = [];
    try {
      risks = JSON.parse(pass2.content[0].text.replace(/```json|```/g, '').trim());
    } catch { risks = []; }

    // Risk counts & verdict
    const riskCounts = risks.reduce((acc, r) => {
      const lvl = r.risk_level || 'low';
      acc[lvl] = (acc[lvl] || 0) + 1;
      return acc;
    }, {});

    let verdict = 'safe';
    if (riskCounts.critical > 0) verdict = 'danger';
    else if (riskCounts.high > 0) verdict = 'caution';

    // ── PASS 3: Plain-English report ──────────────────────────────────────────
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
        content: `Write a plain-English contract risk report for a NZ subcontractor. ${tradeContext}

Use "may", "could", "might" — avoid definitive statements. Never say "do not sign" — say "you may want to avoid signing this as it stands" instead.

Use this exact structure:

${verdictEmoji} FINAL VERDICT
${verdictLabel}
[One sentence explaining the key reason]

💸 WHAT THIS COULD COST YOU
[Bullet points with dollar estimates where possible]

🚨 CRITICAL ISSUES
[Each critical/high clause numbered as Issue N:
**Issue title (Clause reference)**
Plain explanation
💬 Suggested question to raise: "exact wording"]

⚠️ THINGS TO WATCH
[Medium-risk items numbered, with 💬 Suggested question to raise where useful]

✅ LOOKS FINE
[Low-risk items as bullets]

❓ QUESTIONS TO ASK BEFORE SIGNING
[3–5 practical questions]

📋 PLAIN ENGLISH SUMMARY
[2–3 sentence overview]

RISK DATA:
${JSON.stringify(risks, null, 2)}`,
      }],
    });

    const report = pass3.content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');

    // Extract verdictReason from line after FINAL VERDICT heading
    const lines = report.split('\n').filter(l => l.trim());
    const vi = lines.findIndex(l => /FINAL VERDICT/i.test(l));
    const verdictReason = vi >= 0 && lines[vi + 2] ? lines[vi + 2].trim() : '';

    // ── SET FREE-USED COOKIE ──────────────────────────────────────────────────
    // Don't consume the free review if a promo code was used — promo is its own bypass.
    if (wasFree && !hasValidPromo) {
      res.setHeader('Set-Cookie', [
        'bys_free_used=1; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000; Path=/'
      ]);
    }

    return res.status(200).json({ report, verdict, verdictReason, riskCounts, clauses: clauses.length });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: 'Analysis failed — please try again.' });
  }
}
