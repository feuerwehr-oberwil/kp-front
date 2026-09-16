import { floorKey, joinKey, type PlanFloor } from '../lib/api/reference'
import { floorLabel, signedFloor } from '../lib/whiteboard'

/**
 * The floor-pack editor's model (mock B, 14.09.2026): the admin STACKS the floors like the
 * building – top floor first – and names ONE entry level 0. Indices are never typed; they fall
 * out of the stack. An entry is a page, or a REGION of a page (a rectangle) – so several entries
 * may share a page – and a region JOINS another floor, including on another page, at one point pair: «my
 * point `at` is that floor's point `there»» (the staircase on both drawings). Joined floor by
 * floor, the sheet's drawings are laid on each other.
 * Pages that are no floor (an overview, a legend) sit in the tray and get no index.
 *
 * A storey may be DRAWN SEVERAL TIMES (16.09.2026) – two wings of one 1. OG. Its further drawings
 * are entries too, marked `of` = the key of the storey's first entry and kept right behind it, so
 * everything that works on a drawing (a rectangle, a join point, the sheet) keeps working on one
 * flat list; only the INDEX is counted over the storeys. Each such drawing needs its own region
 * and its own join – nothing else on the sheet says where it lies.
 *
 * `fitPage` is the page the shared map fit is measured on. Absent = level 0's page (the server's
 * default too), so a stack without an explicit choice never sends a fit page it did not mean.
 */
export type Clip = [number, number, number, number]
export type Pt = [number, number]
export interface Join { toKey: string; at: Pt; there: Pt }
export interface FloorEntry {
  key: string
  page: number
  name: string
  clip?: Clip
  join?: Join
  /** set on a FURTHER drawing of a storey: the key of that storey's first entry. Such an entry
   *  carries no index of its own – it is a piece of the storey it points at. */
  of?: string
}
export interface FloorStack {
  /** entries top → bottom; an entry without `of` IS a floor, one with `of` is a piece of one */
  order: FloorEntry[]
  /** the key of the entry that is level 0 – must be in `order` */
  zero: string
  fitPage?: number
}

let seq = 0
export const newKey = () => `f${++seq}`

/** every page a floor, in PDF order, page 0 = level 0 – one tap («this page is 0») or one
 *  «Umkehren» away from most real packs */
export function defaultStack(pageCount: number): FloorStack {
  const order = Array.from({ length: pageCount }, (_, i) => ({ key: newKey(), page: i, name: '' }))
  return { order, zero: order[0]?.key ?? '', fitPage: undefined }
}

/** the published assignment as a stack; a fit page that is not level 0's is carried as the
 *  explicit choice it was */
export function stackFromFloors(floors: PlanFloor[], fitPage: number): FloorStack | null {
  if (!floors.length) return null
  // top storey first; inside a storey, its drawings in part order, so a storey's pieces stay
  // behind the row that carries its index
  const sorted = [...floors].sort((a, b) => b.index - a.index || (a.part ?? 0) - (b.part ?? 0))
  const keyOf = new Map(sorted.map((f) => [floorKey(f), newKey()]))
  const order: FloorEntry[] = sorted.map((f) => ({
    key: keyOf.get(floorKey(f))!, page: f.page, name: f.name ?? '',
    ...((f.part ?? 0) ? { of: keyOf.get(`${f.index}:0`)! } : {}),
    ...(f.clip ? { clip: [...f.clip] as Clip } : {}),
    ...(f.join && keyOf.has(joinKey(f.join))
      ? { join: { toKey: keyOf.get(joinKey(f.join))!, at: [...f.join.at] as Pt, there: [...f.join.there] as Pt } }
      : {}),
  }))
  const storeys = order.filter((e) => !e.of)
  const zeroAt = sorted.filter((f) => !(f.part ?? 0)).findIndex((f) => f.index === 0)
  const zero = storeys[zeroAt >= 0 ? zeroAt : storeys.length - 1]
  const stack: FloorStack = { order, zero: zero.key }
  if (fitPage !== zero.page && sorted.some((f) => f.page === fitPage)) stack.fitPage = fitPage
  return stack
}

/** the entries that ARE storeys, top → bottom – the list the index is counted over */
export const storeysOf = (stack: FloorStack): FloorEntry[] => stack.order.filter((e) => !e.of)
/** the storey entry a drawing belongs to (itself, when it is the storey's first drawing) */
export const storeyKey = (stack: FloorStack, key: string): string =>
  stack.order.find((e) => e.key === key)?.of ?? key
/** one storey's drawings in order: its own entry first, then its further pieces */
export const partsOf = (stack: FloorStack, key: string): FloorEntry[] => {
  const head = storeyKey(stack, key)
  return stack.order.filter((e) => e.key === head || e.of === head)
}
/** which drawing of its storey this entry is – 0 for a storey drawn once */
export const partOf = (stack: FloorStack, key: string): number =>
  partsOf(stack, key).findIndex((e) => e.key === key)

