#!/usr/bin/env node
/**
 * Prem Patra visitor tracker — a zero-dependency Node server.
 *
 *   GET  /                    the invitation, served exactly as stored (no markup changes)
 *   POST /api/track           one open / RSVP event  ->  data/visits.json
 *   GET  /api/track/stats     aggregated numbers for the dashboard
 *   GET  /api/track/export    download the raw JSON file
 *   GET  /tracking            the dashboard (who opened it, how often, from where)
 *   GET  /healthz             liveness probe
 *
 * The invitation posts to /api/track on the same origin, so no CORS setup is needed
 * when the site is served by this process. Set TRACKING_PASSWORD to protect the
 * dashboard: names of invited guests should not be public.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'visits.json');
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.TRACKING_PASSWORD || '';
const MAX_BODY = 32 * 1024;
const MAX_EVENTS = 50_000;
const STORED_TYPES = new Set(['visit', 'rsvp', 'geo', 'blessing', 'action']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------------ storage */

let store = { version: 1, updatedAt: null, visits: [] };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.visits)) {
      store = { version: 1, updatedAt: parsed.updatedAt || null, visits: parsed.visits };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(DATA_FILE, backup);
        console.error(`[tracker] ${DATA_FILE} was unreadable; moved it to ${backup}`);
      } catch (renameError) {
        console.error('[tracker] could not back up the unreadable data file:', renameError.message);
      }
    }
    // Create the JSON file up front, so /api/track/export works before the first open.
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (writeError) {
      console.error('[tracker] could not create the data file:', writeError.message);
    }
  }
}

