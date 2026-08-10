// payroll.js — the admin-only payroll surface. Erik, 2026-07-27.
//
// 🔒 THE RULE THIS FILE EXISTS TO ENFORCE: no pay rate, salary, or per-employee dollar
// amount is EVER sent to the browser. Erik 2026-07-27: "you dont need to show pay rates on
// the app". The register still stores money (it's the system of record and the
// reconciliation gate needs it) — the read endpoints just never select or return it.
// SAFE_* below are allowlists, not filters: adding a field to the table does not leak it.
//
// Mounted requireCrmApiSecret-gated in server.js; the app reaches it only through
// createCrmProxy('payroll', ['admin']) — so a call needs the secret AND an admin session.
// Page access is additionally gated by the Staff_Page_Access row payroll.html -> admin.
//
// Upload flow (3 steps, because a scanned packet can't be parsed inside one request):
//   POST /parse        → accepts the packet PDF, starts a background job, returns {jobId}
//   GET  /parse/:jobId → poll; when done returns HOURS + LEAVE + a reconciliation verdict
//   POST /import       → commits the job's SERVER-SIDE payload (never the browser's copy)
//
// TWO upload modes, chosen by the caller — never guessed (Erik 2026-08-10):
//   mode 'packet' — the full monthly packet (Payroll Register + Check Register + the
//                   vacation/sick page). Writes Payroll_Register rows AND refreshes leave.
//   mode 'leave'  — the "Available Vacation And Sick Time" page ON ITS OWN. Refreshes the
//                   leave columns on Employees and writes NO register row, because a page
//                   with no Register prints no hours, wages or check date to put in one.
// 🔴 WHY THE MODE IS EXPLICIT: reconcile() gates on the packet's printed money totals, and
// a leave-only page prints none of them. Fed through the packet path it extracted 0 for
// gross/net/deductions/check-count, compared 0 to 0, and PASSED — a green gate that had
// verified nothing, one click away from writing 21 all-zero rows and a phantom pay period.
// A sum-based gate cannot detect a document that simply has no sums in it.
// Heroku demands a first byte within 30s and vision extraction of a scan takes longer, so
// the parse cannot block. Keeping the parsed payload server-side also means the browser
// can't tamper with payroll figures between review and commit.
'use strict';
const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const config = require('../config');
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const REGISTER = 'Payroll_Register';
const EMPLOYEES = 'Employees';
const MODEL_ID = 'claude-opus-5';

// Allowlists — the ONLY columns that may reach the browser.
const SAFE_EMPLOYEE_FIELDS = [
  'Payroll_Employee_ID', 'Employee_Full_Name', 'First_Name', 'Last_Name', 'Job_Title',
  'Department', 'Status', 'Date_Hired', 'Vacation_Eligible_Date', 'Vacation_Eligible_Hours',
  'Vacation_Hours_Available', 'Vacation_Hours_Used', 'Vacation_Hours_Remaining',
  'Sick_Accum_Hours_Available', 'Sick_Hours_Used', 'Sick_Hours_Remaining',
  'Leave_Balances_As_Of',
  // 🔴 HAND-MAINTAINED BY ERIK, NEVER WRITTEN BY THE IMPORT. The payroll packet inflates
  // both vacation accrued and used by any prior-year carryover (hours taken in December,
  // paid on a January check), so the slip needs the real annual grant to subtract it back
  // out. It lives in its OWN column precisely because the import overwrites all three
  // Vacation_Hours_* columns every Friday — parking it in one of those would destroy it.
  // See dashboards/js/vacation-carryover.js in the app repo.
  'Vacation_Annual_Entitlement',
].join(',');

const SAFE_REGISTER_FIELDS = [
  'Payroll_Employee_ID', 'Employee_Full_Name', 'Check_Date', 'Period_Start', 'Period_End',
  'Paid_This_Period', 'Hours_Regular', 'Hours_Overtime', 'Hours_Sick', 'Hours_Vacation_PTO',
  'Hours_Holiday', 'Hours_Total', 'Vacation_Accrued', 'Vacation_Used', 'Vacation_Available',
  'Sick_Accrued', 'Sick_Used', 'Sick_Available',
].join(',');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s).replace(/'/g, "''");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------------------------------------------------------------- reads

// GET /api/payroll/employees — active roster + leave balances. No pay, ever.
router.get('/employees', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(`/tables/${EMPLOYEES}/records`, {
      'q.select': SAFE_EMPLOYEE_FIELDS, 'q.where': 'Status=1', 'q.pageSize': 500, 'q.orderBy': 'PK_ID',
    });
    res.json({ employees: rows || [] });
  } catch (e) {
    console.error('[payroll] employees read failed:', e.message);
    res.status(502).json({ error: 'employee lookup failed' });
  }
});