export const indexOf = (stack: FloorStack, key: string): number => {
  const storeys = storeysOf(stack)
  return storeys.findIndex((e) => e.key === storeyKey(stack, stack.zero)) - storeys.findIndex((e) => e.key === storeyKey(stack, key))
}

/** what the server stores – trimmed names, no name when it equals the standard one */
export function floorsFromStack(stack: FloorStack): PlanFloor[] {
  return stack.order.map((e) => {
    const index = indexOf(stack, e.key)
    const part = partOf(stack, e.key)
    const name = e.name.trim()
    const target = e.join ? stack.order.find((o) => o.key === e.join!.toKey) : undefined
    // part 0 is left unsaid, so a pack drawn one-floor-one-drawing sends exactly what it always did
    const targetPart = target ? partOf(stack, target.key) : 0
    return {
      page: e.page, index, part, name: name && name !== floorLabel(index) ? name : null, clip: e.clip ?? null,
      join: e.join && target
        ? { to: indexOf(stack, target.key), ...(targetPart ? { part: targetPart } : {}), at: e.join.at, there: e.join.there }
        : null,
    }
  })
}

export const standardFloorName = floorLabel
export const signedIndex = signedFloor

/** pages of the PDF no entry uses (the tray), in page order */
export const trayOf = (stack: FloorStack, pageCount: number): number[] =>
  Array.from({ length: pageCount }, (_, i) => i).filter((p) => !stack.order.some((e) => e.page === p))

/** drop `key` so it sits where `before` was (before = undefined → bottom). A storey travels with
 *  its further drawings – they are pieces of it, not rows of their own. */
export function reorderStack(stack: FloorStack, key: string, before: string | undefined): FloorStack {
  const head = storeyKey(stack, key)
  const group = partsOf(stack, head)
  if (!group.length || head === storeyKey(stack, before ?? '')) return stack
  const order = stack.order.filter((e) => !group.includes(e))
  const at = before == null ? order.length : order.findIndex((e) => e.key === storeyKey(stack, before))
  order.splice(at < 0 ? order.length : at, 0, ...group)
  return { ...stack, order }
}

/** out of the stack – a storey takes its further drawings with it, and if it was level 0 the
 *  nearest remaining storey becomes 0 so the stack stays valid */
export function dropFromStack(stack: FloorStack, key: string): FloorStack {
  const entry = stack.order.find((e) => e.key === key)
  if (!entry) return stack
  const gone = entry.of ? [entry] : partsOf(stack, key)
  const goneKeys = new Set(gone.map((e) => e.key))
  const storeys = storeysOf(stack)
  const i = storeys.findIndex((e) => e.key === storeyKey(stack, key))
  const order = stack.order
    .filter((e) => !goneKeys.has(e.key))
    // a join that pointed INTO what just left is not a join any more
    .map((e) => (e.join && goneKeys.has(e.join.toKey) ? { ...e, join: undefined } : e))
  const left = order.filter((e) => !e.of)
  const zero = goneKeys.has(stack.zero) ? left[Math.min(i, left.length - 1)]?.key ?? '' : stack.zero
  const fitPage = stack.fitPage === entry.page && !order.some((e) => e.page === entry.page) ? undefined : stack.fitPage
  return { ...stack, order, zero, fitPage }
}

/** a FURTHER drawing of the storey `key` belongs to, kept right behind that storey's own pieces.
 *  The key comes back because the caller draws that drawing's rectangle next. */
export function appendPart(stack: FloorStack, key: string): { stack: FloorStack; key: string } {
  const head = storeyKey(stack, key)
  const group = partsOf(stack, head)
  const anchor = group[group.length - 1]
  const entry: FloorEntry = { key: newKey(), page: anchor.page, name: '', of: head }
  const order = [...stack.order]
  order.splice(order.indexOf(anchor) + 1, 0, entry)
  return { stack: { ...stack, order }, key: entry.key }
}

/** a new floor at the BOTTOM of the stack – the storey below the lowest – on `page`. The key
 *  comes back because the caller draws that floor's region next. */
export function appendFloor(stack: FloorStack, page: number): { stack: FloorStack; key: string } {
  const entry: FloorEntry = { key: newKey(), page, name: '' }
  return { stack: { ...stack, order: [...stack.order, entry], zero: stack.order.length ? stack.zero : entry.key }, key: entry.key }
}

/** a page from the tray back into the stack, at the bottom, as a whole page */
export const restoreToStack = (stack: FloorStack, page: number): FloorStack => appendFloor(stack, page).stack

export const patchEntry = (stack: FloorStack, key: string, patch: Partial<Omit<FloorEntry, 'key'>>): FloorStack => ({
  ...stack, order: stack.order.map((e) => (e.key === key ? { ...e, ...patch } : e)),
})

/** top floor ↔ bottom floor. Storeys turn round; a storey's own drawings keep their order. */
export const reverseStack = (stack: FloorStack): FloorStack => ({
  ...stack,
  order: storeysOf(stack).reverse().flatMap((e) => partsOf(stack, e.key)),
})

