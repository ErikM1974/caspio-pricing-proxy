// The CASPIO ACCOUNT CLOCK — one definition of "what day is it", shared by the
// call meter, the usage rollup and the pacing math.
//
// Caspio buckets its usage bars and logs on the ACCOUNT's timezone, not UTC.
// Confirmed 2026-07-28 from the Integrations log column header, which reads
// literally "Log date (UTC-07:00)".
//
// Everything here used to key on UTC (`toISOString().slice(0,10)`), so our
// "day" started seven hours before Caspio's. Comparing our daily total against
// the number on Caspio's chart was therefore apples-to-oranges — our window for
// 28 Jul began at 5 PM Pacific on the 27th. That offset was large enough to be
// mistaken for thousands of untracked calls, and sent a day of investigation
// chasing an integration that does not exist. Match their clock and the two
// numbers become directly comparable.
//
// DST: America/Los_Angeles is -07:00 in summer and -08:00 in winter, and Intl
// handles the switch. Caspio displayed -07:00 while on PDT, which is consistent
// with a DST-aware account timezone. If their bars ever drift an hour against
// ours across a DST boundary, that assumption is what to revisit.

const ACCOUNT_TZ = 'America/Los_Angeles';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ACCOUNT_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});

const hourFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ACCOUNT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hour12: false
});

/** 'YYYY-MM-DD' on the account clock. */
function accountDay(date = new Date()) {
  return dayFmt.format(date);           // en-CA already yields YYYY-MM-DD
}

/** 'YYYY-MM-DDTHH' on the account clock — sorts lexicographically. */
function accountHour(date = new Date()) {
  const parts = hourFmt.formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  // hour12:false can render midnight as '24' in some ICU versions; normalise.
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}`;
}

/** Calendar parts on the account clock, for period-boundary arithmetic. */
function accountParts(date = new Date()) {
  const [y, m, d] = accountDay(date).split('-').map(Number);
  return { year: y, month: m - 1, day: d };   // month 0-indexed, like Date
}

module.exports = { ACCOUNT_TZ, accountDay, accountHour, accountParts };
