// Paint costs a slow device pays for every frame, held as static counts (perf sweep 26.11.2026 –
// CI has no GPU, so the stylesheet is the only place these can be checked):
//   · the floating blur lives in ONE token, and the night theme turns it off (its glass is 97 %
//     opaque, the blur showed through at 3 %).
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const sheets = globSync('src/**/*.css', { cwd: process.cwd() }).sort()
/** the declarations of the first rule whose selector is exactly `selector` */
const ruleBody = (css: string, selector: string) =>
  [...css.matchAll(/([^{};]*)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector)?.[2] ?? ''

describe('the floating blur is one token', () => {
  it('no stylesheet spells out the token’s value', () => {
    const copies = sheets.flatMap((f) =>
      [...read(f).matchAll(/backdrop-filter\s*:\s*blur\(14px\) saturate\(1\.4\)/g)].map(() => f))
    expect(copies).toEqual([])
  })

  it('the night theme turns it off', () => {
    const night = ruleBody(read('src/styles/01-tokens.css'), ':root[data-theme="night"]')
    expect(night).toMatch(/--float-blur:\s*none\s*;/)
  })
})
