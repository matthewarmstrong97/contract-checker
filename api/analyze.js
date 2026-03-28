// api/analyze.js
// Three-pass contract analysis. Promo code bypasses cookie free-check.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VALID_PROMO = 'BYS2026NZ';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    content, type, wasFree, tradeType, promoCode,
    // Optional prompt config sent from frontend
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

  const tradeContext = tradeType ? `The subcontractor is a ${tradeType}.` : 'Trade type not specified.';

  // ── CHANGE 5: Conservative risk classification rules ───────────────────
  const riskClassificationRules = pass2RiskRules || `RISK CLASSIFICATION RULES — follow these strictly:

Only classify a clause as CRITICAL if it meets at least one of:
- Payment may be withheld indefinitely or is entirely discretionary
- Liability is unlimited and clearly extends beyond the subcontractor's own work
- Scope requires unlimited or undefined additional work with no variation protection
- A clause directly attempts to remove statutory rights under NZ law

Only classify as HIGH if there is meaningful financial risk beyond normal industry standards.
Do not classify common or negotiable industry clauses as HIGH or CRITICAL. A 7-day termination clause, standard retention, or minor scope ambiguity should be MEDIUM or LOW.
Be conservative. It is better to slightly understate risk than to over-flag reasonable contracts.`;

  // ── CHANGES 7 & 8: No dollar figures, softened legal language ─────────
  const languageRules = pass2LanguageRules || `FINANCIAL IMPACT — do not use specific dollar figures. Use relative language only:
- Instead of dollar amounts use: "could exceed the contract value", "could result in significant financial exposure", "could create cashflow pressure"
- Do not cite specific section numbers (e.g. "ss 18-22", "Part 2 Subpart 2A") — reference acts by name only
- Replace definitive legal conclusions with probabilistic language: "may be inconsistent with" not "breaches", "could conflict with" not "violates", "may not align with" not "is void"
- Avoid catastrophic personal language like "your house and business assets are at risk" — keep grounded in contract impact
- Do not make statistical or general industry claims unless directly supported by the contract`;

  const formattingRules = pass3FormattingRules || `FORMATTING AND LANGUAGE RULES:
- Do not use any markdown formatting in suggested questions — plain text only, no asterisks, no bold markers
- Do not use specific dollar figures anywhere — use relative language only
- Do not cite specific section numbers — reference acts by name only
- Use probabilistic language throughout: "may", "could", "might" rather than "will", "is", "won't"
- Avoid catastrophic or alarmist personal language — keep grounded in contract impact
- Do not make statistical or industry claims unless directly supported by the contract text`;

  try {
    // ── PASS 1: Extract clauses ────────────────────────────────────────────
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

    const pass1 = await client.messages.create({ model: 'claude-opus-4-5', max_tokens: 4000, messages: pass1Messages });
    let clauses = [];
    try { clauses = JSON.parse(pass1.content[0].text.replace(/```json|```/g, '').trim()); } catch { clauses = []; }

    // ── PASS 2: Risk-score each clause ────────────────────────────────────
    const pass2 = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a NZ construction contract risk analyst. ${tradeContext}

${riskClassificationRules}

${languageRules}

For each clause below, return a JSON array only — no other text. Each item must include:
- id (string — same as input)
- risk_level: "critical" | "high" | "medium" | "low"
- summary: 1–2 sentences using "may/could" language — no definitive statements
- financial_impact: relative language only — no specific dollar figures
- negotiation_tip: plain text only — no asterisks or markdown formatting
- tradie_impact: real-world consequence on site or cashflow in plain language
- legal_context: relevant NZ legislation by act name only — no section numbers

CLAUSES:
${JSON.stringify(clauses, null, 2)}`,
      }],
    });

    let risks = [];
    try { risks = JSON.parse(pass2.content[0].text.replace(/```json|```/g, '').trim()); } catch { risks = []; }

    const riskCounts = risks.reduce((acc, r) => { const l = r.risk_level || 'low'; acc[l] = (acc[l] || 0) + 1; return acc; }, {});

    // ── CHANGE 6: Verdict logic ────────────────────────────────────────────
    // HIGH RISK: any critical | MEDIUM RISK: high but no critical | LOW RISK: medium/low only | CLEAR: nothing
    let verdict = 'safe';
    if (riskCounts.critical > 0) verdict = 'danger';
    else if (riskCounts.high > 0) verdict = 'caution';

    // ── PASS 3: Plain-English report ──────────────────────────────────────
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

${formattingRules}

Use "may", "could", "might" throughout — never say "do not sign", say "you may want to avoid signing this as it stands" instead.
Never use specific dollar figures — use relative language only.
Never cite section numbers — reference acts by name only.

Structure the report exactly as follows:

${verdictEmoji} FINAL VERDICT
${verdictLabel}
[One plain sentence explaining the key reason — no dollar figures, no section numbers]

💸 WHAT THIS COULD COST YOU
[Bullet points using relative language only — no dollar amounts]

🚨 CRITICAL ISSUES
[Each critical/high clause numbered as Issue N:
**Issue title (Clause reference if available)**
Plain explanation using "may/could" language
💬 Suggested question to raise: exact plain text question — no asterisks or markdown]

⚠️ THINGS TO WATCH
[Medium-risk items numbered, with 💬 Suggested question to raise where useful — plain text only]

✅ LOOKS FINE
[Low-risk items as plain bullet points]

❓ QUESTIONS TO ASK BEFORE SIGNING
[3–5 practical questions in plain text]

📋 PLAIN ENGLISH SUMMARY
[2–3 sentence overview using probabilistic language]

RISK DATA:
${JSON.stringify(risks, null, 2)}`,
      }],
    });

    const report = pass3.content.map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');

    const lines = report.split('\n').filter(l => l.trim());
    const vi = lines.findIndex(l => /FINAL VERDICT/i.test(l));
    const verdictReason = vi >= 0 && lines[vi + 2] ? lines[vi + 2].trim() : '';

    // Only consume free cookie if not using promo
    if (wasFree && !hasValidPromo) {
      res.setHeader('Set-Cookie', ['bys_free_used=1; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000; Path=/']);
    }

    return res.status(200).json({ report, verdict, verdictReason, riskCounts, clauses: clauses.length });

  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({ error: 'Analysis failed — please try again.' });
  }
}
