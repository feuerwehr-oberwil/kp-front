# Manual limit test cards

**Status:** Active manual test pack  
**Audience:** internal release testing, training-table validation, and field realism checks  
**Print mode:** print this document and use one card per run. Keep scenario source material outside
the public repo.

This pack is for finding the app's limits, not proving a perfect happy path. A good run produces
notes about hesitation, missing trust signals, slow screens, confusing wording, bad offline states,
or data that did not survive interruption.

## Scenario sources

Use realistic incident material, but do not copy the scenario contents into this repo.

- **118 Magazin examples:** use published incident/kroki examples as external replay inputs for
  drawing, Lage, Kroki, and report checks. Record only the magazine issue/page reference in notes.
- **Tabletop training game:** use the station's existing table-top game for longer multi-role
  scenarios and surprise injections.
- **Synthetic demo scenario:** use only fake/demo addresses, plans, hydrants, rosters, and objects
  when screenshots or public documentation are involved.

## Run sheet

Fill this once per manual test session.

```text
Date:
Tester(s):
Device(s):
Browser/PWA:
Network setup:
Backend/deployment:
Incident/scenario source:
Build/commit:

Overall result: pass / usable with issues / not releasable
Top 3 issues:
1.
2.
3.
```

## Observation scale

Use the same shorthand on every card.

```text
S0 = polish / wording / small annoyance
S1 = confusing but recoverable
S2 = workflow blocked until workaround
S3 = data loss, wrong operational output, broken report, or app unusable

Trust:
  clear    = operator understood what happened
  unclear  = operator had to guess
  wrong    = app gave false confidence
```

## Card template

```text
Card:
Goal:
Scenario source:
Setup:
Steps:
Expected result:
Observed limit:
Severity:
Trust:
Follow-up issue:
```

---

## Card 1 - Clean incident opening

**Goal:** Verify a normal incident can be opened quickly from a cold start.

```text
Scenario source: synthetic or tabletop
Setup:
  - Fresh browser/PWA session if possible.
  - Normal online network.
Steps:
  1. Log in as editor.
  2. Open a new incident.
  3. Enter or select address/object.
  4. Confirm map position.
  5. Add one Verlauf entry.
  6. Reload the app.
Expected result:
  - Incident reopens without losing context.
  - Map, incident title/address, and Verlauf entry are still present.
  - Operator can see sync/save state.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 2 - 118 Kroki replay

**Goal:** Test whether a real published Kroki/Lage example can be recreated without fighting the
drawing tools.

```text
Scenario source: 118 Magazin issue/page reference:
Setup:
  - Use only the external magazine scenario as visual input.
  - Do not copy scenario images into the repo.
  - Tablet in landscape.
Steps:
  1. Open or create a matching training incident.
  2. Recreate the main Lage/Kroki: object, access, sectors, hazards, water supply, symbols.
  3. Use undo/redo at least twice.
  4. Switch between Lage and Plan if a plan is available.
  5. Print/report the resulting Kroki page.
Expected result:
  - Drawing controls are discoverable.
  - Symbols/lines/text can be placed at usable speed.
  - Undo/redo works for mistakes.
  - Printed Kroki is legible and not clipped.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 3 - Tabletop game full run

**Goal:** Exercise the app during a realistic evolving incident with surprise changes.

```text
Scenario source: tabletop game name/session:
Setup:
  - One facilitator runs the game.
  - One or more operators use KP Front.
  - Use actual target tablet if available.
Steps:
  1. Start with initial alarm information only.
  2. Open incident and build initial Lage.
  3. Add new findings as the facilitator reveals them.
  4. Add at least one plan annotation, one sector, and one hazard.
  5. Add Atemschutz if relevant.
  6. Add Verlauf entries throughout.
  7. End with report preflight/print.
Expected result:
  - App keeps up with the training tempo.
  - Operators do not need hidden steps or explanation.
  - Late scenario changes are easy to reflect.
  - Final report tells the story well enough for debriefing.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 4 - Multi-device task split

**Goal:** Find sync limits when multiple people work different domains in one incident.

```text
Scenario source: tabletop or synthetic
Setup:
  - Device A: Lage/Plan operator.
  - Device B: Atemschutz operator.
  - Optional Device C: Verlauf/report operator.
  - Same incident, all online.
