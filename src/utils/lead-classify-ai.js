// lead-classify-ai.js — ongoing lead qualification with Claude (Anthropic API).
//
// The one-time categorization of the 1,525 historical leads ran as a dev-time
// agent workflow. THIS is the production equivalent: as new leads arrive
// (Status='New', no Lead_Category yet), classify each as spam / unqualified /
// qualified via the Messages API, then apply:
//   spam        → Status='Archived', Lead_Category='spam'        (off the board)
//   unqualified → Status='Archived', Lead_Category='unqualified' (off the board)
//   qualified   → Lead_Category='qualified'                      (stays New)
//
// Model: claude-opus-4-8 (Erik's choice; override with LEAD_CLASSIFY_MODEL — a
// cheaper model like claude-haiku-4-5 handles this task well). Needs
// ANTHROPIC_API_KEY (SDK reads it from env). Runs daily on the proxy cron +
// on-demand via the "Rescan with Claude" button. caspio + the SDK are lazy-
// required inside the functions (jest-safety / avoid load when unused).

'use strict';

const LEAD_FORM_IDS = ['jotform-lead', 'quote-request', 'webstore-request', 'team-roster', 'manual-lead'];
const SUBMISSIONS_PATH = '/tables/Form_Submissions/records';
const MODEL = process.env.LEAD_CLASSIFY_MODEL || 'claude-opus-4-8';
const BATCH = 40;
const CATEGORIES = ['spam', 'unqualified', 'qualified'];

const RUBRIC = `You are categorizing inbound sales leads for Northwest Custom Apparel — a custom apparel / embroidery / screen-print / DTF decorator in Milton, WA that decorates apparel and products for companies, teams, schools, churches, and nonprofits.

Classify EACH lead into exactly one category:
- "spam": the sender is SELLING something TO us or is a scam/bot — SEO, web design, marketing, "guest posts", digitizing/manufacturing/wholesale services, AI/software/partnership pitches, "I came across your website", absurd asks (a million shirts), crypto/loans, generic B2B outreach. NOT someone wanting us to decorate apparel for them.
- "unqualified": a REAL individual with a tiny or personal one-off — a single item, one name embroidered, one sticker/patch, one engraving, a hobby order. A real person, just too small or personal to pursue as a business lead.
- "qualified": a genuine company, team, school, church, nonprofit, club, or business wanting decorated apparel/products in a real quantity — a true lead worth following up.

Rules: when unsure between qualified and unqualified, choose "qualified" (never discard a possible real lead). When unsure between spam and unqualified, choose "unqualified" (only mark "spam" when confident it is a solicitation or scam). A named group/org/company wanting apparel is "qualified" even if quantity is unstated.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          reason: { type: 'string' },
        },
        required: ['id', 'category', 'reason'],
      },
    },
  },
  required: ['classifications'],
};

function leadDigest(l) {
  let detail = '';
  try {
    const p = JSON.parse(l.Payload_JSON || '{}');
    detail = (p.fields || []).map((f) => (Array.isArray(f) ? f.join(': ') : '')).filter(Boolean).join(' | ').slice(0, 200);
  } catch (e) { /* ignore */ }
  return {
    id: l.Submission_ID,
    company: String(l.Company || '').slice(0, 80),
    contact: String(l.Contact_Name || '').slice(0, 60),
    email: String(l.Email || '').slice(0, 60),
    summary: String(l.Summary || '').slice(0, 220),
    detail,
  };
}

// One Messages API call over a batch → Map(id -> {category, reason}).
async function classifyBatch(leads) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const digest = leads.map(leadDigest);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: RUBRIC,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: 'Classify every lead in this JSON array. Return one classification per lead, keyed by id.\n\n' + JSON.stringify(digest),
    }],
  });
  if (resp.stop_reason === 'refusal') throw new Error('Anthropic refused the classification request');
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error('Could not parse classification JSON: ' + e.message); }
  const out = new Map();
  for (const c of (parsed.classifications || [])) {
    if (c && c.id && CATEGORIES.indexOf(c.category) !== -1) out.set(c.id, { category: c.category, reason: String(c.reason || '').slice(0, 120) });
  }
  return out;
}

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

/**
 * Classify the New leads that don't have a Lead_Category yet, and apply it.
 * @param {{dryRun?:boolean, limit?:number}} opts
 */
async function runLeadClassification(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  if (!process.env.ANTHROPIC_API_KEY) {
    return { skipped: true, reason: 'ANTHROPIC_API_KEY not set', classified: 0 };
  }
  const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('./caspio');
  const { nowIso } = require('./form-submission-helpers');

  const rows = await fetchAllCaspioPages(SUBMISSIONS_PATH, {
    'q.where': "Form_ID IN ('" + LEAD_FORM_IDS.join("','") + "') AND Status='New'",
    'q.select': 'Submission_ID,Company,Contact_Name,Email,Summary,Payload_JSON,Lead_Category',
    'q.pageSize': 500, 'q.orderBy': 'PK_ID',
  }, { maxPages: 2 });
  // Only the ones not categorized yet (new arrivals).
  let pending = rows.filter((l) => !String(l.Lead_Category || '').trim());
  if (opts.limit) pending = pending.slice(0, opts.limit);
  if (!pending.length) return { classified: 0, spam: 0, unqualified: 0, qualified: 0, archived: 0, pending: 0, model: MODEL };

  const result = { classified: 0, spam: 0, unqualified: 0, qualified: 0, archived: 0, pending: pending.length, model: MODEL, dryRun, items: [] };
  for (const grp of chunk(pending, BATCH)) {
    const verdicts = await classifyBatch(grp);
    for (const l of grp) {
      const v = verdicts.get(l.Submission_ID);
      if (!v) continue;
      result.classified += 1;
      result[v.category] += 1;
      result.items.push({ id: l.Submission_ID, company: l.Company, category: v.category, reason: v.reason });
      if (dryRun) continue;
      const updates = { Lead_Category: v.category, Updated_By: 'lead-classify-ai', Updated_At: nowIso() };
      if (v.category === 'spam' || v.category === 'unqualified') { updates.Status = 'Archived'; result.archived += 1; }
      await putWithRecordsAffected(SUBMISSIONS_PATH, `Submission_ID='${String(l.Submission_ID).replace(/'/g, "''")}'`, updates);
      // Timeline breadcrumb (best-effort)
      makeCaspioRequest('post', '/tables/Lead_Activity/records', {}, {
        Submission_ID: l.Submission_ID, Activity_Type: 'system',
        Activity_Text: `Claude categorized this as ${v.category}${v.reason ? ' (' + v.reason + ')' : ''}.`,
        Attachment_URL: '', Created_By: 'lead-classify-ai', Created_At: nowIso(), Parent_PK: null,
      }).catch(() => {});
    }
  }
  console.log(`[lead-classify] ${dryRun ? '(dry-run) ' : ''}classified ${result.classified} · spam ${result.spam} · unqualified ${result.unqualified} · qualified ${result.qualified} · archived ${result.archived} (${MODEL})`);
  return result;
}

module.exports = { runLeadClassification, classifyBatch, leadDigest, MODEL, CATEGORIES, LEAD_FORM_IDS };
