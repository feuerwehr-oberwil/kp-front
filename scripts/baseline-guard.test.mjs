import { describe, expect, it } from 'vitest'
import { judge, loosened } from './baseline-guard.mjs'

const eslint = (n) => ({ rules: { 'kp/no-raw-effect': n }, silenced: {} })
const floor = (statements) => ({ floor: { statements, lines: 78 } })
const commit = (changed, baselines) => ({ sha: 'abc1234def', subject: 'x', changed, baselines })

describe('baseline guard', () => {
  it('fails a loosened baseline inside a feature commit', () => {
    const problems = judge([
      commit(['src/App.tsx', 'scripts/eslint-baseline.json'], {
        'scripts/eslint-baseline.json': { before: eslint(565), after: eslint(566) },
      }),
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0].raised).toEqual(['scripts/eslint-baseline.json · rules › kp/no-raw-effect: 565 → 566'])
    expect(problems[0].others).toEqual(['src/App.tsx'])
  })

  it('passes the same loosening in a commit that touches only baseline files', () => {
    expect(
      judge([
        commit(['scripts/eslint-baseline.json', 'scripts/coverage-floor.json'], {
          'scripts/eslint-baseline.json': { before: eslint(565), after: eslint(566) },
          'scripts/coverage-floor.json': { before: floor(74), after: floor(73) },
        }),
      ]),
    ).toEqual([])
  })

  it('passes a tightened baseline beside a feature', () => {
    expect(
      judge([
        commit(['src/App.tsx', 'scripts/eslint-baseline.json', 'scripts/coverage-floor.json'], {
          'scripts/eslint-baseline.json': { before: eslint(565), after: eslint(560) },
          'scripts/coverage-floor.json': { before: floor(74), after: floor(74.5) },
        }),
      ]),
    ).toEqual([])
  })

  it('reads each file in its own direction', () => {
    // a floor loosens downwards, and a removed floor is no floor
    expect(loosened('scripts/coverage-floor.json', floor(74), floor(73.9))).toEqual(['floor › statements: 74 → 73.9'])
    expect(loosened('scripts/coverage-floor.json', floor(74), { floor: { lines: 78 } })).toEqual(['floor › statements: 74 → –'])
    // a new count is a raise from 0, a removed one is a drop to 0
    expect(loosened('src/styles/styleDebt.baseline.json', {}, { 'src/a.css': { spacing: 1 } })).toEqual(['src/a.css › spacing: 0 → 1'])
    expect(loosened('src/styles/styleDebt.baseline.json', { 'src/a.css': { spacing: 1 } }, {})).toEqual([])
    // the bundle check fails above size × (1 + budget): a chunk's own budget counts, raw is only reported
    const chunks = (App, budgetPercent = 5) => ({ budgetPercent, chunks: { App } })
    expect(loosened('scripts/bundle-baseline.json', chunks({ gzip: 100, raw: 300 }), chunks({ gzip: 100, raw: 400 }))).toEqual([])
    expect(loosened('scripts/bundle-baseline.json', chunks({ gzip: 100 }), chunks({ gzip: 100, budgetPercent: 10 }))).toEqual([
      'chunks › App › gzip limit: 105 → 110',
    ])
    expect(loosened('scripts/bundle-baseline.json', chunks({ gzip: 100 }), chunks({ gzip: 90 }, 10))).toEqual([])
    expect(loosened('scripts/bundle-baseline.json', chunks({ gzip: 100 }), { budgetPercent: 5, chunks: {} })).toEqual([
      'chunks › App › gzip limit: 105 → –',
    ])
    // a raised jscpd minTokens counts fewer clones
    expect(loosened('.jscpd.json', { threshold: 1, minTokens: 70 }, { threshold: 1, minTokens: 140 })).toEqual(['minTokens: 70 → 140'])
    expect(loosened('.jscpd.json', { threshold: 1 }, { threshold: 1, minLines: 10000, maxLines: 50 })).toEqual([
      'minLines: 5 → 10000',
      'maxLines: 1000 → 50',
    ])
    expect(loosened('.jscpd.json', { threshold: 1 }, { threshold: 0.5, minLines: 3 })).toEqual([])
    // the perf gate's limit is the value plus its tolerance, overrides included
    const perf = (tolerance, calibration = 46) => ({ calibration, tolerance, metrics: { 'idle.saves': { value: 10, unit: 'count' } } })
    expect(loosened('e2e/perf/baseline.json', perf({}), perf({ 'idle.saves': { abs: 0 } }))).toEqual([])
    expect(loosened('e2e/perf/baseline.json', perf({}), perf({ 'idle.saves': { abs: 9 } }))).toEqual(['metrics › idle.saves limit: 13 → 19'])
    expect(loosened('e2e/perf/baseline.json', perf({}), { ...perf({}), metrics: {} })).toEqual(['metrics › idle.saves: removed'])
  })

  it('judges a perf time limit on every runner the speed factor allows', () => {
    // interaction_max_ms: abs 100, rel 0.75 → 200 ms at ×1, 262.5 ms at ×1.5
    const perf = (calibration, tolerance = {}) => ({ calibration, tolerance, metrics: { 'x.interaction_max_ms': { value: 100, unit: 'ms' } } })
    // tighter on the baseline's runner (190 ms), looser on a slow one (285 ms)
    expect(loosened('e2e/perf/baseline.json', perf(40), perf(40, { 'x.interaction_max_ms': { abs: 0, rel: 0.9 } }))).toEqual([
      'metrics › x.interaction_max_ms limit: 262.5 → 285 (runner calibration 60 ms)',
    ])
    // a lower calibration scales every time budget up; without one nothing scales
    expect(loosened('e2e/perf/baseline.json', perf(40), perf(30))).toEqual([
      'metrics › x.interaction_max_ms limit: 200 → 233.33 (runner calibration 40 ms)',
    ])
    expect(loosened('e2e/perf/baseline.json', perf(40), perf(undefined))).toEqual([])
    expect(loosened('e2e/perf/baseline.json', perf(40), perf(50))).toEqual([])
  })
})
