import { describe, expect, it } from 'vitest'
import { parseAlarmText } from './alarmText'

// The shapes below are what fwo-divera (src/api/sms.py · _enrich_alarm) actually composes.
// If that generator changes its labels these tests are the thing that should fail.

const LINK = 'https://front.fwo.li/l/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoiaW5j'

describe('parseAlarmText', () => {
  it('keeps a real dispatch message as the message', () => {
    const p = parseAlarmText('Rauch aus Dachstock, Person vermisst\nAusrückeordnung: 1. TLF → 2. PIO')
    expect(p.message).toBe('Rauch aus Dachstock, Person vermisst')
    expect(p.vehicleOrder).toBe('1. TLF → 2. PIO')
    expect(p.machineOnly).toBe(false)
  })

  it('reports an alarm that is pure machinery as such', () => {
    // The case from production: no message at all, and the field still looked full.
    const p = parseAlarmText(
      'Ausrückeordnung: 1. TLF → 2. PIO\n'
      + '\n'
      + 'Einsatzplan Grenzweg 1 – BLT Tramdepot\n'
      + 'Bemerkungen:\n'
      + '  S1 (Verwaltungsgebäude) steht unter Alarm\n'
      + '  Stand Mai 2026: Stromlosschaltung siehe Modul 3\n'
      + `Lage & Pläne: ${LINK}`,
    )
    expect(p.message).toBe('')
    expect(p.machineOnly).toBe(true)
    expect(p.vehicleOrder).toBe('1. TLF → 2. PIO')
    expect(p.plan?.header).toBe('Grenzweg 1 – BLT Tramdepot')
    expect(p.plan?.notes).toEqual([
      'S1 (Verwaltungsgebäude) steht unter Alarm',
      'Stand Mai 2026: Stromlosschaltung siehe Modul 3',
    ])
    expect(p.link).toBe(LINK)
  })

  it('never leaves our own Einsatz-Link in the visible text', () => {
    // 300 characters of JWT is not something to print — and the app it points at is the one
    // doing the printing.
    for (const raw of [
      `Meldung\nLage & Pläne: ${LINK}`,
      `Meldung\nLage & Pläne:\n${LINK}`,   // wrapped by the transport
    ]) {
      const p = parseAlarmText(raw)
      expect(p.link).toBe(LINK)
      expect(p.message).toBe('Meldung')
      expect(p.message).not.toContain('front.fwo.li')
    }
  })

  it('strips the numbering from Sofortmassnahmen but keeps their order', () => {
    const p = parseAlarmText(
      'Einsatzplan Musterstrasse 1\nSofortmassnahmen:\n  1. Hauptschalter Keller\n  2. Lift sperren',
    )
    expect(p.plan?.measures).toEqual(['Hauptschalter Keller', 'Lift sperren'])
  })

  it('passes an unrecognised text through untouched', () => {
    // A station whose gateway composes differently must keep seeing its whole text rather
    // than having it quietly eaten by a parser written for ours.
    const raw = 'Zimmerbrand EFH\nzweiter Stock, Bewohner im Freien'
    const p = parseAlarmText(raw)
    expect(p.message).toBe(raw)
    expect(p.plan).toBeNull()
    expect(p.vehicleOrder).toBe('')
  })

  it('handles nothing at all', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const p = parseAlarmText(raw)
      expect(p.message).toBe('')
      expect(p.machineOnly).toBe(true)
    }
  })
})