// GET /api/payroll/periods — distinct pay dates already imported, newest first.
router.get('/periods', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(`/tables/${REGISTER}/records`, {
      'q.select': 'Check_Date,Period_Start,Period_End,Payroll_Employee_ID,Paid_This_Period',
      'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
    });
    const byDate = new Map();
    for (const r of rows || []) {
      const d = String(r.Check_Date || '').slice(0, 10);
      if (!d) continue;
      if (!byDate.has(d)) {
        byDate.set(d, {
          checkDate: d,
          periodStart: String(r.Period_Start || '').slice(0, 10),
          periodEnd: String(r.Period_End || '').slice(0, 10),
          employeeCount: 0, paidCount: 0,
        });
      }
      const p = byDate.get(d);
      p.employeeCount++;
      if (r.Paid_This_Period) p.paidCount++;
    }
    res.json({ periods: [...byDate.values()].sort((a, b) => b.checkDate.localeCompare(a.checkDate)) });
  } catch (e) {
    console.error('[payroll] periods read failed:', e.message);
    res.status(502).json({ error: 'period lookup failed' });
  }
});

// GET /api/payroll/register?checkDate=YYYY-MM-DD — hours + leave for one pay date. No money.
router.get('/register', async (req, res) => {
  const checkDate = String(req.query.checkDate || '').trim();
  if (!isDate(checkDate)) return res.status(400).json({ error: 'checkDate must be YYYY-MM-DD' });
  try {
    const rows = await fetchAllCaspioPages(`/tables/${REGISTER}/records`, {
      'q.select': SAFE_REGISTER_FIELDS,
      'q.where': `Check_Date='${esc(checkDate)}'`,
      'q.pageSize': 500, 'q.orderBy': 'PK_ID',
    });
    res.json({ checkDate, rows: rows || [] });
  } catch (e) {
    console.error('[payroll] register read failed:', e.message);
    res.status(502).json({ error: 'register lookup failed' });
  }
});

// ---------------------------------------------------------------- packet parsing

// Extraction schema. Structured outputs reject numeric/length constraints, so bounds are
// checked in reconcile() instead. Money is extracted because the reconciliation gate is
// built on the packet's dollar totals — it just never leaves the server.
const PACKET_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['checkDate', 'periodStart', 'periodEnd', 'checkNumber', 'employees', 'printedTotals'],
  properties: {
    checkDate: { type: 'string', description: 'Check date, YYYY-MM-DD' },
    periodStart: { type: 'string', description: 'Pay period start, YYYY-MM-DD' },
    periodEnd: { type: 'string', description: 'Pay period end, YYYY-MM-DD' },
    checkNumber: { type: 'string' },
    employees: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: [
          'payrollEmployeeId', 'nameOnPacket', 'paid', 'payRate',
          'hoursRegular', 'hoursOvertime', 'hoursSick', 'hoursVacationPTO', 'hoursHoliday',
          'wagesRegular', 'wagesOvertime', 'wagesSick', 'wagesVacationPTO', 'wagesHoliday',
          'wagesCommissions', 'grossWages',
          'dedFederalWH', 'dedSocialSecurity', 'dedMedicare', 'dedStateOther',
          'dedWAFamMedLeave', 'dedWACaresFund', 'totalDeductions', 'netPay',
          'vacationAccrued', 'vacationUsed', 'vacationAvailable',
          'sickAccrued', 'sickUsed', 'sickAvailable',
        ],
        properties: {
          payrollEmployeeId: { type: 'integer', description: 'Emp. ID from the packet, e.g. 6366' },
          nameOnPacket: { type: 'string', description: 'Name exactly as printed, e.g. "BEARDSLEY BRIAN"' },
          paid: { type: 'boolean', description: 'true if this employee received a check this period' },
          payRate: { type: 'number', description: 'Hourly Rate column; 0 for salaried staff with no printed rate' },
          hoursRegular: { type: 'number' }, hoursOvertime: { type: 'number' },
          hoursSick: { type: 'number' }, hoursVacationPTO: { type: 'number' },
          hoursHoliday: { type: 'number' },
          wagesRegular: { type: 'number' }, wagesOvertime: { type: 'number' },
          wagesSick: { type: 'number' }, wagesVacationPTO: { type: 'number' },
          wagesHoliday: { type: 'number' }, wagesCommissions: { type: 'number' },
          grossWages: { type: 'number', description: 'Total Wages for this employee' },
          dedFederalWH: { type: 'number' }, dedSocialSecurity: { type: 'number' },
          dedMedicare: { type: 'number' }, dedStateOther: { type: 'number' },
          dedWAFamMedLeave: { type: 'number' }, dedWACaresFund: { type: 'number' },
          totalDeductions: { type: 'number' }, netPay: { type: 'number' },
          vacationAccrued: { type: 'number', description: 'Vacation Accum. Hrs as DECIMAL hours (107:24 -> 107.4)' },
          vacationUsed: { type: 'number' },
          vacationAvailable: { type: 'number', description: 'Vacation Hrs Avail.; NEGATIVE values are real, keep the sign' },
          sickAccrued: { type: 'number' }, sickUsed: { type: 'number' },
          sickAvailable: { type: 'number', description: 'Sick Hrs Avail.; negatives are real' },
        },
      },
    },
    printedTotals: {
      type: 'object', additionalProperties: false,
      required: ['grossWages', 'netPayroll', 'checkCount', 'totalDeductions',
        'vacationAccrued', 'vacationUsed', 'vacationAvailable'],
      properties: {
        grossWages: { type: 'number', description: 'The packet\'s own printed Total wages' },
        netPayroll: { type: 'number', description: 'The packet\'s own printed Net Payroll' },
        checkCount: { type: 'integer', description: 'Total Check(s) as printed' },
        totalDeductions: { type: 'number' },
        vacationAccrued: { type: 'number', description: 'Vacation report Total row, Accum. column, decimal hours' },
        vacationUsed: { type: 'number' },
        vacationAvailable: { type: 'number' },
      },
    },
  },
};

