# Visitor tracking

Every time a guest opens the invitation, one row is added to
`tracking/data/visits.json`. The `/tracking` route turns that file into a table of
names, open counts, times, devices and cities.

The invitation card itself is untouched: this server only serves the existing
`index.html` and `assets/` byte for byte.

## Run

```bash
node tracking/server.mjs
```

Then open:

| URL | What it shows |
|---|---|
| `http://localhost:3010/` | the invitation (single tracking endpoint, no markup change) |
| `http://localhost:3010/tracking` | who opened it, how often, from which device/city |
| `http://localhost:3010/api/track/stats` | the same numbers as JSON |
| `http://localhost:3010/api/track/export` | download `visits.json` |
| `http://localhost:3010/healthz` | liveness probe |

Open `/tracking` on the same host you are testing from. To check on a phone on the
same Wi-Fi, use the computer's LAN address, for example
`http://192.168.1.20:3010/tracking`.

## How an open is recorded

`index.html` posts one form-encoded event to `/api/track` when the invitation is
revealed — before the envelope animation finishes, so leaving mid-animation still
counts. The request uses `navigator.sendBeacon`, which survives the tab being closed
immediately afterwards, with a `keepalive` fetch as fallback.

The server stores:

| Field | Meaning |
|---|---|
| `at` | server time (ISO) |
| `guest` | the invited name from the personal link (`?to=`) |
| `visitorId` | anonymous per-browser id, so two phones are counted separately |
| `device`, `screen`, `timezone`, `localTime` | what the browser reports |
| `ip`, `city`, `isp` | resolved by the page before sending; city is **not** GPS |
| `page` | the exact personalised link that was opened |
| `referrer` | where the click came from, when the app passes it |

`rsvp`, `geo`, `blessing` and `action` events are stored too, so a guest's RSVP,
location and button taps appear next to their opens.

## Button clicks

Every control in the invitation reports the button that was tapped. The dashboard
groups these into a **Button clicks** tab:

- one line per button with total clicks, how many guests and devices used it, and the
  last time it was clicked
- the recent clicks list shows **who** tapped **which button**, and **when**

The button name comes from the `data-act` value (`share-open`, `ics:wedding`,
`sh-wa`, `gen-create`, …) plus the controls that are not `data-act` buttons
(`envelope-open`, `skip-intro`, `gate-submit`, `language`, `music`, `film_music`).
`blessings` is derived from the blessing event, so it is counted once. The dashboard
maps the ids to readable labels; the raw id is shown underneath each label.

The event payload carries `action` and `detail`, matching the Google Sheet columns.
A tap is sent as `action=tap`, `detail=<button id>`; other controls send their own
name as `action`.

## Did they scroll?

An animated downward-chevron button floats at the bottom center of the invitation,
without a circular background, pulse ring, or visible text. Tapping it scrolls down.
It hides at the bottom of the page and while the invitation is locked by an overlay.
A translated accessible label remains available to screen readers, and the animation
is disabled for guests who prefer reduced motion.

Reading depth is recorded once per session as `scroll-start`, `scroll-25`, `scroll-50`,
`scroll-75` and `scroll-100`. The dashboard shows:

- **Scrolled the page** — guests who moved past the first screen
- **Read to the end** — guests who reached the bottom
- a **Read depth** column per guest (`25%`, `50%`, `75%`, *Read to end*)

Scroll milestones are not counted as button clicks; they are aggregated separately.

Opens are counted from the file, never from the visitor's browser, so clearing
storage or switching phones cannot under-count.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3010` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` behind nginx |
| `TRACKING_PASSWORD` | *(empty)* | Protects `/tracking`, `/api/track/stats` and `/api/track/export` |
| `DATA_FILE` | `tracking/data/visits.json` | Where events are stored |

Set a password before putting this on the internet — the dashboard lists guest names:

```bash
TRACKING_PASSWORD='choose-something-long' node tracking/server.mjs
```

The dashboard asks for the password once per browser tab (`sessionStorage`).

## Deploying next to the site

If the invitation is served by this process, leave `TRACK_ENDPOINT` empty in
`index.html`: the page posts to `/api/track` on its own origin.

If the invitation is hosted elsewhere (GitHub Pages, another domain), set it to the
full tracker URL:

```js
const TRACK_ENDPOINT='https://track.example.com/api/track';
```

The tracker accepts cross-origin `POST`s (`Access-Control-Allow-Origin: *`) because the
events carry no credentials. It must be served over **HTTPS** if the invitation is,
otherwise the browser blocks the request as mixed content.

Example nginx proxy:

```nginx
server {
    listen 80;
    server_name track.example.com;

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Backups and privacy

- `visits.json` is git-ignored: it contains guest names, IP addresses and button taps.
- Writes are atomic (temp file + rename), and an unreadable file is moved aside as
  `visits.json.corrupt-<timestamp>` instead of being overwritten.
- The server refuses to grow past 50,000 records. At a typical wedding (hundreds of
  guests, a few clicks each) the file stays around 1–3 MB.
- Back the file up during the wedding week, for example:
  `cp tracking/data/visits.json ~/backups/visits-$(date +%F-%H%M).json`
- Delete the file to reset all counts — it is recreated on the next open.
- Set `TRACK_IP=false` in `index.html` to stop the browser sending IP/city data; opens
  are still recorded.

## Optional Google Sheet mirror

The original Apps Script integration still works and can run alongside the JSON
tracker. Set `RSVP_ENDPOINT` in `index.html` to the `/exec` URL from
[`../google-apps-script/SETUP.md`](../google-apps-script/SETUP.md) and every event is
sent to both destinations.
