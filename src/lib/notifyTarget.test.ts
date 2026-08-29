import { describe, expect, it } from 'vitest'
import { extractNotifyTarget, matchesNotifyTarget } from './notifyTarget'

describe('extractNotifyTarget', () => {
  it('reads the kpn target from a search string', () => {
    expect(extractNotifyTarget('?kpn=divera')).toBe('divera')
    expect(extractNotifyTarget('?kpn=atemschutz')).toBe('atemschutz')
  })

  it('ignores other params and survives extras', () => {
    expect(extractNotifyTarget('?foo=1&kpn=journal&bar=2')).toBe('journal')
    expect(extractNotifyTarget('?foo=1')).toBeNull()
  })

  it('empty / missing → null (never an empty-string route)', () => {
    expect(extractNotifyTarget('')).toBeNull()
    expect(extractNotifyTarget('?kpn=')).toBeNull()
  })

  it('decodes an encoded target', () => {
    expect(extractNotifyTarget('?kpn=divera%2Dpool')).toBe('divera-pool')
  })
})

describe('matchesNotifyTarget', () => {
  it('accepts the bare surface name — old service workers and old pushes still send it', () => {
    expect(matchesNotifyTarget('atemschutz', ['atemschutz', 'journal'])).toBe(true)
    expect(matchesNotifyTarget('journal', ['atemschutz', 'journal'])).toBe(true)
  })

  it('accepts a payload-carrying target of an accepted surface', () => {
    expect(matchesNotifyTarget('atemschutz:t1724150000000', ['atemschutz', 'journal'])).toBe(true)
  })

  it('rejects other surfaces and lookalike prefixes', () => {
    expect(matchesNotifyTarget('divera', ['atemschutz', 'journal'])).toBe(false)
    // 'atemschutzXY' is a different target, not a payload form of 'atemschutz'
    expect(matchesNotifyTarget('atemschutzXY', ['atemschutz'])).toBe(false)
  })
})