const EXTRACT_PROMPT = `You are reading a payroll packet from NW Regional Accounting Services for Northwest Embroidery Inc.

It contains up to three reports:
1. "Payroll Register Report" — one block per employee: Type Pay rows (Regular Pay, Overtime, Sick Pay, Vacation\\PTO Pay, Commissions, Holiday) with Rate / Hours / Wages, then Type Deduction rows, then Total Wages and Total Deductions.
2. "Payroll Check(s) Register" — Date, Emp. ID, Employee Name, Check #, Amount.
3. "Available Vacation And Sick Time" — per employee: Hrs/1 Day, then Accum. Hrs / Hrs Used / Hrs Avail. for Vacation, then the same three for Sick.

Extract EVERY employee that appears in ANY of these reports.

Critical rules:
- Leave hours print as HH:MM. Convert to DECIMAL hours: 107:24 -> 107.4, 00:49 -> 0.8167. Round to 4 decimals.
- NEGATIVE leave values are real (e.g. -33:52 -> -33.8667). Preserve the sign. Never clamp to zero.
- An employee on the vacation report with no check has paid=false and 0 for every hours/wages/deduction field. Their leave figures still matter.
- Salaried staff show wages with no Rate. Set payRate to 0 for them — do not compute one.
- A deduction line absent for an employee is 0, not omitted.
- printedTotals must be the figures the packet ITSELF prints (the "Total All Employee(s)" line, the Net Payroll line, and the vacation report's Total row) — do NOT sum the rows yourself. These are used to verify the extraction, so copying them from your own arithmetic defeats the check.
- The pages are scans. If a digit is genuinely unreadable, still return your best reading — a downstream reconciliation will catch errors.

Return the data in the required schema. Dates as YYYY-MM-DD.`;

// ---- leave-only mode: the "Available Vacation And Sick Time" page on its own ----
// No money anywhere in this schema. There is none on the page, and inventing a zero is
// exactly what let the packet gate pass on nothing.
const LEAVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['asOfDate', 'employees', 'printedTotals'],
  properties: {
    asOfDate: { type: 'string', description: 'The "As of Date:" printed under the title, YYYY-MM-DD' },
    employees: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['payrollEmployeeId', 'nameOnPacket', 'hoursPerDay',
          'vacationAccrued', 'vacationUsed', 'vacationAvailable',
          'sickAccrued', 'sickUsed', 'sickAvailable'],
        properties: {
          payrollEmployeeId: { type: 'integer', description: 'The ID column, e.g. 6366' },
          nameOnPacket: { type: 'string', description: 'Name exactly as printed, e.g. "BEARDSLEY BRIAN"' },
          hoursPerDay: { type: 'number', description: 'The "Hrs/1 Day" column, usually 8' },
          vacationAccrued: { type: 'number', description: 'Vacation Accum. Hrs as DECIMAL hours (107:24 -> 107.4)' },
          vacationUsed: { type: 'number', description: 'Vacation Hrs Used' },
          vacationAvailable: { type: 'number', description: 'Vacation Hrs Avail. EXACTLY AS PRINTED; negatives are real' },
          sickAccrued: { type: 'number', description: 'Sick Accum. Hrs' },
          sickUsed: { type: 'number', description: 'Sick Hrs Used' },
          sickAvailable: { type: 'number', description: 'Sick Hrs Avail. EXACTLY AS PRINTED; negatives are real' },
        },
      },
    },
    printedTotals: {
      type: 'object', additionalProperties: false,
      required: ['vacationAccrued', 'vacationUsed', 'vacationAvailable',
        'sickAccrued', 'sickUsed', 'sickAvailable'],
      properties: {
        vacationAccrued: { type: 'number', description: 'The Total: row, Vacation Accum. column' },
        vacationUsed: { type: 'number', description: 'The Total: row, Vacation Hrs Used column' },
        vacationAvailable: { type: 'number', description: 'The Total: row, Vacation Hrs Avail. column' },
        sickAccrued: { type: 'number', description: 'The Total: row, Sick Accum. column' },
        sickUsed: { type: 'number', description: 'The Total: row, Sick Hrs Used column' },
        sickAvailable: { type: 'number', description: 'The Total: row, Sick Hrs Avail. column' },
      },
    },
  },
};

