import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CUSTOM_MEDIA, NOT_PHONE_QUERY, PHONE_LANDSCAPE_QUERY, PHONE_QUERY, TABLET_QUERY, resolveCustomMedia } from './breakpoints'
import { PHONE_QUERY as HOOK_PHONE_QUERY } from './useIsPhone'

const cssFiles = globSync('src/**/*.css', { cwd: process.cwd() })
const read = (f: string) => readFileSync(f, 'utf8')
/** files another module `composes: … from` — postcss-modules reads those with its own loader,
 *  which runs no user plugin, so a name in one would reach the browser unresolved */
const composed = new Set(cssFiles.flatMap(f =>
  [...read(f).matchAll(/composes:[^;]*from\s+['"](\.[^'"]+)['"]/g)]
    .map(m => join(dirname(f), m[1]))))
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
/** every `@media` prelude in a file, comments removed */
const preludes = (css: string) => [...stripComments(css).matchAll(/@media\s+([^{;]+)\{/g)].map(m => m[1].trim())

describe('custom media (lib/breakpoints)', () => {
  it('is the query useIsPhone asks', () => {
    expect(HOOK_PHONE_QUERY).toBe(PHONE_QUERY)
    expect(CUSTOM_MEDIA['--phone']).toBe(PHONE_QUERY)
    expect(PHONE_QUERY).toBe('(max-width: 600px), (orientation: landscape) and (max-height: 520px) and (max-width: 1000px)')
  })

  it('writes the whole query in for a name, alone or in a list', () => {
    expect(resolveCustomMedia('(--phone)')).toBe(PHONE_QUERY)
    expect(resolveCustomMedia('(--tablet)')).toBe(TABLET_QUERY)
    expect(resolveCustomMedia('(--not-phone), print')).toBe(`${NOT_PHONE_QUERY}, print`)
    expect(resolveCustomMedia('(max-width: 860px), (--phone-landscape)'))
      .toBe(`(max-width: 860px), ${PHONE_LANDSCAPE_QUERY}`)
    expect(resolveCustomMedia('(hover: hover)')).toBe('(hover: hover)')
  })

  it('stops the build on an unknown name or a half-substitutable query', () => {
    expect(() => resolveCustomMedia('(--phnoe)')).toThrow(/unknown custom media --phnoe/)
    expect(() => resolveCustomMedia('(--phone) and (pointer: coarse)')).toThrow(/must stand alone/)
  })

  it('finds the stylesheets', () => {
    expect(cssFiles.length).toBeGreaterThan(40)
  })

  // The guard: a stylesheet names the phone, it does not copy its conditions. A copy is how the
  // gate drifted before (Atemschutz at a bare 560px until 03.09.2026).
  it('no stylesheet hand-copies a named query', () => {
    const copies: string[] = []
    for (const f of cssFiles) {
      if (composed.has(f)) continue
      for (const p of preludes(read(f))) {
        if (p.includes('(max-height: 520px)') || p.includes(NOT_PHONE_QUERY)
          || p.includes(TABLET_QUERY)) copies.push(`${f}: @media ${p}`)
      }
    }
    expect(copies, 'write @media (--phone) / (--phone-landscape) / (--not-phone) / (--tablet) — lib/breakpoints').toEqual([])
  })

  // …except a composed file: it keeps the literal query, and it has to be the phone's verbatim
  it('a composed stylesheet names nothing and copies the phone gate exactly', () => {
    expect([...composed]).toContain('src/components/Surface.module.css')
    for (const f of composed) {
      for (const p of preludes(read(f))) {
        expect(p, `${f}: custom media is not resolved in a composed file`).not.toContain('(--')
        if (p.includes('(max-height: 520px)')) expect(p, f).toBe(PHONE_QUERY)
      }
    }
  })

  it('every name a stylesheet uses resolves', () => {
    for (const f of cssFiles) {
      for (const p of preludes(read(f))) {
        expect(() => resolveCustomMedia(p), `${f}: @media ${p}`).not.toThrow()
      }
    }
  })
})
