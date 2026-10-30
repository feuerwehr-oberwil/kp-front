// Keep test selection in Vitest: Stryker 10.1.1's `testFiles` makes static mutations activate
// in beforeAll, after module constants were initialized, and reports false survivors. The
// serverClock cache-prefix canary (docs/testing/ci.md) must kill all three static mutations.
import { defineConfig } from 'vitest/config'
import baseConfig from './vite.config.ts'

export default defineConfig((env) => {
  const base = baseConfig(env)
  return { ...base, test: {
    ...base.test,
    include: [
      'src/lib/atemschutz.test.ts',
      'src/lib/auditEventStore.test.ts',
      'src/lib/eventScope.test.ts',
      'src/lib/jsonEqual.test.ts',
      'src/lib/mergeWorkspace.test.ts',
      'src/lib/serialQueue.test.ts',
      'src/lib/serverClock.test.ts',
      'src/lib/syncAlert.test.ts',
      'src/lib/undoTimeline.test.ts',
      'src/lib/alarm.test.ts',
      'src/lib/alarmReadiness.test.ts',
    ],
  } }
})