const LEAVE_PROMPT = `You are reading a single report from NW Regional Accounting Services for Northwest Embroidery Inc: "Available Vacation And Sick Time".

It is one row per employee: Employee Name, ID, Hrs/1 Day, then Accum. Hrs / Hrs Used / Hrs Avail. for VACATION, then Accum. Hrs / Hrs Used / Hrs Avail. for SICK. A "Total:" row closes all six numeric columns.

Extract EVERY employee row, and the Total: row into printedTotals.

Critical rules:
- Hours print as HH:MM. Convert to DECIMAL hours: 107:24 -> 107.4, 00:49 -> 0.8167. Round to 4 decimals.
- NEGATIVE values are real (-08:00 -> -8, -40:04 -> -40.0667). Preserve the sign. Never clamp to zero.
- 🔴 "Hrs Avail." is a PRINTED COLUMN — copy what is on the page. Do NOT compute it as Accum. minus Used. On this report the two legitimately disagree: an employee who has taken vacation they have not yet accrued can print 00:00 available rather than a negative. Copying your own arithmetic into that column would hide exactly the case the reader needs to see.
- printedTotals must be the figures on the report's own "Total:" row — do NOT sum the rows yourself. These verify the extraction, so deriving them defeats the check.
- This is a photograph of a printed page and the rows may be slightly skewed. Each employee's six figures are the ones on that employee's own line — check your row alignment against the ID column before committing to a value.
- asOfDate is the "As of Date:" under the title, NOT the date in the bottom-right corner (that is the print date).

Return the data in the required schema. Dates as YYYY-MM-DD.`;

// jobId -> {status, createdAt, safe, payload, error}. In-memory: a dyno restart drops
// pending jobs and the admin re-uploads. Deliberately not persisted — the payload holds
// full payroll figures and belongs in Caspio only once it has been reviewed and committed.
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
let jobSeq = 0;

function sweepJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}

// Re-derive the packet's totals from the extracted rows and compare to what the packet
// printed. This is the gate that makes a vision read of a SCAN safe to commit.
function reconcile(p) {
  const emps = Array.isArray(p.employees) ? p.employees : [];
  const sum = (f) => r2(emps.reduce((a, x) => a + (Number(f(x)) || 0), 0));
  const t = p.printedTotals || {};
  const checks = [
    ['Gross wages', sum(x => x.grossWages), Number(t.grossWages), 'money'],
    ['Net payroll', sum(x => x.netPay), Number(t.netPayroll), 'money'],
    ['Total deductions', sum(x => x.totalDeductions), Number(t.totalDeductions), 'money'],
    ['Check count', emps.filter(x => x.paid).length, Number(t.checkCount), 'count'],
    ['Vacation accrued', sum(x => x.vacationAccrued), Number(t.vacationAccrued), 'hours'],
    ['Vacation used', sum(x => x.vacationUsed), Number(t.vacationUsed), 'hours'],
    ['Vacation available', sum(x => x.vacationAvailable), Number(t.vacationAvailable), 'hours'],
  ].map(([label, derived, printed, unit]) => ({
    label, derived, printed, unit, ok: Math.abs(derived - printed) <= 0.02,
  }));

  // 🔒 rowIssues is rendered in the BROWSER (toSafeReview attaches the whole verdict), so
  // it must name the employee and nothing else. It used to interpolate that employee's
  // gross, deductions and net — per-person dollar amounts, on a page whose entire reason
  // for existing is that compensation never reaches it. The admin has the packet in front
  // of them; the row number is what they need, not the figures.
  const rowIssues = [];
  for (const x of emps) {
    if (!x.paid) continue;
    if (Math.abs(r2(Number(x.grossWages) - Number(x.totalDeductions)) - Number(x.netPay)) > 0.02) {
      rowIssues.push(`${x.nameOnPacket}: gross minus deductions does not equal net — check this row on the packet`);
    }
  }
  const ids = emps.map(x => x.payrollEmployeeId);
  if (new Set(ids).size !== ids.length) rowIssues.push('duplicate payroll employee IDs in the packet');
  if (!emps.length) rowIssues.push('no employees extracted');

  return { checks, rowIssues, passed: checks.every(c => c.ok) && rowIssues.length === 0 };
}

