# Base UI adoption — implementation plan

> Status: PROPOSAL, awaiting go. Untracked scratch. Nothing here has shipped except the
> `pnpm add @base-ui/react` (revert with `git checkout package.json pnpm-lock.yaml && pnpm install`).

## Goal

Replace ~15 hand-rolled portal overlays (Dialog/Popover/Menu/Select/Tooltip) — each re-implementing
its own outside-click, Esc, and flip-positioning, and **none** with focus trap/restore except
`Palette.tsx` — with a small set of shared primitives built on **Base UI (`@base-ui/react` 1.6.0,
headless)**, painted with the app's existing `.ip-*` / token CSS. Behavior-only change: markup and
a11y improve, look does not.

## Principles

- **Headless + our CSS.** Base UI ships zero styles; we keep `app.css` tokens and the day/night flip.
- **Wrap, don't scatter.** Callers never import `@base-ui/react` directly — they use our `<Sheet>`,
  `<Popover>`, `<Menu>`, `<Select>`, `<Tooltip>` wrappers (like `src/admin/ui.tsx` does today, but
  for the whole app). One place to theme, swap, or fix.
- **Incremental + CI-gated.** Each phase is independently shippable behind the green CI gate
  (tsc + vitest + build + image smoke). No big-bang branch.
- **3am tenet.** Every migrated surface gains focus trap, focus restore, scroll-lock, Esc, and
  correct ARIA — the reliability we currently only have in one dialog.

## Scope — adopt vs. leave alone

**Adopt (Base UI wins clearly):**

| Surface today | Count | → primitive |
|---|---|---|
| `.ip-ovl`/`.ip-sheet` + `.mp-sheet` modals (IncidentPanels, ReportPreflight, PlanPicker, PersonnelSyncDialog, InstallGuide, MapPicker, KrokiFramingModal) | ~8 | `Dialog` → `<Sheet>` |
| MapViewsMenu popover, TopBar weather, AtemschutzView popovers | ~4 | `Popover` → `<Popover>` |
| admin `ActionMenu`, incident status dropdown | ~2 | `Menu` → `<Menu>` |
| `Combo` (no arrow-key nav today) + admin `Select` | 2 | `Select`/`Combobox` → `<Select>` |
| `InfoTip` + `DockInfo` (two tooltip impls) | 2 | `Tooltip` → `<Tooltip>` |
| `confirmDialog` in `lib/ui.tsx` | 1 | `AlertDialog` (keep imperative API) |

**Leave alone (Base UI can't/needn't):**

- **Phone bottom-sheet drag-to-resize** (`SheetGrip.tsx`, pointer-capture half↔full snap) — bespoke
  gesture, no headless lib does it. `<Sheet>` can host it, but the grip logic stays ours.
- **Map tool docks / views over the canvas** — coupled to MapLibre + no-scrim interaction model.
- **`WheelPicker`** iOS wheel, **`toast()`** — already fine.

## Primitives to build (`src/lib/overlays/` — new)

Each is a thin wrapper. `<Sheet>` and `<SheetClose>` already prototyped in `proto/Sheet.tsx` — that
is the target API. Others follow the same shape:

- `Sheet` — Dialog. Props: `trigger`, `title`, `wide`, `footer`, `children`. Optional `grip` slot
  for the phone drag handle so `SheetGrip` composes in unchanged.
- `AlertDialog` — for `confirmDialog`; keep the imperative `confirmDialog()` signature, swap the
  internals so the existing ~30 call sites don't change.
- `Popover` — anchored, no-scrim; `trigger` + `children`. Replaces the 4 flip-up copies.
- `Menu` — `role=menu`, arrow-key nav, `items`/`render`. Replaces `ActionMenu` + status dropdown.
- `Select` — real listbox keyboard nav; absorb `Combo`'s grouping / custom-value / rank-filter props
  so the app-side picker gains arrow keys.
- `Tooltip` — hover/focus/tap, `role=tooltip`, edge-shift. One impl replacing `InfoTip` + `DockInfo`.

Add colocated `*.test.tsx` for each wrapper (open/close, Esc, focus restore) — closes part of the
current ~7% component-test gap on exactly the code most worth testing.

## Phasing

Ordered by payoff-to-risk. Each phase = one PR, green CI, then merge.

1. **Phase 0 — foundation (½ day).** Land `src/lib/overlays/Sheet.tsx` + `SheetClose` + tests.
   Migrate **one** low-traffic sheet end-to-end (`PersonnelSyncDialog` — self-contained, editor-only)
   as the reference. `/verify` on iPad: focus trap, restore, backdrop, night theme, no zoom-jank.
2. **Phase 1 — sheets (1–2 days).** Migrate the remaining `.ip-sheet` surfaces to `<Sheet>`. Fold
   `SheetGrip` into `<Sheet grip>`. Delete per-file overlay/Esc/outside-click wiring. Retire the
   duplicated `.mp-ovl`/`.mp-sheet` family into the one frame.
3. **Phase 2 — confirm/alert (½ day).** Reimplement `confirmDialog` on `AlertDialog`; call sites
   unchanged. Verify the `.ip-ovl @80` z-order note in `app.css:626` still holds.
4. **Phase 3 — popovers & menus (1–2 days).** `<Popover>` for MapViewsMenu/weather/Atemschutz;
   `<Menu>` for `ActionMenu` + status dropdown. Delete the ~4 flip-up + 6 outside-click copies.
5. **Phase 4 — Select/Combo & Tooltip (1–2 days).** `<Select>` absorbing `Combo`; unify the two
   tooltips into `<Tooltip>`. Highest surface area — do last, lots of `/verify`.
6. **Phase 5 — cleanup.** Remove dead CSS classes and now-unused helpers; grep for any direct
   `@base-ui` import outside `src/lib/overlays/` (should be zero); doc the convention in CLAUDE.md.

## Risks & mitigations

- **Tablet/touch.** App is pointer-heavy (28 files). Base UI is pointer-aware, but each migrated
  surface needs a real-device pass — that's what Phase 0's single reference migration de-risks
  before we touch anything hot.
- **`lockChromeZoom` / gesture interplay.** Base UI adds scroll-lock; confirm it doesn't fight the
  map's zoom lock. Test in Phase 0.
- **Night theme / `--accent`.** Wrappers use only tokens (no frozen `rgba`), per CLAUDE.md. Verify
  `[data-theme="night"]` on every migrated surface.
- **StrictMode double-invoke** (main.tsx uses it) — Base UI is StrictMode-safe; confirm no double
  portals in dev.
- **Bundle.** Tree-shaken per-component subpath imports (`@base-ui/react/dialog`); `date-fns` peers
  are **optional** and unused (we don't touch date components). Check `pnpm build` size delta stays
  small in Phase 0.
- **Test coverage.** Component tests are ~7% today. Each wrapper ships with tests; migrations are
  behavior-preserving so existing lib tests are unaffected.

## Rollback

Per-phase: revert the PR. Whole effort: `pnpm remove @base-ui/react` + revert `src/lib/overlays/`.
No data/schema/sync surface is touched — this is UI-layer only.

## Effort

~5–8 focused days total, but **shippable in slices** from Phase 0 onward. Recommend doing 0→1 first,
living with it for a week, then deciding whether to continue.
