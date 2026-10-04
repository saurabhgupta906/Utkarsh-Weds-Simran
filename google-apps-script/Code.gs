/**
 * Google Apps Script Web App for the Utkarsh & Simran invitation.
 *
 * index.html posts three kinds of row here:
 *   visit : someone opened the invitation (who, when, from which device/link)
 *   geo   : that guest later tapped the location chip, so we now know where from
 *   rsvp  : a completed "Send your blessings" response
 *
 * Columns are matched BY NAME, not by position. If you reorder, rename or delete a
 * column in the sheet, rows still land in the right place. Any header listed in
 * HEADERS that the sheet is missing is appended automatically on the next write, so
 * you can upgrade this file on an existing sheet without losing data.
 */

const SPREADSHEET_ID = '1h8iqEmdylesEBkPWByVTtJWJTAp1WflYX8GYzQL1eIY';
const SHEET_NAME = 'Visitor Details';

const HEADERS = [
  // --- original columns, kept first so an existing sheet stays readable ---
  'Timestamp', 'Type', 'Invited Guest', 'Submitted Name', 'Relation',
  'Family Invitation', 'Language', 'Attending', 'Number of Guests', 'Message',
  'Location', 'Sender', 'Shared By', 'Device', 'Visit Count',
  // --- added: who shared to whom, plus client metadata ---
  'Referral', 'Browser Language', 'Platform', 'Mobile', 'Screen', 'Viewport',
  'Timezone', 'UTC Offset', 'Local Time', 'Referrer', 'Online', 'User Agent', 'Invitation URL',
  // --- added: network identity, activity log and blessing text ---
  'IP', 'IP Location', 'ISP', 'Total Opens', 'Action', 'Detail'
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

      sheet.appendRow(headers.map(function (h) {
        return h === 'Timestamp' ? new Date() : safeCell(valueFor(h, data));
      }));

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
