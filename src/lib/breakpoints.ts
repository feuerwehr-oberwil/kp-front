// THE breakpoints, in one place (07.10.2026). The stylesheets name them as custom media —
// `@media (--phone) { … }` — and `vite.config · customMedia` writes these strings in before the
// CSS reaches the browser, so the JS and the CSS cannot disagree. Until then the phone gate was
// hand-copied into 44 `@media` blocks next to `PHONE_QUERY` (useIsPhone.ts), with a comment
// asking whoever changed one to change all of them; `breakpoints.test.ts` now fails on a copy.
//
// ⚠️ Pure module: vite.config imports it at build time, so nothing here may import React or touch
// the DOM. `useIsPhone` re-exports PHONE_QUERY; read why it has TWO conditions there.
//
// ⚠️ Only a WHOLE query may be named: `@media (--phone)` or a comma list of names and queries.
// `(--phone) and (pointer: coarse)` would need the definition distributed over its comma, and a
// half-substituted media query does not fail — it silently never matches. The build stops on it.

/*
 * **Breakpoints have one source** (07.10.2026): `src/lib/breakpoints.ts`. Stylesheets write
 * `@media (--phone)` (also `--phone-landscape`, `--not-phone`, `--tablet`), and
 * `vite.config · customMedia` writes the query in; `useIsPhone` re-exports the same
 * `PHONE_QUERY`. Never hand-copy a query (`breakpoints.test.ts` fails). A name must stand alone
 * in its query (`(--phone) and (hover: none)` stops the build). ⚠️ A file another module
 * `composes: … from` (Surface.module.css) is read by postcss-modules WITHOUT our plugin and keeps
 * the literal query; the test pins it to `PHONE_QUERY`, and the build fails if a name ever
 * reaches an emitted stylesheet unresolved.
 */

/** A phone turned sideways: short, landscape, at most 1000px wide (a tablet is 1024+). The second
 *  half of --phone, named because a few rules want only it (GeorefMode, PlanCompass). */
export const PHONE_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 520px) and (max-width: 1000px)'

/** A phone: portrait up to 600px, or any short landscape viewport up to 1000px (a phone turned
 *  sideways). The gate for the bottom-sheet layout, the phone nav bar and the capture viewer. */
export const PHONE_QUERY = `(max-width: 600px), ${PHONE_LANDSCAPE_QUERY}`

/** Everything that is NOT --phone, written as the complement the stylesheets already used
 *  (601+ wide and 521+ tall, or 1001+ wide). */
export const NOT_PHONE_QUERY = '(min-width: 601px) and (min-height: 521px), (min-width: 1001px)'

/** A tablet: not a phone and at most 1024px wide. ⚠️ A landscape iPad (1180) falls OUTSIDE this
 *  and gets the desktop layout — known (UI sweep C7, 07.10.2026), left as it was until the owner
 *  decides; widening it is a visible change. */
export const TABLET_QUERY = '(min-width: 601px) and (min-height: 521px) and (max-width: 1024px), (min-width: 1001px) and (max-width: 1024px)'

/** Name → media query list, as the stylesheets write them (`@media (--phone)`). */
export const CUSTOM_MEDIA: Readonly<Record<string, string>> = {
  '--phone': PHONE_QUERY,
  '--phone-landscape': PHONE_LANDSCAPE_QUERY,
  '--not-phone': NOT_PHONE_QUERY,
  '--tablet': TABLET_QUERY,
}

/** Split a media query list on its top-level commas (none of ours nest, but a `(…)` may). */
function splitList(params: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < params.length; i++) {
    const c = params[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { out.push(params.slice(from, i)); from = i + 1 }
  }
  out.push(params.slice(from))
  return out
}

/** The `@media` params with every `(--name)` replaced by its query, or the params unchanged
 *  when they name none. Throws on an unknown name or a name inside a compound query. */
export function resolveCustomMedia(params: string): string {
  if (!params.includes('(--')) return params
  return splitList(params).map(item => {
    const t = item.trim()
    const m = /^\((--[a-z0-9-]+)\)$/.exec(t)
    if (!m) {
      if (t.includes('(--')) throw new Error(`custom media must stand alone in a query: «${t}» (lib/breakpoints)`)
      return t
    }
    const q = CUSTOM_MEDIA[m[1]]
    if (!q) throw new Error(`unknown custom media ${m[1]} (lib/breakpoints · CUSTOM_MEDIA)`)
    return q
  }).join(', ')
}