// Leave-only gate. All six columns of the report's own Total: row are checked against the
// sum of the rows — no money check to pass vacuously, because nothing here is money.
function reconcileLeave(p) {
  const emps = Array.isArray(p.employees) ? p.employees : [];
  const sum = (f) => r2(emps.reduce((a, x) => a + (Number(f(x)) || 0), 0));
  const t = p.printedTotals || {};
  const checks = [
    ['Vacation accrued', sum(x => x.vacationAccrued), Number(t.vacationAccrued)],
    ['Vacation used', sum(x => x.vacationUsed), Number(t.vacationUsed)],
    ['Vacation available', sum(x => x.vacationAvailable), Number(t.vacationAvailable)],
    ['Sick accrued', sum(x => x.sickAccrued), Number(t.sickAccrued)],
    ['Sick used', sum(x => x.sickUsed), Number(t.sickUsed)],
    ['Sick available', sum(x => x.sickAvailable), Number(t.sickAvailable)],
  ].map(([label, derived, printed]) => ({
    label, derived, printed, unit: 'hours', ok: Math.abs(derived - printed) <= 0.02,
  }));

  const rowIssues = [];
  if (!emps.length) rowIssues.push('no employees extracted');
  const ids = emps.map(x => x.payrollEmployeeId);
  if (new Set(ids).size !== ids.length) rowIssues.push('duplicate payroll employee IDs on the report');
  for (const x of emps) {
    if (!Number.isFinite(Number(x.payrollEmployeeId)) || !Number(x.payrollEmployeeId)) {
      rowIssues.push(`${x.nameOnPacket || 'a row'}: no readable employee ID`);
    }
  }

  // ⚠️ NOT a failure. The report floors an over-drawn balance at 00:00 instead of printing
  // a negative, so Accum. minus Used and the printed Hrs Avail. genuinely disagree — on the
  // 2026-08-07 page that is Taneisha Clark, 0 accrued and 16 used printed as 0 available,
  // the whole 16-hour gap between the 1112/796 and 332 totals. The PRINTED figure is what
  // gets saved; this note exists so the difference is seen rather than silently resolved.
  const notes = [];
  for (const x of emps) {
    const vd = r2(Number(x.vacationAccrued) - Number(x.vacationUsed));
    if (Math.abs(vd - Number(x.vacationAvailable)) > 0.02) {
      notes.push(`${x.nameOnPacket}: vacation available is printed as ${x.vacationAvailable}h, but accrued minus used is ${vd}h — saving the printed ${x.vacationAvailable}h`);
    }
    const sd = r2(Number(x.sickAccrued) - Number(x.sickUsed));
    if (Math.abs(sd - Number(x.sickAvailable)) > 0.02) {
      notes.push(`${x.nameOnPacket}: sick available is printed as ${x.sickAvailable}h, but accrued minus used is ${sd}h — saving the printed ${x.sickAvailable}h`);
    }
  }

  return { checks, rowIssues, notes, passed: checks.every(c => c.ok) && rowIssues.length === 0 };
}

// What the browser is allowed to see: hours, leave, and the verdict. No money.
function toSafeReview(p, rec) {
  return {
    checkDate: p.checkDate, periodStart: p.periodStart, periodEnd: p.periodEnd,
    checkNumber: p.checkNumber,
    employees: (p.employees || []).map(x => ({
      payrollEmployeeId: x.payrollEmployeeId, nameOnPacket: x.nameOnPacket, paid: !!x.paid,
      hoursRegular: x.hoursRegular, hoursOvertime: x.hoursOvertime, hoursSick: x.hoursSick,
      hoursVacationPTO: x.hoursVacationPTO, hoursHoliday: x.hoursHoliday,
      hoursTotal: r2((x.hoursRegular || 0) + (x.hoursOvertime || 0) + (x.hoursSick || 0)
        + (x.hoursVacationPTO || 0) + (x.hoursHoliday || 0)),
      vacationAccrued: x.vacationAccrued, vacationUsed: x.vacationUsed,
      vacationAvailable: x.vacationAvailable,
      sickAccrued: x.sickAccrued, sickUsed: x.sickUsed, sickAvailable: x.sickAvailable,
    })),
    reconciliation: rec,
  };
}

