import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./audit-toolchain.sh', import.meta.url))
const shell = `
  date() { [[ "$*" == "-u +%F" ]] && echo "$TEST_DATE"; }
  pnpm() {
    case "$*" in
      "why --prod picomatch") echo "$PRODUCTION_TREE" ;;
      "audit --audit-level moderate") echo "ran audit"; return "$AUDIT_EXIT" ;;
      *) return 2 ;;
    esac
  }
  source "$1"
`

function audit(day, productionTree = '', auditExit = 0) {
  return spawnSync('bash', ['-c', shell, 'audit-test', script], {
    encoding: 'utf8', env: { ...process.env, TEST_DATE: day, PRODUCTION_TREE: productionTree, AUDIT_EXIT: String(auditExit) },
  })
}

describe('development-only Picomatch exception', () => {
  it('runs the full audit on the last covered UTC day', () => {
    const result = audit('2026-12-31')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('ran audit')
  })

  it('expires when the first uncovered UTC day starts', () => {
    const result = audit('2027-01-01')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('2027-01-01')
  })

  it('rejects production use even on the last covered day', () => {
    const result = audit('2026-12-31', 'app → dependency → picomatch')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Production paths')
  })

  it('propagates an audit failure inside the approved window', () => {
    expect(audit('2026-12-30', '', 9).status).toBe(9)
  })
})
