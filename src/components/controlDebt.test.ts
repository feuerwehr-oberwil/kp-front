// THE shared-control ratchet (20.10.2026, Karte Haus round 3 · reuse audit `component-reuse-2026-10-19`,
// guardrail idea 1) – styleDebt.test.ts's twin for markup. The audit found every duplicate toggle,
// picker and search box arrived with a comment naming the shared piece it copied. Per file in
// src/components, src/workspace and src/capture this counts the raw controls the shared pieces
// already are:
//   pressed – a `<button … aria-pressed>`: a toggle         → Segmented, Chip
//   select  – a native `<select>`                           → Menu (lib/overlays), Combo
//   search  – a `type="search"` field                       → SearchField
//   row     – a `<button>` that is a hand-built row: a `…row…` class, or its own › glyph
//                                                            → ListRow (duck sweep LISTS.8)
//   ipBtn   – a `<button className="ip-btn …">` written out  → Button (ELEM.15)
//   disabledPrimary – a primary with a native `disabled`: the tap is swallowed, nothing says
//             why                                            → Button + lib/pointAtField (ELEM.4)
//   field   – an `<input>`/`<textarea>` without the house field class (`ip-input`, `ip-textarea`)
//                                                            → the shared fields (ELEM.15)
// and fails when a count goes UP, or a new file brings any. A count that went DOWN is a console
// note (sweep D.10, 23.10.2026) – lower BASELINE below when convenient; it only ever shrinks.
// A raw control that is genuinely right gets its reason in a comment beside it and its +1 here,
// in one commit.
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type Metric = 'pressed' | 'select' | 'search' | 'row' | 'ipBtn' | 'disabledPrimary' | 'field'
type Counts = Partial<Record<Metric, number>>
const METRICS: Metric[] = ['pressed', 'select', 'search', 'row', 'ipBtn', 'disabledPrimary', 'field']

/** the shared pieces themselves: their raw control IS the one implementation */
const SHARED = [
  'src/components/Segmented.tsx',
  'src/components/Chip.tsx',
  'src/components/SearchField.tsx',
  'src/components/ToolDock.tsx',
  'src/components/NavRail.tsx',
  'src/components/ListRow.tsx',
  'src/components/Button.tsx',
]

