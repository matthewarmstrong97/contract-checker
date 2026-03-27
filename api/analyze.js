// api/analyze.js
// Three-pass AI analysis of a subcontract.
//
// Pass 1 — Extract clauses into structured JSON
// Pass 2 — Risk-score each clause (financial impact, NZ law, negotiation tips)
// Pass 3 — Write plain-English report in the required section structure
//
// Handles both plain-text contracts and base64-encoded PDFs.
// Records IP in KV after a free review to prevent double-dipping.

const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { content, type, wasFree, tradeType } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'No contract content provided' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[analyze] ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'AI service not configured' });
  }

  const trade = tradeType || 'General subcontractor';

  // ── Guard: prevent free double-use via cookie ────────────────────
  if (wasFree) {
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies['bys_free_used'] === '1') {
      return res.status(402).json({
        error: 'Free review already used for this device. Payment required.',
      });
    }
  }

  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    // ── PASS 1: Extract clauses ────────────────────────────────────
    const pass1Response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: `You are a NZ construction contract analyst specialising in subcontractor agreements.
Extract all significant clauses from the contract provided and return them as a JSON array.
Each item must have exactly these fields:
  { "id": "clause_1", "title": "Short clause title", "text": "Full clause text" }
Return ONLY a valid JSON array. No markdown, no explanation, no code fences.`,
      messages: [
        {
          role: 'user',
          content: buildMessageContent(
            type,
            content,
            'Extract all significant clauses from this contract as a JSON array.'
          ),
        },
      ],
    });

    let clauses = [];
    try {
      const raw = stripCodeFences(pass1Response.content[0].text);
      clauses = JSON.parse(raw);
      if (!Array.isArray(clauses)) throw new Error('Not an array');
    } catch (err) {
      console.error('[analyze] Pass 1 parse error:', err.message);
      return res.status(500).json({
        error: 'Could not extract clauses from the contract. Please check your contract text and try again.',
      });
    }

    if (clauses.length === 0) {
      return res.status(400).json({
        error: 'No clauses found in the contract. Please paste more of the contract text.',
      });
    }

    // ── PASS 2: Risk-score each clause ────────────────────────────
    const pass2Response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 6144,
      system: `You are a NZ construction contract risk analyst specialising in subcontractor protection.
You are reviewing a contract for a ${trade}.

Always prioritise identifying risks that could cost the subcontractor money, delay payment, or increase liability.
Consider risks related to: unfair contract terms, liability exposure, scope ambiguity, payment delays or withholding, retention misuse, and common NZ construction industry practices.

For each clause return a JSON object with these exact fields:
{
  "id": "clause_1",
  "risk_level": "critical" | "high" | "medium" | "low" | "ok",
  "summary": "One sentence describing what this clause does",
  "financial_impact": "Plain English estimate of what this clause could cost the subcontractor (include $ estimates where possible)",
  "negotiation_tip": "Exact wording the tradie can use to push back on this clause in conversation",
  "tradie_impact": "Real-world consequence explained in plain English — what actually happens on site or in practice",
  "legal_context": "Which NZ law is most relevant: CCA 2002 (Construction Contracts Act), Contract and Commercial Law Act 2017, Fair Trading Act 1986, or Building Act 2004. State clearly if none apply."
}

Return ONLY a valid JSON array. No markdown, no explanation, no code fences.`,
      messages: [
        {
          role: 'user',
          content: `Analyse these clauses for risk. Trade type: ${trade}.\n\n${JSON.stringify(clauses, null, 2)}`,
        },
      ],
    });

    let risks = [];
    try {
      const raw = stripCodeFences(pass2Response.content[0].text);
      risks = JSON.parse(raw);
      if (!Array.isArray(risks)) throw new Error('Not an array');
    } catch (err) {
      console.error('[analyze] Pass 2 parse error:', err.message);
      return res.status(500).json({
        error: 'Risk analysis failed. Please try again.',
      });
    }

    // Count risks
    const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    risks.forEach((r) => {
      if (r.risk_level && riskCounts[r.risk_level] !== undefined) {
        riskCounts[r.risk_level]++;
      }
    });

    // ── PASS 3: Write plain-English report ────────────────────────
    const pass3Response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: `You are a plain-English contract adviser for NZ tradespeople. Write a clear, honest risk report for a ${trade}.
Use plain English — no legal jargon. Be direct and specific. If there are no critical issues, say so clearly.

Structure the report EXACTLY as follows, using these exact headings and emoji:

🔴/🟡/🟢 FINAL VERDICT
[Write one of: SAFE TO SIGN / PROCEED WITH CAUTION / DO NOT SIGN] — [one plain-English sentence explaining why]

💸 WHAT THIS COULD COST YOU
[Bullet points of financial risks. Include dollar estimates where possible. If no significant financial risk, say so.]

🚨 CRITICAL ISSUES
[For each critical or high-risk issue, write the issue name, a plain-English explanation, and a 💬 negotiation script with the exact words the tradie can say. If none, write "None identified."]

⚠️ THINGS TO WATCH
[Medium-risk items worth being aware of, but not blocking. If none, write "Nothing significant."]

✅ LOOKS FINE
[Standard or low-risk clauses that are acceptable. Be brief.]

❓ QUESTIONS TO ASK BEFORE SIGNING
[3–5 specific questions the tradie should ask the head contractor before signing]

📋 PLAIN ENGLISH SUMMARY
[2–3 sentences summarising the overall picture and what the tradie should do next]`,
      messages: [
        {
          role: 'user',
          content: `Write the report based on these clause risk assessments. Trade: ${trade}.\n\n${JSON.stringify(risks, null, 2)}`,
        },
      ],
    });

    const report = pass3Response.content[0].text;

    // ── Detect verdict from report text ───────────────────────────
    const verdict = detectVerdict(report);
    const verdictReason = extractVerdictReason(report);

    // ── Record free use via HttpOnly cookie ──────────────────────
    if (wasFree) {
      const oneYear = 60 * 60 * 24 * 365;
      res.setHeader(
        'Set-Cookie',
        `bys_free_used=1; Max-Age=${oneYear}; Path=/; HttpOnly; Secure; SameSite=Strict`
      );
    }

    return res.status(200).json({
      report,
      verdict,
      verdictReason,
      riskCounts,
    });
  } catch (err) {
    console.error('[analyze] Unexpected error:', err.message);
    // Surface Anthropic rate-limit errors helpfully
    if (err.status === 429) {
      return res.status(429).json({ error: 'AI service is busy — please try again in a moment.' });
    }
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
};

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Builds the message content array for Claude.
 * PDFs are sent as base64 document blocks; plain text is appended to the prompt.
 */
