// Stryker 10.1.1's testFiles option falsely survives static mutants with the Vitest runner.
// This canary checks the actual runner, including activation before module initialization.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const config = JSON.parse(readFileSync('stryker.config.json', 'utf8'))
const file = 'src/lib/serverClock.ts'
const line = readFileSync(file, 'utf8').split('\n').findIndex((s) => s.startsWith('const SW_CACHED_API_PREFIXES = ')) + 1
assert.ok(line > 0, 'The clock cache-prefix declaration moved; update the mutation canary')
const configPath = `.x-mutation-smoke-${process.pid}.json`
const report = 'reports/mutation-smoke/mutation.json'
try {
  writeFileSync(configPath, JSON.stringify({
    ...config,
    mutate: [`${file}:${line}-${line}`],
    concurrency: 1,
    incremental: false,
    reporters: ['clear-text', 'json'],
    jsonReporter: { fileName: report },
    thresholds: { high: 100, low: 100, break: 100 },
  }))
  execFileSync('pnpm', ['exec', 'stryker', 'run', configPath], { stdio: 'inherit' })
  const mutants = JSON.parse(readFileSync(report, 'utf8')).files[file].mutants
  assert.equal(mutants.length, 3, 'Expected the array deletion and two cache-prefix changes')
  assert.ok(mutants.every((m) => m.static && m.status === 'Killed'), 'All static canary mutants must fail assertions, without timeouts')
  console.log('Mutation runner canary: 3/3 static mutants killed by assertions.')
} finally {
  rmSync(configPath, { force: true })
}
