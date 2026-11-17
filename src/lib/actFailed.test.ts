import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { actFailedText } from './actFailed'

// Rare-user round F8 (17.11.2026): «Server nicht erreichbar» alone after «Öffnen» left open whether
// the Einsatz exists. The act leads, the reason sits in it, the next step stays at the end.
const act = 'Alarm nicht übernommen – erneut «Öffnen», es entsteht kein zweiter Einsatz'
const transport = (status: number, detail: string) => Object.assign(new ApiError(status, detail), { hint: 'Gespeicherte Einsätze bleiben offline verfügbar.' })

describe('actFailedText', () => {
  it('puts a transport failure\'s reason after the head, keeping the next step', () => {
    expect(actFailedText(transport(0, 'Server nicht erreichbar'), act))
      .toBe('Alarm nicht übernommen (Server nicht erreichbar) – erneut «Öffnen», es entsteht kein zweiter Einsatz')
    expect(actFailedText(transport(502, 'Server antwortet nicht'), act)).toContain('(Server antwortet nicht) – erneut')
  })

  it('lets a refusal the server worded stand, and says the act alone for anything else', () => {
    expect(actFailedText(new ApiError(409, 'Alarm bereits übernommen'), act)).toBe('Alarm bereits übernommen')
    expect(actFailedText(new Error('boom'), act)).toBe(act)
  })
})
