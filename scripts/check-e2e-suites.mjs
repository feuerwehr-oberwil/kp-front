#!/usr/bin/env node
// The isolated CI suites must cover every ordinary Playwright case exactly once, including
// newly added specs/projects. Discovery only: no browser, database or application is started.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const dedicated = new Set(['perf', 'journeys', 'visual'])
function discover(suite) {
  const env = { ...process.env }
  delete env.E2E_SUITE
  if (suite) env.E2E_SUITE = suite
  const report = JSON.parse(execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
    env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }))
  const cases = []
  function visit(group) {
    for (const spec of group.specs ?? []) {
      for (const test of spec.tests) {
        if (!dedicated.has(test.projectName)) cases.push(JSON.stringify([
          test.projectName, spec.file, spec.line, spec.column, spec.title,
        ]))
      }
    }
    for (const child of group.suites ?? []) visit(child)
  }
  visit(report)
  return cases
}

const expected = discover()
assert(expected.length > 0, 'No ordinary browser tests discovered')
const actual = ['field', 'recovery', 'workspace'].flatMap((suite) => {
  const cases = discover(suite)
  assert(cases.length > 0, `Empty browser suite: ${suite}`)
  console.log(`${suite}: ${cases.length} discovered cases`)
  return cases
})
assert.equal(new Set(actual).size, actual.length, 'A browser case appears in multiple suites')
assert.deepEqual(actual.sort(), expected.sort(), 'The CI suites omit or invent browser cases')
console.log(`All ${expected.length} ordinary browser cases are assigned exactly once`)