Steps:
  1. Device A draws symbols/sectors/lines.
  2. Device B creates and updates Atemschutz teams.
  3. Device C writes Verlauf and report metadata.
  4. All devices reload.
  5. Compare final state on all devices.
Expected result:
  - Cross-domain edits survive.
  - No domain silently overwrites another.
  - Sync status is understandable.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 5 - Offline edit, reload, reconnect

**Goal:** Verify the app survives the common bad-network case.

```text
Scenario source: synthetic
Setup:
  - Open an incident online.
  - Load map/plan/reference data that should be available.
Steps:
  1. Put device into airplane mode.
  2. Add Lage changes, one Plan annotation, one Verlauf entry, and one Atemschutz/material-style
     record if available.
  3. Reload the PWA while still offline.
  4. Continue editing.
  5. Reconnect.
  6. Reload again after sync settles.
Expected result:
  - App continues as far as possible.
  - Limitations are shown honestly.
  - Offline edits survive reload.
  - Reconnect does not lose changes.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 6 - Offline conflict

**Goal:** Find clobbering behavior when two devices edit while disconnected.

```text
Scenario source: synthetic
Setup:
  - Device A and B start on the same incident online.
  - Then disconnect B.
Steps:
  1. Device A edits Lage and Verlauf online.
  2. Device B edits Atemschutz and Plan offline.
  3. Device A edits report metadata.
  4. Reconnect B.
  5. Compare final state on both devices.
Expected result:
  - Different domains merge.
  - Any same-object conflict is visible or at least predictable.
  - No false "all good" state after data loss.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 7 - Missing reference data

**Goal:** Verify missing plans/geodata/weather/roster data does not block operations.

```text
Scenario source: synthetic
Setup:
  - Use a deployment or config where one or more reference sources are missing/unavailable.
  - Examples: no object plan, weather unavailable, no roster, no hydrants layer.
Steps:
  1. Open an incident that would normally use those sources.
  2. Open Offline-Bereitschaft/readiness.
  3. Try Lage, Plan, Verlauf, Atemschutz, and report preflight.
Expected result:
  - App remains usable.
  - Missing data is visible as a limitation, not a crash.
  - Fallback is only OSM outline/Tafel where relevant.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 8 - Long incident volume

**Goal:** Find performance and usability limits under many records.

```text
Scenario source: synthetic or tabletop
Setup:
  - One long-running incident.
  - Prefer real tablet plus desktop comparison.
Steps:
  1. Add 100+ Verlauf rows.
  2. Add many map symbols/drawings and plan annotations.
  3. Add multiple Atemschutz cycles if relevant.
  4. Leave the app open for at least 1-2 hours, or simulate interruptions with lock/reload.
  5. Generate report preflight/print.
Expected result:
  - UI stays responsive.
  - Scroll/search/navigation remain usable.
  - Report remains bounded and legible.
  - Memory/reload does not lose state.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 9 - Tablet ergonomics

**Goal:** Test the real device experience under field-like conditions.

```text
Scenario source: any
Setup:
  - Target tablet.
  - Test portrait and landscape.
  - Test normal light and dark/night mode.
Steps:
  1. Open incident and perform common actions one-handed if realistic.
  2. Pan/zoom map and draw lines/symbols.
  3. Use Plan tools.
  4. Use Atemschutz pressure controls.
  5. Use browser back/app switch/screen lock and return.
Expected result:
  - Touch targets are reliable.
  - Text remains readable.
  - No accidental destructive actions.
  - Screen/app interruptions are recoverable.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 10 - Report and billing output

**Goal:** Check whether the final output is useful for documentation, billing, and debriefing.

```text
Scenario source: 118/tabletop/synthetic
Setup:
  - Incident with Lage/Kroki, Plan annotations, Atemschutz if relevant, Verlauf, and Mittel if built.
