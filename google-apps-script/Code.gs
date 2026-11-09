/**
 * Google Apps Script Web App for the Utkarsh & Simran invitation.
 *
 * index.html posts these kinds of row here:
 *   visit    : someone opened the invitation (who, when, from which device/link)
 *   geo      : that guest later tapped the location chip, so we now know where from
 *   action   : a single button tap, for the full journey
 *   blessing : the WhatsApp blessing text they chose to send
 *   rsvp     : a completed "Send your blessings" response
 *
 * Every write also refreshes the "Visitor Summary" tab: one line per invited guest with
 * the opening count, distinct devices, first/last open and RSVP. The open count is
 * computed here from the detail rows, so it does not depend on the guest's browser.
 *
 * Columns are matched BY NAME, not by position. If you reorder, rename or delete a
 * column in the sheet, rows still land in the right place. Any header listed in
 * HEADERS that the sheet is missing is appended automatically on the next write, so
 * you can upgrade this file on an existing sheet without losing data.
 */

const SPREADSHEET_ID = '1h8iqEmdylesEBkPWByVTtJWJTAp1WflYX8GYzQL1eIY';
const SHEET_NAME = 'Visitor Details';
const SUMMARY_SHEET = 'Visitor Summary';

/* Events that change the summary. `action` rows are deliberately excluded: they are the
   most frequent, and none of them changes who opened what. */
const SUMMARY_TYPES = { visit: true, geo: true, rsvp: true, blessing: true };

const HEADERS = [
  // --- original columns, kept first so an existing sheet stays readable ---
  'Timestamp', 'Type', 'Invited Guest', 'Submitted Name', 'Relation',
  'Family Invitation', 'Language', 'Attending', 'Number of Guests', 'Message',
  'Location', 'Sender', 'Shared By', 'Device', 'Visit Count',
  // --- added: who shared to whom, plus client metadata ---
  'Referral', 'Browser Language', 'Platform', 'Mobile', 'Screen', 'Viewport',
  'Timezone', 'UTC Offset', 'Local Time', 'Referrer', 'Online', 'User Agent', 'Invitation URL',
  // --- added: network identity, activity log and blessing text ---
  'IP', 'IP Location', 'ISP', 'Total Opens', 'Action', 'Detail',
  // --- added: anonymous per-browser id, used to count unique devices ---
  'Visitor ID'
];

function doGet() {
  return jsonResponse({ ok: true, message: 'Wedding visitor endpoint is active.' });
}

function doPost(e) {
  try {
    const data = (e && e.parameter) ? e.parameter : {};
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);

    try {
      const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
      const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
      const headers = ensureHeaders(sheet);
      const rows = readRows(sheet, headers);

      const record = {};
      headers.forEach(function (h) { record[h] = valueFor(h, data); });

      const type = String(data.type || 'visit');
      const key = guestKey(record);
      const priorOpens = rows.filter(function (r) {
        return String(r.Type) === 'visit' && guestKey(r) === key;
      }).length;

      /* Total Opens is counted from the sheet itself, so it stays correct when a guest
         clears browser storage or opens the link on a second phone. The client counter
         is only a fallback for rows written by an older version of this script. */
      let totalOpens = priorOpens + (type === 'visit' ? 1 : 0);
      if (!totalOpens) totalOpens = parseInt(data.opens || '0', 10) || 0;
      record['Total Opens'] = String(totalOpens);

      const now = new Date();
      const values = headers.map(function (h) {
        return h === 'Timestamp' ? now : safeCell(record[h]);
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([values]);

      if (SUMMARY_TYPES[type]) {
        record.Timestamp = now;
        rows.push(record);
        writeSummary(spreadsheet, rows);
      }

      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: String((error && error.message) || error) });
  }
}

/**
 * Creates the header row if the sheet is empty, appends any columns that are missing,
 * and returns the sheet's ACTUAL header order so each row lines up with it.
 */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 165);
    return HEADERS.slice();
  }

  const current = readHeaderRow(sheet, Math.max(sheet.getLastColumn(), 1));
  const missing = HEADERS.filter(function (h) { return current.indexOf(h) < 0; });

  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length)
      .setValues([missing])
      .setFontWeight('bold');
  }

  sheet.setFrozenRows(1);
  return readHeaderRow(sheet, sheet.getLastColumn());
}

function readHeaderRow(sheet, width) {
  return sheet.getRange(1, 1, 1, width).getDisplayValues()[0]
    .map(function (s) { return String(s).trim(); });
}

/** Every existing data row as a header-keyed object, in the order they were written. */
function readRows(sheet, headers) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, Math.max(headers.length, 1))
    .getValues()
    .map(function (row) {
      const out = {};
      for (let i = 0; i < headers.length; i++) out[headers[i]] = row[i];
      return out;
    });
}

/** Rows are grouped by the invited name carried in the personal link. */
function guestKey(row) {
  const name = String(row['Invited Guest'] || '').trim();
  return (name || '(direct link)').toLowerCase();
}

function toDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Rewrites the "Visitor Summary" tab: one line per invited guest with the number of
 * opens, how many distinct devices, the first and last time they opened it, where from,
 * and their RSVP. Rebuilt from Visitor Details so editing or removing a row is reflected.
 */
