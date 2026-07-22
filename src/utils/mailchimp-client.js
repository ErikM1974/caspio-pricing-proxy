// mailchimp-client.js — thin Mailchimp Marketing API v3 client for Jim's prospect
// sync. Reads MAILCHIMP_API_KEY (HTTP Basic auth; the key's "-usX" suffix is the
// data center). NEVER logs the key. Used only by src/routes/jim-mailing-list.js.
'use strict';
const axios = require('axios');

function cfg() {
  const key = process.env.MAILCHIMP_API_KEY || '';
  if (!key) throw new Error('MAILCHIMP_API_KEY not configured');
  const dc = key.split('-')[1];
  if (!dc) throw new Error('MAILCHIMP_API_KEY is malformed (missing data-center suffix)');
  return { key, dc, base: 'https://' + dc + '.api.mailchimp.com/3.0' };
}
function client() {
  const c = cfg();
  return axios.create({
    baseURL: c.base,
    auth: { username: 'nwca', password: c.key }, // Mailchimp Basic auth: any user + key
    timeout: 25000,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function ping() {
  const r = await client().get('/ping');
  return r.data; // { health_status: "Everything's Chimpy!" }
}

// Resolve the audience by NAME (so we never hardcode a List ID). 5-min cache.
let _cache = null;
async function findAudience(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (_cache && _cache.wanted === wanted && Date.now() - _cache.at < 300000) return _cache;
  const r = await client().get('/lists', { params: { count: 100, fields: 'lists.id,lists.name,lists.stats.member_count' } });
  const lists = (r.data && r.data.lists) || [];
  const match = wanted ? lists.find(function (l) { return String(l.name).trim().toLowerCase() === wanted; }) : lists[0];
  if (!match) {
    const e = new Error('Audience "' + name + '" was not found in Mailchimp');
    e.audiences = lists.map(function (l) { return l.name; });
    throw e;
  }
  _cache = { wanted: wanted, id: match.id, displayName: match.name, members: (match.stats && match.stats.member_count) || 0, at: Date.now() };
  return _cache;
}

// Text merge fields for the prospect data (FNAME/LNAME exist by default). Tags ≤10 chars.
const REQUIRED_MERGE = [
  { tag: 'COMPANY', name: 'Company' },
  { tag: 'ADDRESS', name: 'Street Address' },
  { tag: 'CITY', name: 'City' },
  { tag: 'STATE', name: 'State' },
  { tag: 'ZIP', name: 'ZIP' },
  { tag: 'PHONE', name: 'Phone' },
];
async function ensureMergeFields(listId) {
  const cl = client();
  const r = await cl.get('/lists/' + listId + '/merge-fields', { params: { count: 100, fields: 'merge_fields.tag' } });
  const have = new Set(((r.data && r.data.merge_fields) || []).map(function (m) { return m.tag; }));
  for (const mf of REQUIRED_MERGE) {
    if (have.has(mf.tag)) continue;
    try { await cl.post('/lists/' + listId + '/merge-fields', { tag: mf.tag, name: mf.name, type: 'text', required: false, public: false }); }
    catch (e) { /* already exists / non-fatal — sync still works with FNAME/LNAME */ }
  }
}

// Batch add/update up to 500 members per call. Members staged as 'transactional'
// (NOT marketing-subscribed) so nobody is emailed until Erik subscribes them.
// members: [{email, first, last, company, address, city, state, zip, phone, tag}]
async function upsertMembers(listId, members) {
  const cl = client();
  let created = 0, updated = 0, errors = 0;
  const errorSamples = [];
  for (let i = 0; i < members.length; i += 500) {
    const chunk = members.slice(i, i + 500).map(function (m) {
      return {
        email_address: m.email,
        status: 'transactional',
        merge_fields: {
          FNAME: m.first || '', LNAME: m.last || '', COMPANY: m.company || '',
          ADDRESS: m.address || '', CITY: m.city || '', STATE: m.state || '', ZIP: m.zip || '', PHONE: m.phone || '',
        },
        tags: m.tag ? [m.tag] : [],
      };
    });
    try {
      const r = await cl.post('/lists/' + listId, { members: chunk, update_existing: true });
      created += ((r.data && r.data.new_members) || []).length;
      updated += ((r.data && r.data.updated_members) || []).length;
      const errs = (r.data && r.data.errors) || [];
      errors += errs.length;
      errs.slice(0, 3).forEach(function (e) { errorSamples.push((e.email_address || '') + ': ' + (e.error || '')); });
    } catch (e) {
      errors += chunk.length;
      errorSamples.push(e.response ? JSON.stringify(e.response.data).slice(0, 140) : e.message);
    }
  }
  return { created: created, updated: updated, errors: errors, errorSamples: errorSamples.slice(0, 5) };
}

// Recent SENT campaigns to a list (newest first).
async function recentSentCampaigns(listId, count) {
  const r = await client().get('/campaigns', {
    params: { list_id: listId, status: 'sent', count: count || 50, sort_field: 'send_time', sort_dir: 'DESC', fields: 'campaigns.id,campaigns.send_time,campaigns.settings.subject_line' },
  });
  return (r.data && r.data.campaigns) || [];
}
// Lowercased recipient emails a campaign was sent to (paginated).
async function campaignSentTo(campaignId) {
  const cl = client();
  const out = [];
  let offset = 0;
  for (;;) {
    const r = await cl.get('/reports/' + campaignId + '/sent-to', { params: { count: 1000, offset: offset, fields: 'sent_to.email_address,total_items' } });
    const items = (r.data && r.data.sent_to) || [];
    items.forEach(function (x) { out.push(String(x.email_address || '').toLowerCase()); });
    offset += items.length;
    if (!items.length || offset >= (r.data.total_items || 0) || offset > 200000) break;
  }
  return out;
}

// Engagement map across ALL audiences: email (lowercased) → { opened, rating }.
// "opened" = the member has a non-zero average open rate (they've opened ≥1 email
// ever). Cached 10 min — the first build pulls every audience's members once.
let _engCache = null;
async function engagementMap() {
  if (_engCache && Date.now() - _engCache.at < 600000) return _engCache.map;
  const cl = client();
  const listsResp = await cl.get('/lists', { params: { count: 100, fields: 'lists.id' } });
  const lists = (listsResp.data && listsResp.data.lists) || [];
  const map = Object.create(null);
  for (const l of lists) {
    let offset = 0;
    for (let page = 0; page < 60; page++) { // cap ~60k members/list
      const r = await cl.get('/lists/' + l.id + '/members', {
        params: { count: 1000, offset: offset, fields: 'members.email_address,members.member_rating,members.stats,total_items' },
      });
      const members = (r.data && r.data.members) || [];
      members.forEach((m) => {
        const em = String(m.email_address || '').toLowerCase();
        if (!em) return;
        const opened = !!(m.stats && m.stats.avg_open_rate > 0);
        const rating = m.member_rating || 0;
        const prev = map[em];
        if (prev) { prev.opened = prev.opened || opened; prev.rating = Math.max(prev.rating, rating); }
        else map[em] = { opened: opened, rating: rating };
      });
      offset += members.length;
      if (!members.length || offset >= (r.data.total_items || 0)) break;
    }
  }
  _engCache = { at: Date.now(), map: map };
  return map;
}

module.exports = { cfg, ping, findAudience, ensureMergeFields, upsertMembers, recentSentCampaigns, campaignSentTo, engagementMap };