// Leave-only review. Same no-money rule, and nothing to strip — the payload never held any.
function toSafeLeaveReview(p, rec) {
  return {
    mode: 'leave',
    asOfDate: p.asOfDate,
    employees: (p.employees || []).map(x => ({
      payrollEmployeeId: x.payrollEmployeeId, nameOnPacket: x.nameOnPacket,
      hoursPerDay: x.hoursPerDay,
      vacationAccrued: x.vacationAccrued, vacationUsed: x.vacationUsed,
      vacationAvailable: x.vacationAvailable,
      sickAccrued: x.sickAccrued, sickUsed: x.sickUsed, sickAvailable: x.sickAvailable,
    })),
    reconciliation: rec,
  };
}

async function runParseJob(jobId, base64, filename, mode) {
  const job = jobs.get(jobId);
  const leave = mode === 'leave';
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Streamed: a 7-page scan runs well past a non-streaming HTTP timeout.
    const stream = client.messages.stream({
      model: MODEL_ID,
      max_tokens: 32000,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: leave ? LEAVE_SCHEMA : PACKET_SCHEMA },
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: leave ? LEAVE_PROMPT : EXTRACT_PROMPT },
        ],
      }],
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') throw new Error('The model declined to process this document.');
    if (msg.stop_reason === 'max_tokens') throw new Error('Extraction was truncated — the packet may be too large.');

    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { throw new Error('Extraction did not return valid JSON.'); }

    const rec = leave ? reconcileLeave(payload) : reconcile(payload);
    job.payload = payload;
    job.safe = leave ? toSafeLeaveReview(payload, rec) : toSafeReview(payload, rec);
    job.safe.sourceFile = filename;
    job.status = 'done';
    console.log(`[payroll] parse ${jobId} (${leave ? 'leave' : 'packet'}): ${payload.employees?.length || 0} employees, reconciled=${rec.passed}`);
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'parse failed';
    console.error(`[payroll] parse ${jobId} failed:`, e.message);
  }
}

// POST /api/payroll/parse  { filename, dataBase64, mode } -> { jobId }
// mode: 'packet' (default) or 'leave'. Unknown values are rejected rather than defaulted —
// silently falling back to 'packet' is how a leave page reaches the vacuous money gate.
router.post('/parse', async (req, res) => {
  sweepJobs();
  const mode = String(req.body?.mode || 'packet');
  if (mode !== 'packet' && mode !== 'leave') {
    return res.status(400).json({ error: `mode must be 'packet' or 'leave'` });
  }
  const filename = String(req.body?.filename || 'payroll-packet.pdf').slice(0, 200);
  const raw = String(req.body?.dataBase64 || '');
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw; // tolerate a data: URL
  if (!base64) return res.status(400).json({ error: 'dataBase64 is required' });
  // Anthropic caps a request at 32 MB; base64 inflates by ~4/3, so bound the raw PDF at ~23 MB.
  const approxBytes = Math.floor(base64.length * 0.75);
  if (approxBytes > 23 * 1024 * 1024) {
    return res.status(413).json({ error: `PDF is ~${Math.round(approxBytes / 1048576)} MB; the limit is 23 MB.` });
  }

  const jobId = `pj_${Date.now().toString(36)}_${(++jobSeq).toString(36)}`;
  jobs.set(jobId, { status: 'running', createdAt: Date.now(), mode });
  runParseJob(jobId, base64, filename, mode); // deliberately not awaited — the HTTP response returns now
  res.status(202).json({ jobId, status: 'running', mode });
});

// GET /api/payroll/parse/:jobId — poll. Returns hours/leave + verdict, never money.
router.get('/parse/:jobId', (req, res) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'job not found or expired' });
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  res.json({ status: 'done', review: job.safe });
});

// ---------------------------------------------------------------- commit