/* Writes are serialised and atomic (temp file + rename) so a crash mid-write cannot
   leave a half-written JSON file behind. */
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain
    .then(async () => {
      store.updatedAt = new Date().toISOString();
      const tmp = `${DATA_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
      await fsp.rename(tmp, DATA_FILE);
    })
    .catch(error => console.error('[tracker] could not write the data file:', error.message));
  return writeChain;
}

/* ------------------------------------------------------------------ helpers */

const text = (value, max = 200) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .trim()
    .slice(0, max);

const integer = value => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.socket.remoteAddress || '');
  return ip.replace(/^::ffff:/, '').slice(0, 60);
}

function isPrivateIp(ip) {
  return !ip || ip === '::1' || /^127\./.test(ip) || /^10\./.test(ip) ||
    /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/* Behind nginx, X-Forwarded-For is the guest's real address. When running locally the
   socket address is loopback, so fall back to the public IP the page resolved itself. */
function effectiveIp(req, reported) {
  const direct = clientIp(req);
  return isPrivateIp(direct) ? (text(reported, 60) || direct) : direct;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

const corsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
});

/* 120 events per IP per 10 minutes is far above real guest behaviour and still stops
   a runaway loop from filling the file. */
const buckets = new Map();
function allowEvent(req) {
  const ip = clientIp(req) || 'unknown';
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 10 * 60_000 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (now > value.reset) buckets.delete(key);
  }
  return bucket.count <= 120;
}

function passwordOk(req, url) {
  if (!PASSWORD) return true;
  const supplied = String(req.headers['x-tracking-key'] || url.searchParams.get('key') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) {
    // Still run a comparison so the response time does not reveal the length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ ingest */

async function track(req, res) {
  const body = await readBody(req);
  let fields;
  if (/application\/json/i.test(req.headers['content-type'] || '')) {
    try {
      fields = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { ok: false, error: 'Invalid JSON' }, corsHeaders());
    }
  } else {
    fields = Object.fromEntries(new URLSearchParams(body));
  }

  const type = text(fields.type, 16) || 'visit';
  if (!STORED_TYPES.has(type)) {
    // Button taps are deliberately not stored; the file stays small and readable.
    return json(res, 202, { ok: true, stored: false }, corsHeaders());
  }
  if (!allowEvent(req)) {
    return json(res, 429, { ok: false, error: 'Too many events' }, corsHeaders());
  }
  if (store.visits.length >= MAX_EVENTS) {
    return json(res, 507, { ok: false, error: 'Tracking file is full' }, corsHeaders());
  }

  const record = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    guest: text(fields.guest, 80),
    name: text(fields.name, 80),
    relation: text(fields.relation, 24),
    language: text(fields.lang, 8),
    device: text(fields.device, 60),
    visitorId: text(fields.vid, 48),
    ip: effectiveIp(req, fields.ip),
    city: text(fields.iploc, 120),
    isp: text(fields.isp, 80),
    geo: text(fields.geo, 160),
    referrer: text(fields.ref, 300),
    page: text(fields.page, 500),
    userAgent: text(fields.ua, 300),
    screen: text(fields.screen, 40),
    timezone: text(fields.tz, 60),
    localTime: text(fields.local, 40),
    clientOpens: integer(fields.opens),
    sender: text(fields.sender, 80),
    sharedBy: text(fields.sharedBy, 80),
    attending: text(fields.attending, 8),
    message: text(fields.msg, 600),
    action: text(fields.action, 40),
    detail: text(fields.detail, 400)
  };

  store.visits.push(record);
  await persist();
  // Taps are frequent; log only the events that change the headline numbers.
  if (type !== 'action') {
    console.log(`[tracker] ${type} · ${record.guest || '(direct link)'} · ${record.device || 'unknown device'}`);
  }
  return json(res, 202, { ok: true, id: record.id }, corsHeaders());
}

/* ------------------------------------------------------------------ summary */

/* Scroll milestones are reported as taps named scroll-start / scroll-25 / … / scroll-100.
   They describe reading depth, not a button, so they are aggregated separately. */
function isScrollMark(record) {
  return record.type === 'action' &&
    String(record.action || '') === 'tap' &&
    /^scroll-(start|25|50|75|100)$/.test(String(record.detail || ''));
}

function scrollDepthOf(record) {
  if (!isScrollMark(record)) return 0;
  const match = /^scroll-(25|50|75|100)$/.exec(String(record.detail || ''));
  return match ? Number(match[1]) : 0;
}

/* The button a record represents. Taps carry the button id in `detail`; the other
   interactive events are named after the control that triggered them. */
function buttonOf(record) {
  if (record.type === 'action') {
    if (isScrollMark(record)) return '';
    const detail = String(record.detail || '').trim().slice(0, 80);
    const action = String(record.action || '').trim().slice(0, 40);
    return action === 'tap' ? (detail || 'tap') : (action || detail || 'unknown');
  }
  if (record.type === 'blessing') return 'blessings';
  return '';
}

function visitorKey(record) {
  return record.visitorId || `${record.ip}|${record.userAgent}` || record.id;
}

function summarize() {
  const guests = new Map();
  const visitors = new Map();
  const buttons = new Map();
  let opens = 0;
  let clicks = 0;
  let lastOpen = null;

  const guestFor = name => {
    const key = name || '(direct link)';
    let guest = guests.get(key);
    if (!guest) {
      guest = {
        name: key, opens: 0, clicks: 0, scroll: 0, scrollStarted: false,
        devices: new Set(), buttons: {},
        first: null, last: null, lastClick: null,
        device: '', city: '', ip: '', relation: '', language: '',
        referrer: '', page: '', sender: '', sharedBy: '',
        rsvp: '', rsvpName: '', message: ''
      };
      guests.set(key, guest);
    }
    return guest;
  };

  const visitorFor = record => {
    const key = visitorKey(record);
    let visitor = visitors.get(key);
    if (!visitor) {
      visitor = {
        id: key, name: record.guest || '(direct link)', opens: 0, clicks: 0,
        first: record.at, last: record.at, device: record.device || '',
        city: record.city || '', ip: record.ip || '', referrer: record.referrer || '',
        language: record.language || '', timezone: record.timezone || ''
      };
      visitors.set(key, visitor);
    }
    if (record.at < visitor.first) visitor.first = record.at;
    if (record.at >= visitor.last) {
      visitor.last = record.at;
      visitor.name = record.guest || visitor.name;
      visitor.device = record.device || visitor.device;
      visitor.city = record.city || visitor.city;
      visitor.ip = record.ip || visitor.ip;
      visitor.referrer = record.referrer || visitor.referrer;
      visitor.language = record.language || visitor.language;
      visitor.timezone = record.timezone || visitor.timezone;
    }
    return visitor;
  };

  for (const record of store.visits) {
    if (record.type === 'visit') {
      opens += 1;
      if (!lastOpen || record.at > lastOpen) lastOpen = record.at;

      const guest = guestFor(record.guest);
      guest.opens += 1;
      guest.devices.add(visitorKey(record));
      if (!guest.first || record.at < guest.first) guest.first = record.at;
      if (!guest.last || record.at >= guest.last) {
        guest.last = record.at;
        guest.device = record.device || guest.device;
        guest.city = record.city || guest.city;
        guest.ip = record.ip || guest.ip;
        guest.relation = record.relation || guest.relation;
        guest.language = record.language || guest.language;
        guest.referrer = record.referrer || guest.referrer;
        guest.page = record.page || guest.page;
        guest.sender = record.sender || guest.sender;
        guest.sharedBy = record.sharedBy || guest.sharedBy;
      }
      visitorFor(record).opens += 1;
    } else if (record.type === 'rsvp') {
      const guest = guestFor(record.guest);
      guest.rsvp = record.attending || 'Yes';
      guest.rsvpName = record.name || '';
      guest.message = record.message || '';
    }

    if (isScrollMark(record)) {
      const guest = guestFor(record.guest);
      guest.scrollStarted = true;
      const depth = scrollDepthOf(record);
      if (depth > guest.scroll) guest.scroll = depth;
      visitorFor(record);
      continue;
    }

    const button = buttonOf(record);
    if (!button) continue;
    clicks += 1;

    const guest = guestFor(record.guest);
    guest.clicks += 1;
    guest.buttons[button] = (guest.buttons[button] || 0) + 1;
    if (!guest.lastClick || record.at > guest.lastClick) guest.lastClick = record.at;

    visitorFor(record).clicks += 1;

    let stat = buttons.get(button);
    if (!stat) {
      stat = { name: button, clicks: 0, guests: new Set(), visitors: new Set(), last: null };
      buttons.set(button, stat);
    }
    stat.clicks += 1;
    stat.guests.add(record.guest || '(direct link)');
    stat.visitors.add(visitorKey(record));
    if (!stat.last || record.at > stat.last) stat.last = record.at;
  }

  let rsvpYes = 0;
  let rsvpNo = 0;
  for (const guest of guests.values()) {
    if (guest.rsvp === 'Yes') rsvpYes += 1;
    else if (guest.rsvp === 'No') rsvpNo += 1;
  }

  const byLast = (a, b) => String(b.last || '').localeCompare(String(a.last || ''));
  const direct = guests.get('(direct link)');
  const scrolled = [...guests.values()].filter(g => g.scrollStarted).length;
  const completed = [...guests.values()].filter(g => g.scroll >= 100).length;

  const recent = store.visits
    .filter(record => buttonOf(record))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 80)
    .map(record => ({
      at: record.at,
      guest: record.guest || '(direct link)',
      button: buttonOf(record),
      device: record.device || ''
    }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      opens,
      clicks,
      uniqueVisitors: visitors.size,
      uniqueGuests: [...guests.values()].filter(g => g.opens > 0 && g.name !== '(direct link)').length,
      uniqueButtons: buttons.size,
      directOpens: direct ? direct.opens : 0,
      scrolled,
      completed,
      rsvpYes,
      rsvpNo,
      lastOpen
    },
    guests: [...guests.values()].sort(byLast).map(g => ({ ...g, devices: g.devices.size })),
    visitors: [...visitors.values()].sort(byLast),
    buttons: [...buttons.values()]
      .sort((a, b) => b.clicks - a.clicks || String(b.last || '').localeCompare(String(a.last || '')))
      .map(b => ({ name: b.name, clicks: b.clicks, guests: b.guests.size, visitors: b.visitors.size, last: b.last })),
    recent
  };
}

/* ------------------------------------------------------------------ static */

function assetPath(pathname) {
  const relative = pathname.replace(/^\/+/, '');
  const full = path.resolve(ROOT, relative);
  const assetsDir = path.join(ROOT, 'assets') + path.sep;
  return full.startsWith(assetsDir) ? full : null;
}

function sendFile(req, res, file, { cache = 'no-cache', attachment = '' } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return json(res, 404, { ok: false, error: 'Not found' });
  }
  if (!stat.isFile()) return json(res, 404, { ok: false, error: 'Not found' });

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  if (attachment) headers['Content-Disposition'] = `attachment; filename="${attachment}"`;

  const range = req.headers.range;
  if (!range) {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (match[1] && !match[2]) {
    start = Number(match[1]);
    end = stat.size - 1;
  }
  if (start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  end = Math.min(end, stat.size - 1);
  headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  headers['Accept-Ranges'] = 'bytes';
  headers['Content-Length'] = end - start + 1;
  res.writeHead(206, headers);
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(file, { start, end }).pipe(res);
}

/* ------------------------------------------------------------------ routing */

const server = http.createServer(async (req, res) => {
  let url;
  let pathname;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { ok: false, error: 'Bad request' });
  }

  try {
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/track')) {
      res.writeHead(204, corsHeaders());
      return res.end();
    }

    if (pathname === '/api/track' || pathname === '/api/track/open') {
      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'Use POST' }, corsHeaders());
      }
      return await track(req, res);
    }

    if (pathname === '/api/track/stats') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Use GET' });
      if (!passwordOk(req, url)) return json(res, 401, { ok: false, error: 'Password required' });
      return json(res, 200, summarize());
    }

    if (pathname === '/api/track/export') {
      if (!passwordOk(req, url)) return json(res, 401, { ok: false, error: 'Password required' });
      return sendFile(req, res, DATA_FILE, { cache: 'no-store', attachment: 'visits.json' });
    }

    if (pathname === '/tracking' || pathname === '/tracking/') {
      return sendFile(req, res, DASHBOARD_FILE, { cache: 'no-store' });
    }

    if (pathname === '/healthz') {
      return json(res, 200, { ok: true, opens: store.visits.filter(v => v.type === 'visit').length });
    }

    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('User-agent: *\nDisallow: /\n');
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(req, res, path.join(ROOT, 'index.html'));
    }

    if (pathname.startsWith('/assets/')) {
      const file = assetPath(pathname);
      if (!file) return json(res, 404, { ok: false, error: 'Not found' });
      return sendFile(req, res, file, { cache: 'public, max-age=3600' });
    }

    return json(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error('[tracker]', error);
    if (!res.headersSent) json(res, error.status || 500, { ok: false, error: 'Server error' });
  }
});

load();
server.listen(PORT, HOST, () => {
  console.log(`Invitation          http://localhost:${PORT}/`);
  console.log(`Tracking dashboard  http://localhost:${PORT}/tracking`);
  console.log(`Data file           ${DATA_FILE}`);
  if (!PASSWORD) console.warn('TRACKING_PASSWORD is not set — the dashboard is open to anyone who has the URL.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (error) {
      console.error('[tracker] final write failed:', error.message);
    }
    process.exit(0);
  });
}
