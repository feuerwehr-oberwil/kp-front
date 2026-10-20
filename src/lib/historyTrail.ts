// A surface's own LEVELS in the browser history – the Checkliste library's list → device → chapter
// (ChecklistLibrary on the Karte, ChecklistsView in the Einsatz; owner 20.10.2026: «swipe from the
// left to go back one section … if there's a native thing we can use»). Each level deeper is one
// counted app entry (objectVisits/route · pushAppEntry), so the native back steps up one level:
// iOS's edge swipe in the installed app (offered exactly when there is an entry to go back to),
// Android's back gesture, the browser's ‹. The surface's own back row walks the same history.
// Leaving the surface (unmount) walks back over its entries: nothing stays behind the operational
// screen it hands over to (route · the 05.10. rule).
//
//   const nav = useHistoryTrail<Sel | null>(restored, sameSel)
//   nav.at                          // the level shown
//   nav.go([null, device, chapter]) // stand on that path, top level first
//
// The entries carry no content: what each level shows lives here (`levels`), so a sibling
// (the next chapter) replaces its level in memory and never touches the history.

import { useEffect, useState } from 'react'
import { appHistoryDepth, isWalkPop, pushAppEntry, walkBack, whenSettled } from '../objectVisits/route'

/** How to get from level `at` of `trail` to `target` (both top level first, `target` not empty):
 *  walk back `back` entries, then push `push`. The level walked back to is replaced in memory. */
export function trailStep<T>(
  trail: readonly T[], at: number, target: readonly T[], same: (a: T, b: T) => boolean,
): { back: number; push: number } {
  let common = 0
  while (common <= at && common < target.length && same(trail[common], target[common])) common++
  const keep = Math.min(common, target.length - 1, at)
  return { back: at - keep, push: target.length - 1 - keep }
}

/** One surface's trail outside React (the hook below holds one): `show` hears the level to show. */
function createTrail<T>(initial: T, show: (v: T) => void) {
  const t = {
    /** what each level shows; [0] is the entry the surface opened on (not ours) */
    levels: [initial] as T[],
    /** the level the current entry is */
    at: 0,
    /** the app depth of level 0 – known from the first push on */
    base: null as number | null,
    /** the path asked for and not yet applied (go() never touches the history synchronously) */
    wanted: null as readonly T[] | null,
    mounted: false,
    same: (a: T, b: T) => a === b,
  }
  /** settled: bring the history to `wanted` */
  function apply(): void {
    const target = t.wanted
    if (!t.mounted || !target) return
    // the history moved under us (StrictMode's clean-up walked back): re-read where we stand
    if (t.base !== null) t.at = Math.max(0, Math.min(appHistoryDepth() - t.base, t.levels.length - 1))
    const { back, push } = trailStep(t.levels, t.at, target, t.same)
    if (back > 0) {
      // the rest after landing – from the newest path asked for by then
      walkBack(back, () => { t.at -= back; whenSettled(apply) })
      return
    }
    t.wanted = null
    if (push > 0 && t.base === null) t.base = appHistoryDepth() - t.at
    for (let i = 0; i < push; i++) pushAppEntry(window.location.href)
    t.levels = [...target]
    t.at = target.length - 1
    show(target[t.at])
  }
  function go(target: readonly T[]): void {
    // shown at once; the history follows in a microtask (go() may be called while rendering)
    show(target[target.length - 1])
    const queued = t.wanted !== null
    t.wanted = target
    if (!queued) queueMicrotask(() => whenSettled(apply))
  }
  function onPop(e: Event): void {
    // a walk is someone leaving (or our own go()); only the user's back moves a level here
    if (isWalkPop(e) || t.base === null) return
    const d = appHistoryDepth() - t.base
    if (d < 0) return // below our floor: not ours to show
    t.at = Math.min(d, t.levels.length - 1)
    show(t.levels[t.at])
  }
  /** the surface is on screen; returns its leaving */
  function mount(): () => void {
    t.mounted = true
    // mounted again on the same state (StrictMode's dev remount): its clean-up walked our entries
    // back, so stand on the path again once that has landed
    if (!t.wanted && t.base !== null && t.at > 0) t.wanted = t.levels.slice(0, t.at + 1)
    if (t.wanted) whenSettled(apply)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      t.mounted = false
      // leaving: walk back over our entries – unless something else already did (a walk to the
      // floor) or stands on top of them (a visit pushed from here walks them back itself)
      whenSettled(() => {
        if (t.mounted || t.base === null || t.at === 0) return
        if (appHistoryDepth() === t.base + t.at) walkBack(t.at)
      })
    }
  }
  return { go, mount, setSame: (same: (a: T, b: T) => boolean) => { t.same = same } }
}

/** The trail of one surface: `at` is the level shown, `go(path)` stands on `path` (top level
 *  first) – pushing, walking back or replacing in memory as `trailStep` says. Paths are compared
 *  level by level with `same`. */
export function useHistoryTrail<T>(initial: T, same: (a: T, b: T) => boolean): { at: T; go: (target: readonly T[]) => void } {
  const [shown, setShown] = useState<T>(initial)
  const [trail] = useState(() => createTrail(initial, setShown))
  useEffect(() => trail.setSame(same))
  useEffect(() => trail.mount(), [trail])
  return { at: shown, go: trail.go }
}
