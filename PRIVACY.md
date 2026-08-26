# Privacy

KP Front is self-hosted. Your incident data, your roster, your map cache and your media live on
**your** server and are never transmitted anywhere by this software. There is no cloud account,
no licence check, no usage beacon, and no "phone home" on start-up.

This document covers the one exception: the two channels through which a station can *choose* to
send something to the maintainer. Both are off or manual by default. If you never touch them,
nothing about your installation ever reaches us — you can verify that with `tcpdump`, and
several of the tests in this repository exist to prove it stays true.

Separately, and unrelated to any installation, the project's public website has a contact form.
That is a website, not the app — see [The project website](#the-project-website) at the end.

## Map and address services are a separate matter

Nothing above is about the **map**. Drawing a map means asking somebody for map data, and four
of those requests carry a location:

| Service | What leaves | Who it goes to | Turn it off |
|---|---|---|---|
| Basemap tiles | the map tiles you are looking at, i.e. roughly where you are working | the configured tile provider, **from the browser** (so it can cache them) | choose a different `map.bases` entry, or self-host tiles |
| Building outlines («Umrisse») | a bounding box around the incident | public [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) mirrors, **from the server** | `OVERPASS_MIRRORS=` (empty disables the surface) or point it at your own Overpass |
| Address search / geocoding | the text you type, or a clicked coordinate | the configured geocoder (swisstopo by default), **from the server** | `GEOCODER_URL` |
| Weather / wind | the incident coordinate for the point-based weather code and fallback; MeteoSwiss observation downloads themselves are national, not point queries | [Open-Meteo](https://open-meteo.com/), **from the server** | `OPEN_METEO_URL=` (empty disables weather) |

These are ordinary third-party services, not a channel to the maintainer, and none of them
receives names, roster, attendance or journal text — only a location. The shipped Overpass
mirror list includes one host in Russia (`maps.mail.ru`, a long-standing public mirror); a
station that would rather not use it sets `OVERPASS_MIRRORS` to the other two.

## Forms your own Wehr links from the Rapport

A station can put its own paperwork on the Rapport as a list of links – the Getränkeabrechnung
for the Gemeinde, a Schadenmeldung, an internal form (`report.links`, see
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) §1d). **Nothing here is on by default:** a
deployment that configures no links has no such section, and this whole page does not apply to
it.

Where a station does configure one, two things are worth being deliberate about:

- **A link can carry incident data to whoever hosts the form.** The URL may contain placeholders
  the app fills in when the link is opened, and those include the incident address, the
  Einsatzleiter and Kontaktperson by name, and the free-text Kurzbericht – which in this line of
  work often describes what was found at an address. That data travels **in the URL**, from the
  browser, to the form's host: its logs, and the device's own browser history. If the form is a
  Google Form, the host is Google. The app opens the link with `noreferrer`, which is beside the
  point here – the data is the address being requested, not the referrer.
- **The configured links are readable by everyone who can sign in.** They are withheld from
  anonymous callers of the app's otherwise-public `/api/config`, but any PIN session can read
  them – which is right, because the Rapport that shows them is behind the same PIN. So this is
  not a secret store: a form id is a capability, whoever knows it can submit to that form, and it
  lands in the browser history of every device that opens it. Do not put a token, key or secret
  path in a link, and prefer a form your own organisation restricts over one that is open to
  whoever has the address.

Neither of these sends anything to the maintainer, and neither is affected by the telemetry
switch below — this is your Wehr's own configuration talking to your Wehr's own choice of form
provider. It is documented here because it is the one place in the app where incident text can
leave the instance without an operator realising it.

## Sharing your own location during an Einsatz

One feature has a person's phone report where that person is: **Standort teilen**. It exists so
the command post can see where the crew is working — someone sent on a Wassertransport or a
Zubringerleitung is kilometres away on purpose, and the alternative is phoning around to find
out. It is not attendance control, and nothing in the app flags, warns about or scores distance.

It stays on your own server: the position goes to the same backend that serves the app and
nowhere else. Beyond that, the rules are deliberately narrow.

| | |
|---|---|
| Who decides | The person holding the phone. Nobody can switch it on for somebody else. |
| How | Asked once per device — agree, pick your own name from the roster, and it resumes automatically at later Einsätze until you switch it off. Declining is remembered too. |
| When | Only while an Einsatz is open, and only while the app is actually in the foreground. A locked phone reports nothing; the last position simply ages, and the command post sees how old it is. |
| Who sees it | Signed-in editor and viewer accounts — the command post. Someone who merely tapped the Einsatz-Link on their own phone can *send* their position and can read **nobody else's**. This is enforced server-side, not in the UI. |
| What is stored | One row per person per Einsatz: name, coordinates, accuracy, time. It is overwritten on every update, so no track of anyone's movements is ever built. |
| How long | Until the Einsatz is closed, which deletes it. A position that goes untouched is swept anyway (`POSITION_TTL_HOURS`, default 6). Stopping deletes it at once. |
| Where it does *not* appear | The Verlauf, the audit trail, the Einsatzrapport, the statistics export. It is display data, not part of the record. |
| Public demo | Off entirely. |

Turning off sharing on the phone removes the position immediately — it does not merely stop
updating it.

Everything below is about the maintainer channels.

## The short version

| | Manual report | Background error reports |
| --- | --- | --- |
| Who starts it | An operator, by pressing **Senden** | The app, after a crash |
| Default | Always available | **Off** |
| Consent | Pressing the button | An admin switches it on in **System & Wartung** |
| Can be disabled entirely | Yes, `KP_TELEMETRY_ENABLED=0` | Yes, same switch |
| Content | The text they typed, plus the technical block they read first — and a photo, if they attached one by hand | A sanitised crash |

## What is sent

Both channels send the same **context block** and nothing else besides it:

| Field | Example | Why |
| --- | --- | --- |
| `install` | `9f1c…` (random UUID) | So two reports from the same station are recognisably the same station |
| `app` | `kp-front` | Which of the two apps |
| `release` | `0.2.0+a1b2c3d` | The single most useful field in any bug report |
| `device` | `iPad Safari` | A rendering bug is usually a browser bug |
| `viewport` | `1024×768` | A layout bug is a viewport bug |
| `locale` | `de-CH` | Which copy catalogue was active |
| `online` | `true` | Whether the tablet had a connection |

A manual report adds the operator's own text and which trouble prompted it. A background error
report adds the exception type, a scrubbed message, a stack reduced to function names and module
basenames, and the route shape.

### The one exception: a photo you attach yourself

A manual report — and only a manual report — can carry **up to two photos, and only ones you
picked yourself** in the Rückmeldung sheet. This is the single place where something leaves that
the sanitiser cannot read: there is no allow-list for pixels and no way to scrub a picture, so
that job falls to you instead, which is why it works the way it does:

- **The app never captures a screen.** There is no code path that takes a screenshot, and there
  is no automatic capture anywhere in either channel. You open a file picker or the camera.
- **You see it before you decide.** The photo is shown as a thumbnail directly under *«Das wird
  mitgeschickt»*, above the send button, next to the technical block it belongs to.
- **It travels on the direct-send route only.** *Kopieren* and *E-Mail* cannot carry a file and
  say so; on a deployment with `KP_TELEMETRY_ENABLED=0` the option is not offered at all.
- **It is shrunk in your browser first**, to at most 1600 px on the long edge and 360 kB, and
  re-encoded — which also strips the EXIF block, so the GPS position a phone stamps into its
  photos does not travel with it. A picture that cannot be made to fit is refused there and then,
  not silently dropped later.
- **It is in your log and your database like everything else** (see below): the photo rides
  inside the payload, so the two copies you can inspect are complete.

Removing a photo before sending removes it. Nothing about it is kept on the device.

## What is never sent

Not "we try not to send" — these are constructed out of the payload and asserted by tests
(`backend/tests/test_telemetry_scrub.py`):

- **Incident data of any kind**: addresses, coordinates (WGS84 *and* LV95), incident IDs, object
  names, journal text, drawings, audio, plan files. No incident medium is ever read by this
  code — the only picture that can travel is one you attached by hand, above.
- **People**: roster names, functions, phone numbers, e-mail addresses, Divera identities, PINs.
- **Your instance**: hostname, station name, deployment config, database contents, file paths,
  usernames, environment variables, tokens, secrets.
- **Network identity**: no IP address is placed in the payload, and no `user` object exists for
  one to appear in later. See "The IP question" below for the part we cannot solve in code.
- **Screenshots.** There is no code path that captures one. A photo *you* pick in the
  Rückmeldung sheet is a different thing, and it is the only thing of its kind — see above.

The payload is built by an **allow-list**: every field is named in
`backend/app/telemetry/scrub.py` and the caller's object is never forwarded, merged or spread.
A field nobody wrote a line of code for cannot leak. Free text is additionally scrubbed, because
the value is often *inside* the message — `TypeError … at Hauptstrasse 12` is a real shape.

## How to check, rather than trust

You do not have to take any of the above on faith:

1. **Your own log.** Every payload is written to your server's log in full, at `INFO`, *before*
   it is sent. Look for `telemetry: queuing … exact content follows`.
2. **Your own database.** The same payload stays verbatim in the `telemetry_outbox` table.
   `SELECT payload_json FROM telemetry_outbox;` is the whole story, before and after delivery.
3. **The admin screen.** *System & Wartung → Fehlerberichte* shows the same rows, newest first,
   as formatted JSON.
4. **The manual report** shows you the technical block before you send, and — after sending —
   what the server says it actually queued. An attached photo appears there as its type and
   size rather than as a page of base64: you have already seen the picture itself, in the
   thumbnail, and the full bytes are in the two copies above.

## Where it goes

To `ingest.kp-front.ch`, a GlitchTip instance run by the maintainer. GlitchTip is an
open-source, Sentry-compatible error tracker.

It runs in its own Railway project, with its own database, sharing nothing with the KP Front
or KP Rück deployments. The honest limit of that: it is the same provider and the same
account, so this is project-level isolation, not host-level — a compromise of the maintainer's
Railway account would reach it. Its full configuration is checked in at
[`deploy/ingest/`](deploy/ingest/), including what it does *not* do.

The credential embedded in this repository (`backend/app/telemetry/dsn.py`) is a Sentry **public
key**. It is write-only by construction: it can submit an event and nothing else — it cannot
read stored events, cannot reach another project, and cannot log in. It is checked in in the
clear deliberately, so that anyone auditing this repository finds it and can satisfy themselves
in thirty seconds that it does not read their data.

**Retention:** reports are kept for 90 days and then deleted. Delivered rows in your own outbox
are swept after 14 days (yours to change).

## Your choices

- **Never send anything.** Do nothing. This is the default state of a fresh install and of every
  instance that upgrades into this version.
- **Enforce it centrally.** Set `KP_TELEMETRY_ENABLED=0` in your compose file. This outranks the
  admin switch, so no later click can turn it on.
- **Point it at yourself.** Set `KP_TELEMETRY_DSN` to your own GlitchTip and the same machinery
  reports to *your* server. We never hear from you.
- **Unlink your history.** *System & Wartung → Neue Kennung* mints a fresh install UUID. Reports
  we already hold keep the old one and can no longer be connected to anything you send after.
- **Ask for deletion.** Mail the install UUID to bastian@eichenbergers.ch and everything under
  it is deleted. You do not have to explain why.

## The IP question

Your server's IP address is visible to our ingest host, the same way it is visible to any server
you make a request to. We do not put it in the payload; the reverse proxy in front of GlitchTip
strips `X-Forwarded-For` and friends before the request reaches the app, and its access log is
configured to drop the remote address. That configuration is checked in — read
[`deploy/ingest/railway/Caddyfile`](deploy/ingest/railway/Caddyfile) rather than believing this
paragraph.

What you *cannot* verify from here is that the running instance matches the checked-in config,
or what the hosting platform logs at its own edge. That is exactly why
`KP_TELEMETRY_ENABLED=0` exists and why the default is off. If your threat model includes the
maintainer's own infrastructure, do not switch this on — that is a legitimate position and the
app is fully functional without it.

## The project website

`kp-front.ch` is the project's landing page. It is **not** part of the software and has nothing
to do with your installation: it is a handful of static files on GitHub Pages. It makes exactly
two requests to anything of ours — a visit count (below) and, if you submit it, the contact form
— and it never talks to a station's server.

It carries one contact form (name, e-mail, message). Submitting it sends those three fields to
**staticforms.dev**, which forwards them to the maintainer by e-mail. Static hosting cannot
accept a form post, so a third party does that step. The service therefore processes what you
type, plus the usual request metadata a web server sees (including your IP address); its own
terms and retention apply, and we have no agreement with it beyond an ordinary account.

Three things follow, and they are the point of this section:

- **Using the form is entirely optional.** `bastian@eichenbergers.ch` reaches the same person
  without a third party in between. The form exists because a `mailto:` link does nothing on a
  duty phone with no mail client configured — not because we prefer it.
- **It is a website visitor's data, never a station's.** No incident data, roster, or anything
  from a running instance is involved. A deployed KP Front never contacts this service.
- **Self-hosters are unaffected.** The landing page is not shipped in the Docker image and is not
  served by the app. If you host this software, none of the above applies to your deployment.

### Counting visitors without recognising them

We want to know two things: whether anybody reads the landing page, and which parts of the
public demo at `demo.kp-front.ch` people actually try. Both are counted by our own backend —
there is no analytics provider, no tracking script and no consent banner, because there is
nothing here to consent to.

**How.** Opening a page sends one small request to the demo server naming which page it was
(the language, or «404»). Inside the demo, switching to a section — Lage, Plan, Atemschutz,
Anwesenheit, Mittel, Rapport — sends the section's name the same way. That is the entire
payload: no identifier, no cookie, nothing written to your browser's storage, nothing about
what is on the screen.

**What is stored.** Counters, and only counters: one row per day, per kind, per name, holding
a number of visits and a number of visitors. There is no table of individual visits anywhere
in the design, so «what did this person look at» is not a question the database can answer —
not for us, and not for anyone who obtains it.

**How visitors are counted without a cookie.** Your IP address and browser string are hashed
together with a secret salt that is derived fresh for each calendar day and never written
down. The hash decides whether you have already been counted *today*, and then that is all it
can ever do: tomorrow's salt is a different one, and yesterday's no longer exists, so two days'
records cannot be linked — by us or by anybody else. The IP address itself is never stored and
never logged.

**Referrers.** If you followed a link here, we count the *hostname* it came from, so we can see
where people hear about the project. The path and query string of that address stay in your
browser.

**On your own installation this is switched off, permanently.** Your deployment runs the same
code, but the counters need `VISIT_STATS=true`, which is set on the public demo and nowhere
else — unset means nothing is counted at all, not that counting happens locally. The landing
page's request goes to the demo host, so a station's server is not involved in it either.

The mechanism is [`backend/app/visits.py`](backend/app/visits.py) and the browser's half is the
short block at the bottom of [`site/index.template.html`](site/index.template.html) — read those
rather than believing this section.

## Legal

Your fire service is the data controller for everything in its instance. Switching on background
error reports makes the maintainer a recipient of the (sanitised, non-personal) data described
above. That decision belongs to the organisation, which is why the switch lives behind
`ADMIN_SECRET` and not in the operator's settings sheet — and why nothing is enabled by an
upgrade.

Questions, or a deletion request: **bastian@eichenbergers.ch**.
