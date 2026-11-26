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
      'src/lib/mergeWorkspace.test.ts',
      'src/lib/serverClock.test.ts',
      'src/lib/syncAlert.test.ts',
      'src/lib/undoTimeline.test.ts',
      'src/lib/alarm.test.ts',
      'src/lib/alarmReadiness.test.ts',
      'src/lib/api/workspaceSync.test.ts',
      'src/lib/api/workspaceSync.denial.test.ts',
      'src/lib/api/workspaceSync.foreignParked.test.ts',
      'src/lib/api/workspaceSync.load.test.ts',
      'src/lib/api/workspaceSync.recovery.test.ts',
      'src/lib/api/workspaceSync.sameSecond.test.ts',
      'src/lib/api/workspaceSync.truppNumbers.test.ts',
      // workspaceSync's exports and its closed-incident and older-build paths are tested here
      'src/lib/api/recordSliceKeys.test.ts',
      'src/lib/effectiveSyncStatus.test.ts',
      'src/lib/incidentClosed.twoDevice.test.ts',
      'src/lib/olderBuild.sync.test.ts',
      'src/lib/mediaQueue.test.ts',
    ],
  } }
})
