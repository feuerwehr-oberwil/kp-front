# Objektbesuche – filing visits into SharePoint

The optional **Objektbesuche** module ([`object-visits.md`](object-visits.md)) can file a copy of
every visit – the readable report, the structured JSON, the photos and the history – into a
SharePoint folder, next to the object's plans. KP Front keeps the record; the folder only
receives copies, one way. **Nothing remote is ever deleted**: a photo removed later is moved to
`Entfernt/`, a discarded draft gets a last report stamped VERWORFEN.

This is the one place KP Front **writes** to SharePoint, so it has its own app registration and
its own credentials. The station-data importer ([`sharepoint-connector.md`](sharepoint-connector.md))
stays read-only and its registration is never used here.

## 1 – a second app registration, with write on one site

Follow [`sharepoint-connector.md` step 1](sharepoint-connector.md#step-1--register-an-app-in-azure)
once more, with a different name (`KP Front – Ablage Objektbesuche`). Then grant
**`Sites.Selected`** (Application permission, admin consent) and nominate the ONE site, this time
with `write`:

```powershell
Connect-MgGraph -Scopes "Sites.FullControl.All"
$site = Get-MgSite -Search "feuerwehr"
New-MgSitePermission -SiteId $site.Id -BodyParameter @{
  roles = @("write")                                      # write on THIS site only
  grantedToIdentities = @(@{ application = @{
    id          = "<Application (client) ID of the Ablage registration>"
    displayName = "KP Front – Ablage Objektbesuche"
  }})
}
```

Create a client secret ([step 3](sharepoint-connector.md#step-3--create-the-client-secret)) and
note its expiry.

## 2 – the three values in KP Front

`/admin` → **Zugangsdaten** → group **SharePoint-Ablage** (`sharepoint_export`):
«Azure Tenant-ID (Ablage)», «Azure Client-ID (Ablage)», «Azure Client-Secret (Ablage)».
Like every credential they are encrypted at rest and the secret is write-only.

## 3 – the destination in the station config

```jsonc
"objectVisits": {
  "enabled": true,
  "destinations": [{
    "id": "sharepoint-fu", "kind": "sharepoint", "enabled": true,
    "timing": "every-sync",                       // or "completed": only finished visits
    "siteUrl": "https://fwoberwil.sharepoint.com/sites/FWO", "library": "Dokumente",
    "root": "FÜHRUNGSUNTERSTÜTZUNG/Einsatzpläne",
    "objectFolder": "{object.folder}",
    "visitFolder": "Objektbesuche/{date} {checklist} ({short})"
  }]
}
```

`root` must already exist. Below it, the object folder (the folder the object's plans already
use, when KP Front knows it) and the visit folder are created as needed. The plan import reads one
level deep, so an `Objektbesuche/` sub-folder never becomes an Einsatzobjekt.

```
Einsatzpläne/
  Hauptstrasse 24 - Gemeindeverwaltung/          ← the object's plan folder (untouched)
    Objektbesuche/
      2026-10-03 Kontrolle Schlüsselhülse (7f3a)/
        Objektbesuch.pdf · Objektbesuch.json      current report + data
        Fotos/01 Schlüsselhülse geöffnet (a91c).jpg …
        Verlauf/r1 2026-10-03 0912.pdf · .json …  every filed revision
        Entfernt/                                 photos a later revision removed
```

## 4 – test, then watch

`/admin` → Objektbesuche → **Verbindung testen** (`POST /api/admin/object-visits/destinations/{id}/test`)
uploads one `_kp-front-test.txt` into `root` and shows Graph's answer – delete the file by hand
afterwards. The delivery list (`GET /api/admin/object-visits/deliveries`) shows every visit's
state: `pending` (waiting or backing off: 1 min → 6 h after a throttle or an outage), `delivered`,
`failed` (401/403/404 – a permission or a path a person has to fix; it waits for «Erneut
versuchen», a config change or new credentials), `paused` (destination switched off – kept, and
resumed from where it stopped when switched on again).
