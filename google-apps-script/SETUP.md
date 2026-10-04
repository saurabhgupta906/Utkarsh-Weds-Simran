# Visitor tracking → Google Sheets

The spreadsheet page URL cannot receive website submissions directly. Deploy the included
`Code.gs` as a Google Apps Script Web App to get the required `/exec` endpoint. Once it is
wired up, every invitation open, shared location and RSVP lands in the sheet automatically.

## Deploy

1. Open the Google Sheet: `https://docs.google.com/spreadsheets/d/1h8iqEmdylesEBkPWByVTtJWJTAp1WflYX8GYzQL1eIY/edit`
2. Select **Extensions → Apps Script**.
3. Replace the editor contents with everything from `Code.gs`, then save.
4. **Set the time zone** — click ⚙ **Project Settings** and set the time zone to
   **(GMT+05:30) India Standard Time**. Without this, the `Timestamp` column is written in
   Google's default time zone and will not match the `Local Time` column.
5. Select **Deploy → New deployment**.
6. Choose **Web app**.
7. Set **Execute as** to **Me**.
8. Set **Who has access** to **Anyone**.
9. Select **Deploy**, authorize access, and copy the Web App URL ending in `/exec`.
10. In `index.html`, paste that URL into `const RSVP_ENDPOINT = '';` near the top of the
    `<script>` block.
11. Open the `/exec` URL directly. It should show
    `{"ok":true,"message":"Wedding visitor endpoint is active."}`.

The script creates the **Visitor Details** tab automatically.

If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → New version → Deploy**.
Re-running an existing deployment without a new version keeps serving the old code.

## Upgrading an existing sheet

Columns are matched **by name**, not by position — so you can reorder, rename or delete
columns and rows still land in the right place. Any column listed in `HEADERS` that the
sheet does not yet have is appended automatically the next time data arrives. You do not
need to clear the sheet or re-deploy the spreadsheet itself.

## Reading the sheet

Each row has a **Type** telling you what happened:

| Type | Meaning |
|---|---|
| `visit` | Someone opened the invitation. One row per open, so a guest who returns appears again with a higher `Total Opens` |
| `geo` | That same guest tapped the location chip, so `Location` is now filled in |
| `action` | A button tap — `Action` says `tap`, `Detail` names the button (`ics:all`, `share-open`, …) |
| `blessing` | They tapped "Send Your Blessings" — the blessing text is in `Detail` |
| `rsvp` | They submitted the form — `Message` and `Attending` are filled |

Because location is opt-in, a `visit` row usually arrives first with an empty `Location`,
and a `geo` row follows if the guest chooses to share it. Match rows on `Invited Guest`.

`Total Opens` counts how many times **that guest** has opened the invitation — it is stored
in their browser, so it survives closing the tab, and it is tracked per guest name in case
one phone is passed around the family. `Visit Count` is the count within a single session.

Filter the `Type` column to `action` to watch the whole journey — who opened it, whether
they switched language, downloaded the calendar, shared it, and how far they got.

**Who shared it to whom** is in the `Referral` column, e.g.
`Dharmendra Kumar Gupta & Family → Sharma Ji`. The same information is split across
`Sender` (who created the link), `Shared By` (who forwarded it) and `Invited Guest` (who it
was for).

**When** it was opened is in two columns: `Timestamp` is the server time in IST, and
`Local Time` + `Timezone` show the clock on the guest's own device — useful for spotting
someone opening the invite from abroad.

**Where** is in `Location` (only if they shared it) and, as a rough fallback, `Timezone`
and `Browser Language`.

## Columns

`Timestamp` · `Type` · `Invited Guest` · `Submitted Name` · `Relation` ·
`Family Invitation` · `Language` · `Attending` · `Number of Guests` · `Message` ·
`Location` · `Sender` · `Shared By` · `Device` · `Visit Count` · `Referral` ·
`Browser Language` · `Platform` · `Mobile` · `Screen` · `Viewport` · `Timezone` ·
`UTC Offset` · `Local Time` · `Referrer` · `Online` · `User Agent` · `Invitation URL` ·
`IP` · `IP Location` · `ISP` · `Total Opens` · `Action` · `Detail`

`Number of Guests` is reserved — the form does not currently ask for it, so it stays empty.
`Referrer` shows the site that sent them (often blank, since WhatsApp and most apps strip
it). `Invitation URL` is the exact personalised link that was opened, `?to=` and `from=`
included, so you can see which link each row came from.

`IP Location` is a **city**, worked out from the IP address — not the guest's exact
position. For a precise fix, look for a `geo` row, which only appears if the guest taps the
location chip. Guests on mobile data can appear in a different city than they are actually
in, and IPv6 addresses sometimes resolve less precisely than IPv4.

## What is collected, and how to turn it off

Everything below is switched from the `OWNER CONFIG` block at the top of the `<script>` in
`index.html`:

| Setting | Default | Effect |
|---|---|---|
| `TRACK_OPENS` | `true` | Master switch. `false` stops **all** logging |
| `TRACK_ACTIVITY` | `true` | One row per button tap |
| `TRACK_IP` | `true` | Guest's IP + city + ISP |
| `GEO_ON_OPEN` | `false` | `true` asks for GPS the moment the invitation opens |

**On IP tracking.** Apps Script cannot see the visitor's IP, so the page asks a third-party
service (`ipapi.co`, falling back to `ipinfo.io`, then `ipify`) and sends the answer along
with the row. That means each guest's IP address is disclosed to that service. Set
`TRACK_IP = false` to skip it entirely — everything else keeps working, the `IP` columns
just stay empty.

Free tiers are rate-limited (ipapi.co allows 1,000 lookups/day, ipinfo.io 50,000/month).
The service chain plus a bare-address fallback means a guest still gets logged even when
one is exhausted, but if you expect a very large number of opens on a single day, consider
setting `TRACK_IP = false` and relying on the timezone and opt-in GPS instead.

## Notes

- One row is written per open, so a guest who returns appears again with a higher `Total Opens`.
- Anything a guest types passes through a formula-injection guard before it reaches a cell.
- If every IP service is unreachable the row is still written — the `IP` columns are just blank.