export const sameStack = (a: FloorStack | null, b: FloorStack | null): boolean =>
  JSON.stringify(a && floorsFromStack(a)) === JSON.stringify(b && floorsFromStack(b)) && (a?.fitPage ?? null) === (b?.fitPage ?? null)

/** the floors that are CONNECTED to `key` through joins, in either direction */
export function joinedWith(stack: FloorStack, key: string): Set<string> {
  const seen = new Set<string>([key])
  let grew = true
  while (grew) {
    grew = false
    for (const e of stack.order) {
      if (seen.has(e.key)) continue
      const hits = (e.join && seen.has(e.join.toKey)) || stack.order.some((o) => seen.has(o.key) && o.join?.toKey === e.key)
      if (hits) { seen.add(e.key); grew = true }
    }
  }
  return seen
}

/** Whole-page exports retain their shared-frame convention. Crops need an explicit connection
 *  to the reference drawing, even when each crop is on a different PDF page. */
export const stackComplete = (stack: FloorStack): boolean =>
  stack.order.every((e) => entryJoined(stack, e.key)) &&
  // a storey drawn twice: every one of its drawings needs its own rectangle, or there is nothing
  // to tell the two apart on the sheet
  stack.order.every((e) => (partsOf(stack, e.key).length > 1 ? !!e.clip : true))

/** ONE endpoint of ONE join: the entry that owns the join, and which of its two points it is –
 *  `at` lies in that floor's own drawing, `there` in the drawing it was joined to. */
export interface JoinPointHit { key: string; end: 'at' | 'there' }

/** the drawing a join endpoint lives in – its own floor's for `at`, the joined floor's for
 *  `there`; undefined where that floor is a whole page and the endpoint may go anywhere */
export function joinPointClip(entries: FloorEntry[], hit: JoinPointHit): Clip | undefined {
  const owner = entries.find((e) => e.key === hit.key)
  if (!owner?.join) return undefined
  return hit.end === 'at' ? owner.clip : entries.find((e) => e.key === owner.join!.toKey)?.clip
}

/** a point held inside its drawing – and inside the page where there is no drawing */
export const clampToClip = (p: Pt, clip?: Clip): Pt => clip
  ? [Math.min(clip[2], Math.max(clip[0], p[0])), Math.min(clip[3], Math.max(clip[1], p[1]))]
  : [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))]

/**
 * Which join point a press on the sheet grabs. The circles are the smallest marks on the paper
 * and they sit INSIDE the rectangles, so they are hit-tested first: a press on a point drags
 * that point, a press anywhere else in a rectangle moves the whole drawing.
 * Measured in SCREEN pixels (`size` is the sheet's rendered box), so the target stays a circle
 * of the same reach on a sheet of any aspect and at any zoom. Only the endpoints DRAWN on this
 * page can be grabbed – a cross-page join shows one end here and the other on its own sheet.
 */
export function hitJoinPoint(entries: FloorEntry[], page: number, p: Pt, size: { width: number; height: number }, radius: number): JoinPointHit | null {
  const near: { hit: JoinPointHit; d: number }[] = []
  for (const e of entries) {
    if (!e.join) continue
    const ends: [JoinPointHit, Pt][] = []
    if (e.page === page) ends.push([{ key: e.key, end: 'at' }, e.join.at])
    if (entries.find((o) => o.key === e.join!.toKey)?.page === page) ends.push([{ key: e.key, end: 'there' }, e.join.there])
    for (const [hit, point] of ends) {
      const d = Math.hypot((point[0] - p[0]) * size.width, (point[1] - p[1]) * size.height)
      if (d <= radius) near.push({ hit, d })
    }
  }
  return near.sort((a, b) => a.d - b.d)[0]?.hit ?? null
}

/** a join endpoint dragged to a new place, clamped into the drawing it belongs to */
export function moveJoinPoint(stack: FloorStack, hit: JoinPointHit, to: Pt): FloorStack {
  const owner = stack.order.find((e) => e.key === hit.key)
  if (!owner?.join) return stack
  const at = clampToClip(to, joinPointClip(stack.order, hit))
  return patchEntry(stack, hit.key, { join: hit.end === 'at' ? { ...owner.join, at } : { ...owner.join, there: at } })
}

/** Whether this crop belongs to the reference drawing's connected component. */
export const entryJoined = (stack: FloorStack, key: string): boolean => {
  const e = stack.order.find((o) => o.key === key)
  if (!e || !e.clip) return true
  const fitPage = stack.fitPage ?? stack.order.find(o => o.key === stack.zero)?.page
  const onFitPage = stack.order.filter(o => o.page === fitPage)
  const ref = onFitPage.find(o => o.key === stack.zero) ?? onFitPage[0] ?? stack.order[0]
  if (!ref) return true
  const connected = joinedWith(stack, key)
  return connected.has(ref.key)
}