function buildMessageContent(type, content, prompt) {
  if (type === 'pdf') {
    return [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: content,
        },
      },
      { type: 'text', text: prompt },
    ];
  }
  // Plain text — append to prompt
  return `${prompt}\n\n---CONTRACT TEXT---\n${content}`;
}

/** Strips markdown code fences from JSON responses. */
function stripCodeFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/** Returns 'danger' | 'caution' | 'safe' based on report text. */
function detectVerdict(report) {
  const upper = report.toUpperCase();
  if (upper.includes('DO NOT SIGN')) return 'danger';
  if (upper.includes('PROCEED WITH CAUTION')) return 'caution';
  return 'safe';
}

/** Extracts the one-line reason from the FINAL VERDICT section. */
function extractVerdictReason(report) {
  // Match the line immediately after FINAL VERDICT heading
  const match = report.match(/FINAL VERDICT\s*\n([^\n]+)/i);
  if (!match) return '';
  // Strip leading emoji and verdict words to leave just the reason
  return match[1]
    .replace(/^[🔴🟡🟢\s]*/u, '')
    .replace(/^(SAFE TO SIGN|PROCEED WITH CAUTION|DO NOT SIGN)\s*[—–-]?\s*/i, '')
    .trim();
}

/** Parses a Cookie header string into a key-value object. */
function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach((part) => {
    const [key, ...val] = part.trim().split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  });
  return cookies;
}
