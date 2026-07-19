import { describe, expect, it } from 'vitest'
import { extractNotifyTarget } from './notifyTarget'

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
