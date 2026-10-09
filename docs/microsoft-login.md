# «Mit Microsoft anmelden» (optional)

A second way onto the **same named accounts** the PIN tiles open. Added 09.10.2026
(`backend/app/auth/microsoft.py`). Nothing changes for a station that does not set it up: no
button, and both routes answer 404.

## What it does and does not do

- An Entra ID (Microsoft 365) sign-in becomes the session of an **existing** KP Front account,
  and only if the admin listed that Microsoft account against that username. It never creates a
  user and never changes a role. Deactivating the account, or resetting its PIN, ends Microsoft
  sessions too (same `auth_generation`).
- The PIN is never replaced. The kiosk tiles stay the way in on the tablet at the Schadenplatz.
  The Microsoft button needs a connection to Microsoft, so it is hidden while the device is
  offline. Nothing on the PIN path reads this module.
- It is **not** an admin login. `/admin` stays behind `ADMIN_SECRET`
  ([`roles-and-access.md`](roles-and-access.md)).

Flow: OIDC authorization code with PKCE (S256), confidential client. `GET
/api/auth/microsoft/start` keeps state, nonce and the PKCE verifier in a signed 10-minute cookie
scoped to `/api/auth/microsoft` (no table, no migration). It then redirects to the tenant's
`authorize` endpoint. `GET /api/auth/microsoft/callback` checks the state and redeems the code with
the verifier and the client secret. It validates the ID token: RS256 against the tenant's JWKS,
plus audience, issuer (that one tenant) and nonce. Then it maps the identity through the allow-list
and sets the normal session cookies. A refusal goes back to `/?msLogin=<reason>`, and the login
screen shows a sentence for it. The reasons are `cancelled`, `expired`, `failed`, `unknown` (not on
the list) and `inactive`. The server log names the `oid` and sign-in name of an unknown account,
so the admin can copy it onto the list.

## What to register in Entra (one-time, Azure portal)

Use a **separate** app registration. Do not reuse the SharePoint pull or the Ablage
registrations: those are app-only (client credentials) and must never sign a person in.

1. *Microsoft Entra ID › App-Registrierungen › Neue Registrierung*. Name e.g. «KP Front
   Anmeldung». *Unterstützte Kontotypen*: **nur Konten in diesem Organisationsverzeichnis**
   (single tenant). The app checks the issuer against this one tenant.
2. *Umleitungs-URI*: platform **Web**, URI `https://<your KP Front address>/api/auth/microsoft/callback`.
   For FWO: `https://front.fwo.li/api/auth/microsoft/callback`. It must match exactly. The app
   builds it from `PUBLIC_URL`, so set `PUBLIC_URL` to the same address. Without `PUBLIC_URL` it
   uses the request's own origin, which is what local development needs. For local development,
   also register `http://localhost:<vite port>/api/auth/microsoft/callback`.
3. *API-Berechtigungen*: nothing to add. The sign-in asks only for the OIDC scopes `openid
   profile` (delegated), which need no extra grant. The default delegated `User.Read` can stay or
   go; KP Front never calls Graph with this registration. No application permissions.
4. *Zertifikate & Geheimnisse › Neuer geheimer Clientschlüssel*. Copy the **value** (not the
   secret id). It is only shown once. Note the expiry date: Azure caps it at 24 months, and an
   expired secret makes the button answer «fehlgeschlagen» while the PIN keeps working.
5. Optional: under *Unternehmensanwendungen › <app> › Eigenschaften* set «Zuweisung
   erforderlich» and assign only the people who should get in. This adds a second gate in front of
   the allow-list.

## What to set in KP Front

`/admin › Anbindungen › Mit Microsoft anmelden`, or the same names in the environment (the
environment wins, as for every credential):

| Credential | Value |
| --- | --- |
| `ENTRA_LOGIN_TENANT_ID` | Directory (tenant) ID, a GUID |
| `ENTRA_LOGIN_CLIENT_ID` | Application (client) ID, a GUID |
| `ENTRA_LOGIN_CLIENT_SECRET` | the secret's **value** (write-only once saved) |
| `ENTRA_LOGIN_ACCOUNTS` | the allow-list: `identity=username` pairs, separated by commas, e.g. `anna.muster@feuerwehr.ch=amuster, 0b6c…-object-id=bkeller` |

The button appears once all four are set. The identity is matched against the token's `oid` (the
user's object id: stable, and the stronger choice) or its `preferred_username` (the sign-in name or
UPN). Both are compared case-insensitively. The username is the KP Front `username`
(`/admin › Benutzer`). Any active account can be listed. The role it signs in with is the
account's own.

⚠️ A sign-in name can be renamed in the tenant. The object id cannot be. Where it matters, list
the object id (Entra › Benutzer › <Person> › Objekt-ID).