// POST /api/payroll/import { jobId } — writes the SERVER-SIDE payload for a reconciled job.
// The browser sends only the job id, so reviewed figures cannot be edited in transit.
router.post('/import', async (req, res) => {
  const job = jobs.get(String(req.body?.jobId || ''));
  if (!job) return res.status(404).json({ error: 'job not found or expired — re-upload the packet' });
  if (job.status !== 'done') return res.status(409).json({ error: `job is ${job.status}` });

  const p = job.payload;
  const leave = job.mode === 'leave';
  const rec = leave ? reconcileLeave(p) : reconcile(p); // re-run server-side; never trust a verdict computed earlier
  if (!rec.passed) {
    return res.status(422).json({
      error: leave
        ? 'the leave report does not reconcile — refusing to write balances'
        : 'packet does not reconcile — refusing to write payroll',
      reconciliation: rec,
    });
  }
  // The date the balances are "as of". In leave mode it is the report's own As of Date and
  // it only ever stamps Leave_Balances_As_Of — there is no check date on a leave page, so
  // there is nothing to key a pay period on and none is created.
  const effectiveDate = leave ? p.asOfDate : p.checkDate;
  if (!isDate(effectiveDate)) {
    return res.status(422).json({
      error: leave ? 'extracted As of Date is not a valid date' : 'extracted checkDate is not a valid date',
    });
  }

  try {
    const token = await getCaspioAccessToken();
    const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

    // Resolve every packet employee to exactly one Employees row, by payroll ID.
    const emps = await fetchAllCaspioPages(`/tables/${EMPLOYEES}/records`, {
      'q.select': 'ID_Record_Employee,Payroll_Employee_ID,Employee_Full_Name,First_Name,Last_Name',
      'q.pageSize': 500, 'q.orderBy': 'PK_ID',
    });
    const byPayrollId = new Map();
    for (const e of emps || []) {
      const id = Number(e.Payroll_Employee_ID);
      if (id) byPayrollId.set(id, e);
    }
    const unmatched = p.employees.filter(x => !byPayrollId.has(Number(x.payrollEmployeeId)));
    if (unmatched.length) {
      return res.status(422).json({
        error: 'some packet employees have no matching Employees record',
        detail: unmatched.map(x => `${x.nameOnPacket} (payroll #${x.payrollEmployeeId})`),
        hint: 'Set Payroll_Employee_ID on those employees in Caspio, then import again.',
      });
    }

    // Vacation_Hours_Remaining WAS a Caspio formula (accrued - used) and became a plain
    // editable Number on 2026-07-27. A formula field is read-only, so blindly writing it
    // would 400 the whole record update if it were ever converted back — probe once and
    // include it only when it's actually writable. Values are otherwise frozen and go
    // stale the first time a packet changes someone's vacation.
    let vacRemainingWritable = false;
    try {
      const fields = (await axios.get(`${BASE}/tables/${EMPLOYEES}/fields`, { headers: { Authorization: H.headers.Authorization } })).data.Result;
      const vr = (fields || []).find(f => f.Name === 'Vacation_Hours_Remaining');
      vacRemainingWritable = !!vr && vr.Editable !== false && !vr.IsFormula;
    } catch (e) {
      console.warn('[payroll] could not probe Vacation_Hours_Remaining editability:', e.message);
    }

    const stamp = `${effectiveDate} 00:00:00`;
    const dateKey = effectiveDate.replace(/-/g, '');
    let written = 0;
    const failures = [];

    for (const x of p.employees) {
      const emp = byPayrollId.get(Number(x.payrollEmployeeId));
      const rec2 = leave ? null : {
        Register_Key: `${x.payrollEmployeeId}-${dateKey}`,
        Payroll_Employee_ID: x.payrollEmployeeId,
        ID_Record_Employee: emp.ID_Record_Employee,
        Employee_Full_Name: emp.Employee_Full_Name || `${emp.First_Name} ${emp.Last_Name}`,
        Check_Date: p.checkDate, Period_Start: p.periodStart, Period_End: p.periodEnd,
        Check_Number: x.paid ? String(p.checkNumber || '') : '',
        Paid_This_Period: !!x.paid,
        Pay_Rate: x.payRate || 0,
        Hours_Regular: x.hoursRegular || 0, Hours_Overtime: x.hoursOvertime || 0,
        Hours_Sick: x.hoursSick || 0, Hours_Vacation_PTO: x.hoursVacationPTO || 0,
        Hours_Holiday: x.hoursHoliday || 0,
        Hours_Total: r2((x.hoursRegular || 0) + (x.hoursOvertime || 0) + (x.hoursSick || 0)
          + (x.hoursVacationPTO || 0) + (x.hoursHoliday || 0)),
        Wages_Regular: x.wagesRegular || 0, Wages_Overtime: x.wagesOvertime || 0,
        Wages_Sick: x.wagesSick || 0, Wages_Vacation_PTO: x.wagesVacationPTO || 0,
        Wages_Holiday: x.wagesHoliday || 0, Wages_Commissions: x.wagesCommissions || 0,
        Gross_Wages: x.grossWages || 0,
        Ded_Federal_WH: x.dedFederalWH || 0, Ded_Social_Security: x.dedSocialSecurity || 0,
        Ded_Medicare: x.dedMedicare || 0, Ded_State_Other: x.dedStateOther || 0,
        Ded_WA_FamMed_Leave: x.dedWAFamMedLeave || 0, Ded_WA_Cares_Fund: x.dedWACaresFund || 0,
        Ded_Other: 0, Total_Deductions: x.totalDeductions || 0, Net_Pay: x.netPay || 0,
        Vacation_Accrued: x.vacationAccrued || 0, Vacation_Used: x.vacationUsed || 0,
        Vacation_Available: x.vacationAvailable || 0,
        Sick_Accrued: x.sickAccrued || 0, Sick_Used: x.sickUsed || 0,
        Sick_Available: x.sickAvailable || 0,
        Source_File: job.safe.sourceFile || '', Imported_At: stamp,
      };
      try {
        // 🔴 Leave mode writes NO register row. A leave page prints no hours, no wages and
        // no check date, so a row built from it would be 21 zeros under a made-up date —
        // a pay period that never happened, sitting in the Pay Periods tab forever.
        if (!leave) {
          try { await axios.post(`${BASE}/tables/${REGISTER}/records`, rec2, H); }
          catch (_) {
            const { Register_Key, ...upd } = rec2;
            await axios.put(`${BASE}/tables/${REGISTER}/records?q.where=${encodeURIComponent(`Register_Key='${esc(Register_Key)}'`)}`, upd, H);
          }
        }
        // Refresh CURRENT state on Employees. Pay fields are touched only for paid staff —
        // an unpaid employee's packet row says nothing about their rate.
        // 🔴 NEVER add Vacation_Annual_Entitlement here. It is the hand-maintained annual
        // grant the slip subtracts the carryover against; writing the packet's inflated
        // accrued into it would make the correction a no-op and silently revert anyone
        // with a carryover to the raw payroll figure.
        const upd = {
          Vacation_Hours_Available: x.vacationAccrued || 0,
          Vacation_Hours_Used: x.vacationUsed || 0,
          Sick_Accum_Hours_Available: x.sickAccrued || 0,
          Sick_Hours_Used: x.sickUsed || 0,
          // Leave mode saves the report's PRINTED Hrs Avail. column. The packet path still
          // derives it — changing that is a separate call, since it would move balances on
          // the monthly import too. The two disagree only where the report floors an
          // over-drawn balance at zero; see the note in reconcileLeave().
          Sick_Hours_Remaining: leave
            ? (Number(x.sickAvailable) || 0)
            : r2((x.sickAccrued || 0) - (x.sickUsed || 0)),
          Leave_Balances_As_Of: effectiveDate,
        };
        if (vacRemainingWritable) {
          upd.Vacation_Hours_Remaining = leave
            ? (Number(x.vacationAvailable) || 0)
            : r2((x.vacationAccrued || 0) - (x.vacationUsed || 0));
        }
        // No pay rate on a leave page — never touch Pay from one.
        if (!leave && x.paid && x.payRate > 0) { upd.Pay = x.payRate; upd.Pay_Rate_Effective_Date = p.checkDate; }
        await axios.put(`${BASE}/tables/${EMPLOYEES}/records?q.where=${encodeURIComponent(`ID_Record_Employee='${esc(emp.ID_Record_Employee)}'`)}`, upd, H);
        written++;
      } catch (err) {
        failures.push(`${x.nameOnPacket}: ${err.response ? JSON.stringify(err.response.data).slice(0, 160) : err.message}`);
      }
    }

    jobs.delete(String(req.body.jobId)); // one-shot: a committed packet can't be re-committed
    console.log(`[payroll] import ${leave ? 'leave' : 'packet'} ${effectiveDate}: ${written}/${p.employees.length} written, ${failures.length} failed`);
    res.json({
      imported: written, total: p.employees.length,
      mode: leave ? 'leave' : 'packet',
      effectiveDate, checkDate: leave ? null : p.checkDate,
      registerRowsWritten: leave ? 0 : written,
      failures, reconciliation: rec,
    });
  } catch (e) {
    console.error('[payroll] import failed:', e.message);
    res.status(502).json({ error: 'import failed', detail: e.message });
  }
});

module.exports = router;
// Exposed for tests only — the gate is the whole point of the leave path, so it is locked
// by tests/unit/payroll-leave-reconcile.test.js rather than trusted by inspection.
module.exports._reconcileLeave = reconcileLeave;
