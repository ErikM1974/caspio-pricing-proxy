// lead-outreach-templates.js — the AE one-click outreach emails (Leads CRM).
// PURE module (no caspio/emailjs imports — jest-safe): builds {subject,
// bodyHtml, label} for a template key + lead context. The route sends it
// through ONE EmailJS template (`template_lead_outreach`: {{subject}},
// {{{body_html}}}, {{to_email}}, {{reply_to}}, {{from_name}}) so new outreach
// types are a code change here, never a new EmailJS template.
'use strict';

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function firstName(contactName) {
  const t = String(contactName || '').trim();
  return t ? t.split(/\s+/)[0] : 'there';
}

function para(text) {
  return '<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#222;">' + text + '</p>';
}

function signature(aeName) {
  return para(escapeHtml(aeName || 'The NWCA Team') + '<br>Northwest Custom Apparel<br>Family owned &amp; operated since 1977 · Milton, WA');
}

const TEMPLATES = {
  intro: {
    label: 'Introduction',
    build(ctx) {
      const f = escapeHtml(firstName(ctx.contactName));
      const co = ctx.company ? ' for ' + escapeHtml(ctx.company) : '';
      return {
        subject: 'Your custom apparel inquiry — Northwest Custom Apparel',
        bodyHtml:
          para('Hi ' + f + ',') +
          para('Thanks for reaching out about custom apparel' + co + " — I'll be your account executive here at Northwest Custom Apparel.") +
          para("I'm putting together options and pricing for you now. If you can reply with quantities, sizes, or the date you need them by, I can sharpen the numbers right away.") +
          para('Talk soon,') +
          signature(ctx.aeName),
      };
    },
  },
  'quote-followup': {
    label: 'Quote follow-up',
    build(ctx) {
      const f = escapeHtml(firstName(ctx.contactName));
      return {
        subject: 'Your quote from Northwest Custom Apparel',
        bodyHtml:
          para('Hi ' + f + ',') +
          para('Just following up on the quote I sent over — happy to walk through it, adjust quantities, or swap products if something else fits your budget better.') +
          para('If everything looks good, reply here and we’ll get your order moving.') +
          signature(ctx.aeName),
      };
    },
  },
  'checking-in': {
    label: 'Checking in',
    build(ctx) {
      const f = escapeHtml(firstName(ctx.contactName));
      const co = ctx.company ? ' at ' + escapeHtml(ctx.company) : '';
      return {
        subject: 'Still thinking about custom apparel' + (ctx.company ? ' for ' + escapeHtml(ctx.company) : '') + '?',
        bodyHtml:
          para('Hi ' + f + ',') +
          para('Wanted to check back in on the apparel project' + co + '. No pressure — timelines shift! If it’s still on your radar, I’m glad to pick it back up, refresh pricing, or send a few samples.') +
          para('Just hit reply and we’ll take it from there.') +
          signature(ctx.aeName),
      };
    },
  },
  'won-thanks': {
    label: 'Thank you — order confirmed',
    build(ctx) {
      const f = escapeHtml(firstName(ctx.contactName));
      return {
        subject: 'Thank you — your order is in motion!',
        bodyHtml:
          para('Hi ' + f + ',') +
          para('Thank you for choosing Northwest Custom Apparel — your order is officially in motion. I’ll keep you posted at each step, and you’ll hear from me if we need anything (like art approval).') +
          para('Questions any time — just reply to this email.') +
          signature(ctx.aeName),
      };
    },
  },
};

// A "company" that is really just the person again reads awkwardly in prose
// ("custom apparel for Jordan Hibbard — I'll be your…"). Solo submitters get
// their own name (QRQ) or the modal's "Individual — Name" fallback stored in
// Company — treat those as no-company so templates phrase around it.
function meaningfulCompany(company, contactName) {
  const co = String(company || '').trim();
  if (!co) return '';
  if (/^individual\s*[—-]/i.test(co)) return '';
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (contactName && norm(co) === norm(contactName)) return '';
  return co;
}

/**
 * @param {string} key — template key
 * @param {{contactName, company, aeName}} ctx
 * @returns {{label, subject, bodyHtml}|null}
 */
function buildOutreach(key, ctx) {
  const t = TEMPLATES[key];
  if (!t) return null;
  const c = ctx || {};
  const built = t.build({ ...c, company: meaningfulCompany(c.company, c.contactName) });
  return { label: t.label, subject: built.subject, bodyHtml: built.bodyHtml };
}

module.exports = { buildOutreach, TEMPLATE_KEYS: Object.keys(TEMPLATES), TEMPLATES };
