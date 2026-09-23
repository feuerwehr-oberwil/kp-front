import { describe, expect, it } from 'vitest'
import { EL_EVENT_PREFIXES, eventScopeFor, observedEventId } from './eventScope'

describe('eventScopeFor — the client mirror of the server allowlist', () => {
  it('an editor appends everything', () => {
    const scope = eventScopeFor({ role: 'editor' })
    for (const op of ['atemschutz.alarm', 'entity.move', 'draw.add', 'attendance.set']) expect(scope(op)).toBe(true)
  })

  // post-mortem 23.09.2026, D6: the `el` phone's alarm engine emitted `atemschutz.alarm`, the
  // server 403'd it, and the outbox stayed red for three hours
  it('the `el` role appends the record vocabulary and NOT the Atemschutz alarm', () => {
    const scope = eventScopeFor({ role: 'el' })
    expect(scope('atemschutz.alarm')).toBe(false)
    expect(scope('atemschutz.alarm.cleared')).toBe(false)
    expect(scope('entity.move')).toBe(false)
    for (const p of EL_EVENT_PREFIXES) expect(scope(`${p}x`)).toBe(true)
  })

  it('an Atemschutz-Link appends `atemschutz.*` only; every other link and a viewer nothing', () => {
    for (const kind of ['atemschutz', 'atemschutz-standing'] as const) {
      const scope = eventScopeFor({ role: 'viewer', link_kind: kind })
      expect(scope('atemschutz.alarm')).toBe(true)
      expect(scope('weather.observe')).toBe(false)
    }
    for (const kind of ['alarm', 'view', 'terminal'] as const) expect(eventScopeFor({ role: 'viewer', link_kind: kind })('atemschutz.alarm')).toBe(false)
    expect(eventScopeFor({ role: 'viewer' })('journal.add')).toBe(false)
    expect(eventScopeFor(null)('journal.add')).toBe(false)
  })

  it('mirrors the backend prefix list exactly', async () => {
    // a drift here is either a lost record (too few) or the red outbox again (too many)
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../backend/app/api/events.py', import.meta.url), 'utf8')
    const block = /EL_EVENT_PREFIXES = \(([\s\S]*?)\n\)/.exec(src)?.[1] ?? ''
    const backend = [...block.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1])
    expect(backend.length).toBeGreaterThan(0)
    expect([...EL_EVENT_PREFIXES].sort()).toEqual(backend.sort())
  })
})

describe('observedEventId — one event per observer, not per device', () => {
  const key = 'azal-tr1790184777162-2026-09-23T17:36:14.228Z'
  const actor = '9ff2397e-5c1c-4d6e-8a50-2c1f4b1f0c11:login'

  it('is the same on every device of one login, and differs per actor and per alarm', () => {
    expect(observedEventId(key, actor)).toBe(observedEventId(key, actor))
    expect(observedEventId(key, actor)).not.toBe(observedEventId(key, 'someone-else:login'))
    expect(observedEventId(key, actor)).not.toBe(observedEventId(key, `${actor.split(':')[0]}:atemschutz`))
    expect(observedEventId(key, actor)).not.toBe(observedEventId(key.replace('17:36', '17:43'), actor))
  })

  it('stays inside the server’s 128 characters, deterministically', () => {
    const long = `azal-${'x'.repeat(200)}`
    const id = observedEventId(long, actor)
    expect(id.length).toBeLessThanOrEqual(128)
    expect(observedEventId(long, actor)).toBe(id)
    expect(observedEventId(`${long}y`, actor)).not.toBe(id)
    expect(observedEventId(key, actor).length).toBeLessThanOrEqual(128)
  })
})