Steps:
  1. Open Rapportangaben.
  2. Fill required fields.
  3. Run report preflight.
  4. Print/save PDF from browser.
  5. Review output as if it were handed in after the incident.
Expected result:
  - Missing data warnings are understandable.
  - Kroki/Plan pages are legible.
  - Verlauf ordering makes sense.
  - Atemschutz and Mittel sections are included when present.
  - Output is not bloated beyond practical use.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 11 - Recovery drill

**Goal:** Verify the operator can recover from crashes, reloads, backend outage, and device loss.

```text
Scenario source: synthetic
Setup:
  - One open incident with recent unsynced-looking edits.
Steps:
  1. Kill the browser tab/app.
  2. Reopen the PWA.
  3. Temporarily stop backend/network if safe in test.
  4. Continue editing where possible.
  5. Restore backend/network.
  6. Confirm final incident from another device.
Expected result:
  - Local work is not lost.
  - Backend outage is clearly shown.
  - Reconnect/sync result is understandable.
  - Another device sees the final state after recovery.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 12 - Viewer/editor/admin boundary

**Goal:** Check that simple role boundaries are clear and do not block emergency work unexpectedly.

```text
Scenario source: synthetic
Setup:
  - One editor account/PIN.
  - One viewer account/PIN.
  - Admin access if available.
Steps:
  1. Viewer opens incident and tries map/plan/Atemschutz/Verlauf mutations.
  2. Editor performs the same changes.
  3. Admin changes a basic config/user setting outside the incident workflow.
  4. Reopen the incident as viewer and editor.
Expected result:
  - Viewer cannot mutate incident state.
  - Viewer mode explains limitations without looking broken.
  - Editor can operate normally.
  - Admin surface stays separate from incident operation.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 13 - Empty deployment / first configured data

**Goal:** Verify the app behaves well before station data has been loaded and after minimal data is
loaded.

```text
Scenario source: synthetic
Setup:
  - Empty/neutral deployment or demo-like config.
Steps:
  1. Open app with no station object plans/checklists/geodata.
  2. Open a manual incident.
  3. Confirm map, Tafel, Verlauf, and report basics still work.
  4. Load a small synthetic config/data package.
  5. Reopen app and confirm new data appears.
Expected result:
  - Empty state is usable, not broken.
  - No public repo fallback data is required.
  - Loaded config/data is visible after reload.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 14 - Print under pressure

**Goal:** Check whether browser/PWA printing is good enough for v1.

```text
Scenario source: tabletop or synthetic
Setup:
  - Incident with enough data to create a 1-5 page report.
  - Target printer or browser PDF print.
Steps:
  1. Open report preflight.
  2. Toggle sections.
  3. Print/save PDF.
  4. Repeat in portrait/landscape if relevant.
  5. Review page breaks, missing content, clipped maps/plans, and font size.
Expected result:
  - Print output is readable.
  - Key sections are not clipped.
  - Browser print is acceptable without a server-generated PDF.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## Card 15 - "No explanation" user drill

**Goal:** See where a technical but infrequent user hesitates without coaching.

```text
Scenario source: small tabletop or synthetic prompt
Setup:
  - Tester knows firefighting work but receives no UI walkthrough.
  - Observer stays silent unless safety/test setup requires intervention.
Steps:
  1. Ask tester to open an incident.
  2. Ask tester to draw the basic Lage.
  3. Ask tester to add a note and one Atemschutz/material-style record if available.
  4. Ask tester to find offline readiness.
  5. Ask tester to print/report.
Expected result:
  - User can complete the workflow from labels and layout alone.
  - Any hesitation is recorded with screen/context.
Observed limit:
Severity:
Trust:
Follow-up issue:
```

## After-action summary

Use this after a batch of cards.

```text
Cards run:
Pass/usable/not releasable:

S3 issues:

S2 issues:

Most confusing UI:

Slowest operation:

Data trust problems:

Offline/sync problems:

Report/print problems:

Next fixes before internal release:
1.
2.
3.
```
