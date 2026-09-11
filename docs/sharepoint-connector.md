# SharePoint connector – setting it up at a station

Point KP Front at the SharePoint folders your brigade already keeps its documents in, and object
plans, geodata, checklists and the station workbook are imported on a schedule. **Read-only and
pull-only:** KP Front never writes to your SharePoint, and no code in it can.

This document is the setup afternoon, written for a volunteer who has never opened the Azure
portal. The reference for the config fields themselves is
[`CONFIGURATION.md` §6c](CONFIGURATION.md#6c-sharepoint-pull-the-stations-own-folders-imported-on-a-schedule).

**Contents**

- [What you need before you start](#what-you-need-before-you-start)
- [Step 1 – register an app in Azure](#step-1--register-an-app-in-azure)
- [Step 2 – give it permission to read](#step-2--give-it-permission-to-read)
- [Step 3 – create the client secret](#step-3--create-the-client-secret)
- [Step 4 – enter the three values in KP Front](#step-4--enter-the-three-values-in-kp-front)
- [Step 5 – lay out the folders](#step-5--lay-out-the-folders)
- [Step 6 – tell KP Front which folders](#step-6--tell-kp-front-which-folders)
- [Step 7 – run it once and read the result](#step-7--run-it-once-and-read-the-result)
- [Keeping it alive: the secret expires](#keeping-it-alive-the-secret-expires)
- [What the connector will not do](#what-the-connector-will-not-do)
- [When something is wrong](#when-something-is-wrong)

---

## What you need before you start

- **Somebody with tenant admin rights in your Microsoft 365 organisation.** Registering an app
  is a two-minute job, but granting the permission needs an admin's consent. If that is not you,
  this is the one part to arrange in advance – it is what turns a 20-minute setup into a
  three-week one.
- The **address of the SharePoint site** the documents live on, copied out of a browser's URL
  bar: `https://contoso.sharepoint.com/sites/feuerwehr`.
- Access to `/admin` on your KP Front deployment (the deployment admin secret).

Set aside an hour the first time. Nothing here has to be done in one sitting: the credentials
and the folders are two independent halves, and KP Front tells you which one is missing.

---

## Step 1 – register an app in Azure

An "app registration" is how Microsoft lets a program – here, your own KP Front server – read
data from your organisation without anybody logging in. It gets its own identity, its own
permission, and nothing else in your tenant changes.

1. Go to [portal.azure.com](https://portal.azure.com) and sign in with the admin account.
2. Search for **App registrations** in the top search bar and open it.
3. **New registration**.
4. **Name:** something a successor will recognise – `KP Front – Stationsdaten`.
5. **Supported account types:** *Accounts in this organizational directory only*. This app is
   yours and is used by nobody else.
6. **Redirect URI:** leave it empty. KP Front never sends anybody to Microsoft to log in; it
   authenticates as itself.
7. **Register**.

You land on the app's **Overview** page. Two values there are the first two of the three you
will need – write them down now:

| On the page | Called in KP Front |
|-------------|--------------------|
| **Directory (tenant) ID** | Azure Tenant-ID |
| **Application (client) ID** | Azure Client-ID |

Both look like `3f2504e0-4f89-41d3-9a0c-0305e82c3301`. If what you copied is not a string of
hex digits with dashes, it is the wrong field – KP Front will refuse it and say so.

---

## Step 2 – give it permission to read

Two options. Prefer the first; the second is documented because on some tenants the first is
genuinely fiddly and a volunteer should not be blocked by it.

### Option A (preferred): `Sites.Selected` – one site, read-only

The app is granted access to **exactly the one site** you nominate, and nothing else in the
tenant. This is the least privilege that does the job.

1. In the app registration → **API permissions** → **Add a permission**.
2. **Microsoft Graph** → **Application permissions**.
3. Search for `Sites.Selected`, tick it, **Add permissions**.
4. **Grant admin consent for &lt;your organisation&gt;** – the button above the table. Until this
   is pressed the permission is requested, not granted, and the connector will report an
   authentication failure.
5. Then somebody has to say **which** site, which the portal has no UI for. A tenant admin does
   it once from PowerShell:

   ```powershell
   Install-Module Microsoft.Graph -Scope CurrentUser        # first time only
   Connect-MgGraph -Scopes "Sites.FullControl.All"

   $site = Get-MgSite -Search "feuerwehr"                   # find the site
   New-MgSitePermission -SiteId $site.Id -BodyParameter @{
     roles = @("read")                                      # READ. Never "write".
     grantedToIdentities = @(@{ application = @{
       id          = "<Application (client) ID from step 1>"
       displayName = "KP Front – Stationsdaten"
     }})
   }
   ```

   `roles = @("read")` is the whole point of this route. Grant nothing else: KP Front has no
   code that writes, so a write role would be a permission nobody uses and everybody inherits.

### Option B (fallback): `Files.Read.All`

If per-site consent cannot be arranged, grant **`Files.Read.All`** (Application permission) the
same way as steps 1–4 above. It is read-only across the tenant, which is broader than this
connector needs – so treat it as a temporary measure and write down in the station's own notes
that it is one.

---

## Step 3 – create the client secret

The secret is the app's password. Microsoft shows it **once**.

1. App registration → **Certificates & secrets** → **Client secrets** → **New client secret**.
2. **Description:** `KP Front` and the year, so the next person knows what they are looking at.
3. **Expires:** pick the longest your organisation's policy allows – 24 months is the maximum.
4. **Add**.
5. Copy the **Value** column immediately. Not the "Secret ID" – the *Value*. Once you navigate
   away it is gone for good and you have to create a new one.
6. **Write down the expiry date.** You will enter it into KP Front in the next step, and it is
   the single most useful thing you do today. See
   [Keeping it alive](#keeping-it-alive-the-secret-expires).

---

## Step 4 – enter the three values in KP Front

Open `/admin` on your deployment → **Zugangsdaten** → the **SharePoint (Stationsdaten)** group.

| Field | What to paste |
|-------|---------------|
| Azure Tenant-ID | Directory (tenant) ID from step 1 |
| Azure Client-ID | Application (client) ID from step 1 |
| Azure Client-Secret | the **Value** from step 3 |
| Client-Secret läuft ab | the expiry date as `JJJJ-MM-TT`, e.g. `2028-03-31` |

The secret is **write-only**: once saved, KP Front will never show it again – it can be replaced,
not read. The two ids stay readable on purpose, so you can compare them against the Azure portal
when something looks wrong. They are stored encrypted in the deployment's database.

Everything here takes effect **without a restart**.

---

## Step 5 – lay out the folders

Inside whatever folder you nominate for an area, the naming is the convention. It is deliberately
plain: the folder and the file names carry everything, and there is no manifest to maintain and
no script to run on your side. **In most cases that means leaving the folders exactly as they
are** – the names a brigade already gives its scans are the names KP Front reads.

### Objektpläne

```
<the folder you configure>/
  Hauptstrasse 24 - Gemeindeverwaltung/    ← the folder name IS the object's key
    Modul 1.pdf
    Modul 2-3.pdf
    Modul 5 - Wasser.pdf
    Vertrag/                               ← ignored: a plan lives one folder deep
  Föhrenstrasse 17/
    Modul 1.pdf
```

- **One folder per Einsatzobjekt**, one PDF per Modul slot. **You do not have to rename
  anything:** which slot a PDF belongs to is decided by your own station's `match` rules in the
  `modules` catalogue (deployment config, `/admin` → Station shows it), tested against the file
  name without regard to case – the first module that matches claims the file. The defaults
  every station starts from already recognise `Modul 1.pdf`, `modul1.pdf`, `Modul 2-3.pdf` and
  the rest.
- **Modul 5 is generative.** Its rule captures whatever follows the dash, so `Modul 5 - PV.pdf`
  becomes `modul5-pv` and `Modul 5 - Evak.pdf` becomes `modul5-evak` – **without** either
  needing its own entry in the catalogue. The Objektpläne page shows a slot for every such plan
  it finds.
- A PDF **no rule claims** – a `Begehungsprotokoll 2024.pdf` filed beside the plans – is skipped
  and logged. Nothing is invented for it.
- A deployment whose catalogue carries **no `match` rule at all** imports no plans and says so
  on the System card: without it nothing can tell a Modul-PDF from any other document.
- ⚠️ **Two files, one slot.** If two PDFs in the same folder resolve to the same slot, **neither**
  is imported and the System card asks for a person – importing one would silently overwrite the
  other. The usual cause is a Modul-5 rule whose capture stops too early, so that
  `Modul 5 - Wasser 1.pdf` and `Modul 5 - Wasser 2.pdf` both read as `modul5-wasser`. The fix is
  in the config, not in the folder: the shipped default rule already takes the trailing number.
- The folder name is the object's **stable key** – use it as it reads on the door
  (`Hauptstrasse 24 - Gemeindeverwaltung`); spaces, case and umlauts are all fine. Rename the
  folder and KP Front will treat it as a different object, so pick it once.
- **A folder whose files are not Modul plans never becomes an Einsatzobjekt.** A category folder
  full of overview sheets (`Grosspläne/`) or an empty one is skipped whole, and nothing is
  created for it. Say so up front with `ignore` (below) – this is only the safety net.
- Loose files at the top level (`Alle Modul 6.pdf`) and anything nested deeper than one folder
  (`.../Vertrag/Mietvertrag.pdf`) are left alone.
- On the first sync an object KP Front has never seen is created, named after the folder. Rename
  it and give it an address in `/admin` → Objektpläne afterwards; the connector never overwrites
  a name or an address anybody has typed.
- The same key produces the same object as the `admin_objects` CLI would, so a station that has
  been loading plans by hand and now switches to SharePoint **updates** its objects rather than
  duplicating them.

### Geodaten

```
<the folder you configure>/
  hydranten.geojson
  hydranten.json               ← optional: how the layer draws
  leitungskataster.geojson
```

The GeoJSON must be a `FeatureCollection` in **WGS84 `[lng, lat]`** – a projected LV95 export is
refused rather than drawn somewhere off the coast of Africa. The optional sidecar carries what a
file name cannot:

```jsonc
{
  "label": "Hydranten",              // shown in the Ebenen panel
  "group": "Wasser",                 // groups it with other layers
  "icon": "drop",
  "vectorKind": "point",
  "symbol": "SI Ueberflurhydrant",
  "color": "#0f52b5",
  "nightColor": "#5b9bff",
  "opacity": 80,
  "maxzoom": 18,
  "attribution": "© Wasserversorgung Musterdorf",
  "autoActivate": ["Brandbekämpfung"]   // switch this layer on for these Einsatz categories
}
```

Layers loaded from a geodata manifest (the canton's WMS, for instance) are **kept** – the
connector merges its own layers in beside them and never replaces the list.

### Checklisten

```
<the folder you configure>/
  fu-aktion.json               ← a ChecklistTemplate; its "id" must equal the file name
  el-playbook.json
  el-playbook-p12.jpg          ← a diagram: <template>-p<page>.jpg|png|webp|svg
  el-playbook-p14.jpg
```

A `.json` whose `id` does not match its file name is ignored – that is what keeps a stray
`notizen.json` out of the checklist rail.

### Arbeitsmappe

```
<the folder you configure>/
  stationsdaten.xlsx           ← exactly one .xlsx in the folder
```

Download the current one from `/admin` → Stationsdaten, edit it, put it back in this folder.
Two `.xlsx` files in one folder is a question, not a guess: the connector stops and says so.

---

## Step 6 – tell KP Front which folders

The folders are part of the deployment config document, not a form. **Every area is independent:**
different sites, different libraries, different paths, and any area you do not have is simply not
listed. There is no required root folder.

```jsonc
"sharepoint": {
  "intervalMinutes": 60,
  "sources": [
    { "area": "plans",      "siteUrl": "https://contoso.sharepoint.com/sites/kommando",
      "path": "Einsatzpläne", "ignore": ["Grosspläne", "Archiv"] },
    { "area": "geodata",    "siteUrl": "https://contoso.sharepoint.com/sites/gis",
      "library": "Geodaten", "path": "export/wgs84" },
    { "area": "workbook",   "siteUrl": "https://contoso.sharepoint.com/sites/kommando",
      "path": "Stationsdaten" }
  ]
}
```

- `siteUrl` is the site address out of the browser's URL bar. KP Front resolves it to the
  document library itself.
- `library` is only needed when the documents are **not** in the site's default library
  ("Dokumente" / "Documents"). It is the library's display name.
- `path` is the folder inside that library; leave it out for the library root.
- `ignore` lists the **sub-folders KP Front should walk past**, for the folders that live in
  the same place but are not station data – a `Grosspläne` category folder among the
  Einsatzobjekte, an `Archiv`, a `Vorlagen`. Write the names exactly as SharePoint shows them
  (upper/lower case does not matter); they are folder **names** directly under `path`, not
  paths, and not patterns – `Archiv*` matches a folder literally called `Archiv*` and nothing
  else. Leave it out entirely if there is nothing to skip.
- **At most one entry per area.** A folder listing is read as the complete statement of what that
  area holds – see [What the connector will not do](#what-the-connector-will-not-do) – and two
  half-statements cannot be told apart from one broken one.

Apply it the way you apply any config change, from `backend/` (or prefixed with
`docker compose exec app` on a Docker-only host):

```bash
uv run python -m app.admin_config show > station.json     # start from what is stored
# …add the "sharepoint" block…
uv run python -m app.admin_config validate station.json
uv run python -m app.admin_config diff station.json       # read this before loading
uv run python -m app.admin_config load station.json
```

---

## Step 7 – run it once and read the result

`/admin` → **System** → **SharePoint-Anbindung** → **Jetzt abgleichen**.

You get one row per configured area:

| Column | What it means |
|--------|---------------|
| Bereich | the area and the folder it is reading |
| Status | see the table under [When something is wrong](#when-something-is-wrong) |
| Zuletzt erfolgreich | when this area last completed – **not** when it last tried |

That last distinction is the point of the card. A connector that has been failing for a week
still runs every hour; only the *successful* timestamp tells you it stopped.

After that it polls by itself, at `intervalMinutes`. Nobody has to press anything again.

---

## Keeping it alive: the secret expires

This is the failure this connector will have, and it will have it about two years from the day
you set it up. Azure caps a client secret at 24 months, does not renew it, and warns nobody when
it lapses. Graph starts answering "unauthorised", the plans on the tablets are quietly the ones
from before, and everything looks normal.

Two things stand between you and that:

1. **The expiry date you entered in step 4.** The System card counts down from 60 days out and
   goes red the day it passes. Enter it. It is one field.
2. **A calendar entry** in whatever the station actually reads – the Kommando's shared calendar,
   the annual Offiziersrapport agenda – for two months before that date.

Renewing is step 3 again: create a **new** client secret, paste the value and the new expiry into
`/admin` → Zugangsdaten, then delete the old secret in Azure. Nothing else changes; the app
registration, the permission and the folders all stay as they are.

---

## What the connector will not do

These are guarantees, not current behaviour that might change:

- **It never writes to SharePoint.** There is no write code in it at all.
- **A broken listing never empties anything.** If a folder that previously held twelve plans
  suddenly lists none, the run is **refused** and nothing changes – the far likelier cause is a
  renamed folder or a revoked permission than a decision that the crew should no longer have
  those plans. The area reports «abgelehnt – nichts geändert» until the folder makes sense again.
- **Deleting a file does not delete a record.** A file that disappears is reported as *missing
  from source* on the System card and its record stays exactly where it was. Removing an
  Objektplan for good is done in `/admin`, by a person.
- **The workbook keeps its confirmation.** The import that runs unattended is the same one the
  admin page runs, with one extra rule: if the file would refuse a row, empty a config section or
  deactivate anybody, it is **not applied**. The area reports «wartet auf Freigabe» and a person
  opens `/admin` → Stationsdaten and decides. Upsert-only, all-or-nothing, exactly as before.
- **It does not import branding, alarm keywords, the module catalogue or personnel.** Those are
  set once and stay where they are ([`CONFIGURATION.md`](CONFIGURATION.md)).

---

## When something is wrong

The status on the System card, and what it means:

| Status | What happened | What to do |
|--------|---------------|------------|
| **noch nie gelaufen** | configured, but no sync has completed yet | press «Jetzt abgleichen» |
| **aktuell** / **unverändert** | working. «unverändert» is what almost every poll finds | nothing |
| **wartet auf Freigabe** | the Arbeitsmappe would do something that needs a person – or two Objektplan PDFs claim the same Modul slot, or no module carries a `match` rule | Arbeitsmappe: `/admin` → Stationsdaten, preview and confirm. Objektpläne: the row names the clashing files; fix the module's `match` in the config |
| **abgelehnt – nichts geändert** | the folder listed nothing for an area that had something | check the folder still exists, is not renamed, and the app still has access to the site |
| **nicht erreichbar** | the folder or the site could not be read | check `siteUrl`, `library` and `path` in the config; a renamed folder shows up here |
| **Anmeldung abgelehnt** | Azure refused the app registration | the row prints Microsoft's own message. `AADSTS7000222` = the client secret has **expired** (step 3 again). `AADSTS7000215` = wrong secret. A 403 from Graph = the permission was never consented to, or `Sites.Selected` was never pointed at this site (step 2) |
| **Fehler** | something else | the row carries the detail; the server log carries more |

**"The file is in SharePoint and the app still shows the old one."** Press «Jetzt abgleichen»
first. If it persists, a full re-import is available over the API and forgets everything the
connector recorded about what it already has:

```bash
BASE=https://front.example.org
curl -sc /tmp/kp.jar -X POST -H 'Content-Type: application/json' \
     -d "{\"secret\": \"$ADMIN_SECRET\"}" "$BASE/api/admin/login"
curl -sb /tmp/kp.jar -X POST "$BASE/api/sharepoint/sync?full=true"
rm /tmp/kp.jar
```

**"It says «aktuell», but plans are missing."** Read the *übersprungen* count on the row: every
skip is one line in the server log saying which file and why. The common ones are a PDF no
`match` rule recognises, a folder that holds no Modul plan at all – which is deliberately **not**
turned into an Einsatzobjekt – and a Modul-5 sub-slot whose name is so long that the generated
slot would not fit (shorten what follows the dash). If the folder is a category folder, put its
name in the source's `ignore` list so the log stops mentioning it.

**"A building shows up twice in Objektpläne."** Two folder names that differ in any way – a
trailing word, a different spelling – are two objects, because the folder name is the key. Merge
them in SharePoint, then fix up the leftover object in `/admin` → Objektpläne.

**Nothing appears on the System card at all.** Either no credentials or no folders – the card
says which half is missing, and the two are configured in different places (step 4 vs step 6).
