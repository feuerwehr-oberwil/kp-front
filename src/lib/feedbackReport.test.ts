import { describe, it, expect } from 'vitest'
import {
  buildReport, buildTechBlock, buildSubject, mailtoUrl, troubleLabel, NEVER_INCLUDED,
  type ReportEnv, type ReportInput,
} from './feedbackReport'

const env: ReportEnv = {
  build: 'v0.2.0 · a1b2c3d · 25.07.2026',
  locale: 'de-CH',
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)',
  viewport: '1024×768',
  online: false,
}

const at = 1_800_000_000_000
const fmtTime = () => '25.07.2026, 03:12'

describe('buildTechBlock', () => {
  it('carries the fields that make a bug reproducible', () => {
    const block = buildTechBlock({ env, message: '' })
    expect(block).toContain('v0.2.0 · a1b2c3d · 25.07.2026')
    expect(block).toContain('de-CH')
    expect(block).toContain('iPad')
    expect(block).toContain('1024×768')
  })

  it('records the online state — a lot of behaviour depends on it', () => {
    expect(buildTechBlock({ env, message: '' })).toMatch(/offline/)
    expect(buildTechBlock({ env: { ...env, online: true }, message: '' })).toMatch(/online/)
  })

  it('names the trouble and when it happened', () => {
    const block = buildTechBlock({ env, message: '', trouble: { kind: 'crashLoop', at }, fmtTime })
    expect(block).toContain(troubleLabel('crashLoop'))
    expect(block).toContain('25.07.2026, 03:12')
  })

  it('omits the incident line entirely when nothing triggered the prompt', () => {
    const block = buildTechBlock({ env, message: '' })
    expect(block).not.toContain(troubleLabel('crash'))
  })
})

describe('buildReport', () => {
  it("leads with the operator's words — that is the part a human reads", () => {
    const report = buildReport({ env, message: 'Trupp auf Rückweg, dann weisser Bildschirm.' })
    expect(report.indexOf('Trupp auf Rückweg')).toBeLessThan(report.indexOf('v0.2.0'))
  })

  it('still produces a usable report when the operator wrote nothing', () => {
    const report = buildReport({ env, message: '   ' })
    expect(report).toContain('(keine Beschreibung)')
    expect(report).toContain('v0.2.0')
  })

  it('never leaks operational data', () => {
    // The guard rail. Rather than guessing at forbidden shapes, assert the tech block is
    // EXACTLY the known lines: anything a future edit adds shows up here as an unexpected
    // label and fails, which is the whole point.
    const input: ReportInput = {
      env,
      message: 'nichts Besonderes',
      trouble: { kind: 'storageFull', at },
      fmtTime,
    }
    const [, tech] = buildReport(input).split('\n--\n')
    const labels = tech.trim().split('\n').map((l) => l.split(/\s{2,}|:\s*/)[0].replace(/:$/, ''))
    expect(labels).toEqual(['Version', 'Sprache', 'Gerät', 'Fenster', 'Netz', 'Vorfall'])

    // and the named fields never appear anywhere in the report
    const lower = buildReport(input).toLowerCase()
    for (const forbidden of NEVER_INCLUDED) {
      expect(lower).not.toContain(forbidden.toLowerCase())
    }
    expect(lower).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i) // uuid-shaped (incident ids)
  })
})

describe('buildSubject', () => {
  it('names the trouble so triage is possible from the inbox list', () => {
    const s = buildSubject({ env, message: '', trouble: { kind: 'crash', at } }, 'KP Front')
    expect(s).toContain('KP Front')
    expect(s).toContain(troubleLabel('crash'))
  })

  it('falls back to a plain subject when opened from Einstellungen', () => {
    expect(buildSubject({ env, message: '' }, 'KP Front')).toBe('KP Front: Rückmeldung')
  })
})

describe('mailtoUrl', () => {
  it('encodes newlines and & so the body is not truncated by the mail client', () => {
    const url = mailtoUrl('a@b.ch', 'Betreff & mehr', 'Zeile 1\nZeile 2 & 3')
    expect(url.startsWith('mailto:a@b.ch?')).toBe(true)
    expect(url).not.toContain('\n')
    expect(url).toContain('%0A')
    expect(url.split('body=')[1]).not.toContain('&')
  })

  it('round-trips the body', () => {
    const body = 'Umlaute: ä ö ü\n\n--\nVersion: v0.2.0'
    const url = mailtoUrl('a@b.ch', 's', body)
    expect(decodeURIComponent(url.split('body=')[1])).toBe(body)
  })
})