/** the opening tags of `tag` in TSX – brace-aware, so an arrow's `=>` in an attribute doesn't end it */
function openTags(src: string, tag: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(new RegExp(`<${tag}\\b`, 'g'))) {
    let depth = 0
    let i = m.index + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

/** a `<button>`'s opening tag with everything up to its `</button>` (buttons never nest) */
function buttons(code: string): { open: string; body: string }[] {
  return openTags(code, 'button').map((open) => {
    const at = code.indexOf(open)
    const end = code.indexOf('</button>', at)
    return { open, body: end < 0 ? '' : code.slice(at + open.length, end) }
  })
}

export function countControls(src: string): Counts {
  // comments out – JSX ones too (`{/* … */}` leaves `{}`, harmless)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const btns = buttons(code)
  const classOf = (tag: string) => /className=(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(tag)?.[1] ?? ''
  const counts: Record<Metric, number> = {
    pressed: btns.filter((b) => /\baria-pressed\b/.test(b.open)).length,
    select: openTags(code, 'select').length,
    search: (code.match(/type=["{']*search\b/g) ?? []).length,
    row: btns.filter((b) => /[\w-]row\b|\brow[\w-]|\brow\b/i.test(classOf(b.open)) || /id=["{']*chevron["}']/.test(b.body)).length,
    ipBtn: btns.filter((b) => /\bip-btn\b/.test(classOf(b.open))).length,
    disabledPrimary: btns.filter((b) => /\bprimary\b/.test(classOf(b.open)) && /\sdisabled\b/.test(b.open)).length,
    field: [...openTags(code, 'input'), ...openTags(code, 'textarea')]
      .filter((t) => !/type=["{']*(search|checkbox|radio|file|hidden|range)\b/.test(t) && !/\bip-(input|textarea)\b/.test(classOf(t))).length,
  }
  const out: Counts = {}
  for (const m of METRICS) if (counts[m]) out[m] = counts[m]
  return out
}

// 20.10.2026: what stood when the ratchet went in; the row / ipBtn / disabledPrimary / field counts
// and src/capture since 17.11.2026 (duck round, after the seven rows moved onto ListRow). Lower it as
// surfaces move onto the shared pieces.
// 17.11.2026 (button sweep SHEETS.12): the «Verbindungen» jump rows of ContextPanel (1), DrawEditor
// (its jumps to a target and to the Trupp, 2) and PlanAnno (1) are COUNTED now, not new – their typed ›
// became the `chevron` icon the ratchet reads; they wait for ListRow with the rest. The foot
// toggles (Erledigt, Sperren) went onto <Button>.
const BASELINE: Record<string, Counts> = {
  'src/capture/BeilagenSection.tsx': { field: 1 },
  'src/capture/CaptureApp.tsx': { row: 2 },
  'src/capture/DraftField.tsx': { field: 2 },
  'src/capture/MaterialSection.tsx': { pressed: 1, ipBtn: 1 },
  'src/capture/PartnerSection.tsx': { field: 3 },
  'src/capture/PersonenSection.tsx': { pressed: 1 },
  'src/components/AnwesenheitView.tsx': { pressed: 1 },
  'src/components/AtemschutzNotfall.tsx': { row: 4 },
  'src/components/AtemschutzView.tsx': { pressed: 1, row: 1 },
  'src/components/AudioPlayerSheet.tsx': { row: 2, field: 4 },
  'src/components/BandGrid.tsx': { pressed: 1, field: 1 },
  'src/components/ClearableInput.tsx': { field: 1 },
  'src/components/ComboMenu.tsx': { pressed: 1 },
  // +1 pressed (31.10.2026): the foot's «Erledigt» toggle – an action tile pressed in place, not a choice
  'src/components/ContextPanel.tsx': { pressed: 2, row: 1, field: 4 },
  'src/components/DrawEditor.tsx': { row: 2, field: 3 },
  'src/components/EntityMarker.tsx': { field: 1 },
  'src/components/ErrorBoundary.tsx': { ipBtn: 4 },
  'src/components/GeorefMode.tsx': { pressed: 1 },
  'src/components/GeorefTransfer.tsx': { row: 1, disabledPrimary: 1 },
  'src/components/GroupChooser.tsx': { row: 1 },
  'src/components/HomeMenus.tsx': { row: 1, ipBtn: 4 },
  'src/components/Journal.tsx': { pressed: 1 },
  'src/components/JournalComposer.tsx': { pressed: 1, field: 1 },
  'src/components/JournalRow.tsx': { field: 2 },
  'src/components/KrokiFramingPanel.tsx': { row: 1 },
  'src/components/LayerPanel.tsx': { pressed: 3, row: 3 },
  'src/components/LoginScreen.tsx': { row: 2 },
  'src/components/ManualReader.tsx': { row: 1 },
  'src/components/MapUtility.tsx': { pressed: 1 },
  'src/components/MapView.tsx': { ipBtn: 1 },
  'src/components/MapViewsMenu.tsx': { pressed: 3, row: 5, field: 1 },
  'src/components/MeasurePanel.tsx': { row: 1 },
  'src/components/MittelView.tsx': { pressed: 1, row: 3, ipBtn: 8, disabledPrimary: 1 },
  'src/components/PersonnelSyncDialog.tsx': { ipBtn: 2, disabledPrimary: 1 },
  'src/components/PlanAnno.tsx': { row: 1, field: 1 },
  'src/components/PlanScalePrompts.tsx': { field: 1 },
  'src/components/Presentation.tsx': { ipBtn: 7, field: 1 },
  'src/components/ReadingParts.tsx': { field: 1 },
  'src/components/ReportCheckRow.tsx': { row: 1 },
  'src/components/ReportPreflight.tsx': { pressed: 1, row: 1, ipBtn: 17 },
  'src/components/ReportSignatures.tsx': { row: 1 },
  'src/components/SelectionBar.tsx': { pressed: 2 },
  'src/components/Splash.tsx': { ipBtn: 1 },
  'src/components/Stepper.tsx': { field: 1 },
  'src/components/SurfaceBoundary.tsx': { ipBtn: 2 },
  'src/components/TafelFormPage.tsx': { field: 1 },
  'src/components/TickRow.tsx': { row: 1 },
  'src/components/ToolRail.tsx': { pressed: 2, row: 1 },
  'src/components/TopBar.tsx': { pressed: 1 },
  'src/components/TruppCard.tsx': { row: 2 },
  'src/components/TruppForm.tsx': { row: 2, ipBtn: 3 },
  'src/components/TruppSheets.tsx': { pressed: 2, ipBtn: 6, field: 1 },
  'src/components/TruppTeam.tsx': { pressed: 1 },
  'src/components/TwinTeamPill.tsx': { pressed: 2, field: 1 },
  'src/components/WbControls.tsx': { row: 2 },
  'src/components/WheelPicker.tsx': { pressed: 2, select: 1, field: 1 },
  'src/components/Whiteboard.tsx': { row: 2 }, // the Objekt chip's › (picker = ›, duck sweep ELEM.3): a chip, not a row
  'src/components/karte/KarteApp.tsx': { pressed: 3 },
  'src/components/karte/KartePanel.tsx': { row: 1 },
  'src/components/karte/KartePlans.tsx': { pressed: 3, row: 1 },
  'src/components/objectVisits/Sheets.tsx': { field: 5 },
  'src/components/panels/AppMenuRows.tsx': { row: 2 },
  'src/components/panels/EinsatzWizard.tsx': { ipBtn: 2, disabledPrimary: 1, field: 2 },
  'src/components/panels/FeedbackPrompt.tsx': { ipBtn: 2 },
  'src/components/panels/FeedbackSheet.tsx': { pressed: 1, ipBtn: 2, disabledPrimary: 1, field: 1 },
  'src/components/panels/OfflineReadiness.tsx': { ipBtn: 1 },
  'src/components/panels/ShareIncident.tsx': { ipBtn: 4, disabledPrimary: 1 },
  'src/workspace/MapToolDocks.tsx': { pressed: 1 },
}

const files = globSync('src/{components,workspace,capture}/**/*.tsx', { cwd: process.cwd() })
  .filter((f) => !f.includes('.test.') && !f.includes('/admin/') && !SHARED.includes(f)).sort()
const current: Record<string, Counts> = Object.fromEntries(
  files.map((f) => [f, countControls(readFileSync(f, 'utf8'))] as const).filter(([, c]) => Object.keys(c).length))

describe('shared-control ratchet', () => {
  it('counts what it says', () => {
    expect(countControls(`
      // <select> in a comment is no control
      <button type="button" aria-pressed={on} onClick={() => set((o) => !o)}>A</button>
      <button type="button" onClick={go}>B</button>
      <select value={v} onChange={(e) => set(e.target.value)}><option /></select>
      <input type="search" /> <input type={'search'} />
    `)).toEqual({ pressed: 1, select: 1, search: 2 })
  })

  it('counts a hand-built row, a raw .ip-btn, a native-disabled primary and a bare field', () => {
    expect(countControls(`
      <button className="pp-row" onClick={go}><b>Name</b></button>
      <button className={cx(s.tile)} onClick={go}><span>Plan</span><Icon id="chevron" /></button>
      <button className="ip-btn primary" disabled={!ok} onClick={save}>Speichern</button>
      <input value={v} onChange={set} /> <input className="ip-input" /> <textarea className="ip-textarea" />
      <input type="checkbox" />
    `)).toEqual({ row: 2, ipBtn: 1, disabledPrimary: 1, field: 1 })
  })

  it('finds the components, and the shared pieces it allows are still there', () => {
    expect(files.length).toBeGreaterThan(100)
    for (const f of SHARED) expect(readFileSync(f, 'utf8').length, f).toBeGreaterThan(0)
  })

  it('no file has more raw controls than its baseline', () => {
    const up: string[] = []
    for (const [f, c] of Object.entries(current)) {
      for (const m of METRICS) {
        const was = BASELINE[f]?.[m] ?? 0
        if ((c[m] ?? 0) > was) up.push(`${f}: ${m} ${was} → ${c[m]}`)
      }
    }
    const down: string[] = []
    for (const [f, c] of Object.entries(BASELINE)) {
      for (const m of METRICS) {
        const now = current[f]?.[m] ?? 0
        if ((c[m] ?? 0) > now) down.push(`${f}: ${m} ${c[m]} → ${now}`)
      }
    }
    if (down.length) console.warn(`raw controls went away (${down.length}) – lower BASELINE in controlDebt.test.ts when convenient\n  ${down.join('\n  ')}`)
    expect(up, 'a new raw toggle/select/search/row/button/field: use Segmented/Chip, Menu/Combo, SearchField, ListRow, Button or the shared fields (docs/ui-conventions · Small roles)').toEqual([])
  })
})