function writeSummary(spreadsheet, rows) {
  const guests = {};
  const order = [];

  rows.forEach(function (row) {
    const key = guestKey(row);
    if (!guests[key]) {
      guests[key] = {
        name: String(row['Invited Guest'] || '').trim() || '(direct link)',
        opens: 0, devices: {}, first: null, last: null, event: '',
        device: '', city: '', ip: '', lang: '', sender: '', sharedBy: '',
        rsvp: '', guestName: '', message: ''
      };
      order.push(key);
    }

    const guest = guests[key];
    const type = String(row['Type'] || '');
    const at = toDate(row['Timestamp']);

    if (type === 'visit') {
      guest.opens += 1;
      const device = String(row['Visitor ID'] || '') ||
        (String(row['IP'] || '') + '|' + String(row['User Agent'] || ''));
      guest.devices[device || 'unknown'] = true;
    }

    if (at) {
      if (!guest.first || at < guest.first) guest.first = at;
      if (!guest.last || at >= guest.last) {
        guest.last = at;
        guest.event = type;
        guest.device = String(row['Device'] || '');
        guest.city = String(row['Location'] || row['IP Location'] || '');
        guest.ip = String(row['IP'] || '');
      }
    }

    if (row['Language']) guest.lang = String(row['Language']);
    if (row['Sender']) guest.sender = String(row['Sender']);
    if (row['Shared By']) guest.sharedBy = String(row['Shared By']);
    if (type === 'rsvp') {
      guest.rsvp = String(row['Attending'] || '');
      guest.guestName = String(row['Submitted Name'] || '');
      guest.message = String(row['Message'] || '');
    }
  });

  const out = order.map(function (key) { return guests[key]; })
    .sort(function (a, b) {
      return (b.last ? b.last.getTime() : 0) - (a.last ? a.last.getTime() : 0);
    });

  const sheet = spreadsheet.getSheetByName(SUMMARY_SHEET) || spreadsheet.insertSheet(SUMMARY_SHEET);
  sheet.clear();

  const headers = [
    'Invited Guest', 'Opens', 'Unique Devices', 'First Open', 'Last Open',
    'Last Event', 'Device', 'City', 'IP', 'Language', 'RSVP',
    'Submitted Name', 'Message', 'Shared By', 'Sender'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (out.length) {
    const values = out.map(function (guest) {
      return [
        guest.name, guest.opens, Object.keys(guest.devices).length,
        guest.first, guest.last, guest.event, guest.device, guest.city,
        guest.ip, guest.lang, guest.rsvp, guest.guestName, guest.message,
        guest.sharedBy, guest.sender
      ];
    });
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
    sheet.getRange(2, 4, values.length, 2).setNumberFormat('dd mmm yyyy, hh:mm:ss');
  }

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 60);
  sheet.setColumnWidth(3, 95);
  sheet.setColumnWidth(4, 155);
  sheet.setColumnWidth(5, 155);
  sheet.setColumnWidth(12, 150);
  sheet.setColumnWidth(13, 260);
}

/** Menu inside the bound spreadsheet: rebuild the summary after manual edits. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Wedding invites')
      .addItem('Rebuild visitor summary', 'rebuildSummary')
      .addToUi();
  } catch (error) {
    // Not every deployment is bound to the spreadsheet; the web app still works.
  }
}

function rebuildSummary() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No "' + SHEET_NAME + '" sheet yet — nobody has opened the invitation.');
  const headers = readHeaderRow(sheet, Math.max(sheet.getLastColumn(), 1));
  writeSummary(spreadsheet, readRows(sheet, headers));
}

/** Maps one posted field set onto the sheet's column names. */
function valueFor(header, d) {
  switch (header) {
    case 'Type': return d.type;
    case 'Invited Guest': return d.guest;
    case 'Submitted Name': return d.name;
    case 'Relation': return d.relation;
    case 'Family Invitation':
      return d.family === '1' ? 'Yes' : (d.family === '0' ? 'No' : d.family);
    case 'Language': return d.lang;
    case 'Attending': return d.attending;
    case 'Number of Guests': return d.guests;
    case 'Message': return d.msg;
    case 'Location': return d.geo;
    case 'Sender': return d.sender;
    case 'Shared By': return d.sharedBy || d.sender;
    case 'Device': return d.device;
    case 'Visit Count': return d.count;
    case 'Referral': return referral(d);
    case 'Browser Language': return d.locale;
    case 'Platform': return d.platform;
    case 'Mobile': return d.mobile;
    case 'Screen': return d.screen;
    case 'Viewport': return d.view;
    case 'Timezone': return d.tz;
    case 'UTC Offset': return d.tzoff;
    case 'Local Time': return d.local;
    case 'Referrer': return d.ref;
    case 'Online': return d.online;
    case 'User Agent': return d.ua;
    case 'Invitation URL': return d.page;
    case 'IP': return d.ip;
    case 'IP Location': return d.iploc;
    case 'ISP': return d.isp;
    case 'Total Opens': return d.opens;
    case 'Action': return d.action;
    case 'Detail': return d.detail;
    case 'Visitor ID': return d.vid;
    default: return '';
  }
}

/** "Who shared it to whom", in one readable column. */
function referral(d) {
  const from = d.sharedBy || d.sender || '';
  const to = d.guest || '';
  if (!from && !to) return '';
  return (from || 'direct link') + ' → ' + (to || 'open link');
}

/** Blocks spreadsheet formula injection from guest-supplied text. */
function safeCell(value) {
  const text = String(value == null ? '' : value).trim().slice(0, 2000);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
