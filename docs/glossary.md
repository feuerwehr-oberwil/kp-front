# Glossary — German domain terms

German is the **canonical domain language** of KP Front (see [CLAUDE.md](../CLAUDE.md)): UI
copy, identifiers, and docs use the Swiss fire-service terms on purpose, because the
operators think in them. This glossary exists so non-German contributors can *read* the
code and copy — it is **not** a license to rename anything to English.

| Begriff | English | What it is in this app |
| --- | --- | --- |
| **Lage** | situation | The live situation map — the app's main surface (tab «Lage», map mode in `appConfig.copy.modes`; rendered by `src/components/MapView.tsx`). |
| **Plan** | plan (whiteboard) | The plan whiteboard tab: drawing on Objektplan pages / blank boards with per-plan undo (`useBoardDoc`). Kept in feature parity with Lage. |
| **Einsatz** | incident, operation | One deployment/callout — the unit everything hangs off (incident + workspace blob, `src/lib/incidents.ts`). «Alle Einsätze» = the incident list. |
| **Verlauf** | log, operational journal | The append-only journal of the incident: human entries plus selected system events. Translated as "Log" in `src/config/copy/en.ts`. Never mutated — corrections are new appended events. |
| **Journal** | (same) journal | Code-side name for the Verlauf rows and their UI (`appConfig.copy.journal.*`, journal rows on `TimelineEvent`); «Einsatzjournal» is its printed form in the rapport. Verlauf (UI label) and Journal (code) are the same thing. |
| **Atemschutz** | SCBA / breathing-apparatus | The SCBA monitoring surface: per-Trupp clocks keyed on time since last radio contact (per FKS doctrine), with amber/alarm thresholds via `src/lib/alarm.ts`. |
| **Trupp** | crew, team (2–3 firefighters) | An SCBA entry team being tracked; can be placed on the map as an `Entity` of kind `'team'`. |
| **Mittel** | resources / materials | The material-use surface (`MittelView`): quantities of consumed material for billing/restock and the rapport. Not a live resource tracker. |
| **Einsatzleiter (EL)** | incident commander | The overall commander on scene. In the product model the EL is a *viewer* of the app («Einsatzleiter-Ansicht», `el_view_default`) — the FU operates it. |
| **Führungsunterstützung (FU)** | command support (unit) | The command-support element that runs the command post — the app's primary user; maps to the `editor` incident role. |
| **AdFU** | member of the FU | *Angehöriger der Führungsunterstützung* — the individual operator at the tablet. Doctrine: the AdFU works the app, the C-FU coordinates. |
| **Erfassungsblatt** | (paper) capture sheet | The paper form for recording an incident when the app isn't used; the digital capture flow (`/e/<token>` poster) and the printed rapport mirror its fields. |
| **Einsatzrapport** | incident report | The official post-incident report, composed server-side as a PDF (`backend/app/report_pdf.py`). It is a pre-filled *form*, not a data export — printing never blocks on missing data. |
| **Stichwort** | dispatch keyword | The alarm keyword/title classifying the incident (e.g. «BRAND GROSS»); drives the suggested category (`kategorieGuess` in the copy/config; keyword section of the capture form). |
| **Funkkanal** | radio channel | The incident's radio channel, a synced workspace setting shown in the top bar (`appConfig.copy.*.funkkanal`). |
| **Hydrant** | hydrant | Water-supply point; a per-station reference geodata layer (WGS84 GeoJSON loaded via `admin_geodata`, rendered through `referenceLayersFromConfig`). |
| **Leitungskataster** | utility-line cadastre | The municipal map of underground water/gas lines — another reference layer (`rowLeitung` in the Ebenen panel). Station data, never bundled. |
| **Einsatzobjekt** | incident object / building | The building or site the incident is at; the picked object (`pickedObjectId`) is synced so all devices see the same one, and it selects the Objektplan tiles. |
| **Objektplan / Modul** | building emergency plan / plan module | Pre-made emergency-plan PDFs for an object, organized in module tiles (M1 access, … «Modul 3 Objektplan», …) per `src/lib/deploymentConfig.ts` module catalogue; imported per station via `admin_objects`. |
| **FKS / Faltkarte** | Swiss fire-service tactical-symbol convention | *Feuerwehr Koordination Schweiz* publishes the Faltkarte (folding card) of tactical map signs; KP Front's own symbol pack (`tools/gen_symbols.py` → `public/tactical-symbols.json`) follows those conventions. |
| **Anwesenheit** | attendance | The attendance surface: who is on scene, with von–bis time chips; feeds the rapport's personnel section (WinFAP computes hours from von–bis). |
| **Ebenen** | (map) layers | The layers panel (`appConfig.copy.panels.layers`) toggling reference layers, vehicles, and the base map; a pinned dock on the Lage surface. |
| **Basiskarte** | base map | The map background (Carto / OSM / satellite), switched at the top of the Ebenen panel. |
| **LV95 / WGS84** | Swiss vs. global coordinates | LV95 is the Swiss national grid (7-digit metres); the map renders WGS84 `[lng, lat]` everywhere, converting only at the edges via `src/lib/geo.ts` (`wgs84ToLV95` / `lv95ToWgs84` / `fmtLV95`). |
| **Station** | fire station (a.k.a. Wache) | One deployment = one station (single-tenant): per-station config, branding, geodata, and the «Stationsdrucker» print relay all hang off it (see `docs/CONFIGURATION.md`). |
