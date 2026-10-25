import { describe, expect, it } from 'vitest'
import { readable, recipe, scope } from './ci-scope.mjs'

// The cross-reads are the repo's own (19.10.2026): backend/tests/test_board_templates.py,
// test_board_symbol_scale.py, test_version_consistency.py and src/lib/eventScope.test.ts.
const sources = {
  backend: readable(
    [
      'BUNDLED = REPO / "src" / "data" / "boardTemplates"',
      'PREFS = ROOT / "src/lib/prefs.ts"',
      'changelog = (ROOT / "CHANGELOG.md").read_text()',
      '# mirrors src/components/Combo.tsx',
      '"""See docs/CONFIGURATION.md for the keys."""',
      'raise ValueError("see docs/CONFIGURATION.md §4c")',
      'STACK = "at MapView (/x/src/components/MapView.tsx:88)"',
    ].join('\n'),
    'py',
  ),
  frontend: readable(
    [
      "const src = readFileSync(new URL('../../backend/app/api/events.py', import.meta.url), 'utf8')",
      '// the contract with backend/app/admin_objects.py',
    ].join('\n'),
    'js',
  ),
}
const run = (...files) => recipe(scope(files, sources)) || 'none'

describe('ci scope', () => {
  it('skips the backend for a component change the backend never reads', () => {
    expect(run('src/components/MapView.tsx', 'src/components/Combo.tsx')).toBe('ci-no-backend')
  })

  it('runs the backend for frontend files its tests read, by folder or by file', () => {
    expect(run('src/data/boardTemplates/new-template.json')).toBe('ci-all')
    expect(run('src/lib/prefs.ts')).toBe('ci-all')
  })

  it('skips the frontend for a backend change no frontend test reads', () => {
    expect(run('backend/app/admin_objects.py')).toBe('ci-backend')
    expect(run('backend/app/api/events.py')).toBe('ci-all')
  })

  it('runs a stack for a root file only when it reads that file', () => {
    expect(run('CHANGELOG.md')).toBe('ci-backend')
    expect(run('README.md', 'docs/CONFIGURATION.md')).toBe('none')
  })

  it('runs everything when the gates themselves change', () => {
    expect(run('justfile')).toBe('ci-all')
    expect(run('scripts/backup.sh')).toBe('ci-all')
  })
})
