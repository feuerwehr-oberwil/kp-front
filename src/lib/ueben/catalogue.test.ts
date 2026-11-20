import { describe, expect, it } from 'vitest'
import { ALL_STEPS, ALL_TOPICS, nextTopic, placeOf, stepAfter, stepCopy, stepsOf, topicCopy, topicProgress, TOPICS, type StepId } from './catalogue'
import type { Snapshot, Topic } from './model'
import { siteOf, siteScene } from './site'

describe('Üben · catalogue', () => {
  it('a step id is unique over all topics – it is what the done list holds', () => {
    expect(new Set(ALL_STEPS).size).toBe(ALL_STEPS.length)
  })

  it('every topic, step and goal has its words', () => {
    for (const topic of TOPICS) {
      const t = topicCopy(topic.id)
      expect(t.title && t.intro).toBeTruthy()
      expect(t.more.length).toBeGreaterThan(0)
      for (const step of topic.steps) {
        const c = stepCopy(step.id)
        expect(c.title && c.task && c.learned, step.id).toBeTruthy()
        for (const goal of step.goals) expect(c.goals[goal.id], `${step.id} · ${goal.id}`).toBeTruthy()
      }
    }
  })

  it('a topic goes on with its first step not done, and «Weiter» ends at its last step', () => {
    const topic = ALL_TOPICS[0]
    const steps = stepsOf(topic)
    expect(placeOf(steps[1])).toMatchObject({ topic, i: 2, n: steps.length })
    expect(topicProgress(topic, new Set())).toEqual({ n: 0, total: steps.length, next: steps[0] })
    expect(topicProgress(topic, new Set([steps[0], steps[2]]))).toEqual({ n: 2, total: steps.length, next: steps[1] })
    // through: it starts over
    expect(topicProgress(topic, new Set(steps)).next).toBe(steps[0])
    expect(stepAfter(steps[0])).toBe(steps[1])
    expect(stepAfter(steps[steps.length - 1])).toBeNull()
    expect(nextTopic(new Set())).toBe(topic)
    expect(nextTopic(new Set<StepId>(ALL_STEPS))).toBeNull()
  })
})

// The chain itself, for EVERY topic: what «Weiter» and «Lösung» rely on. A step added to a topic
// is covered without a line here.
describe('Üben · every step', () => {
  const scene = () => siteScene([7.55, 47.51])
  // as the runner sees them: plain `Step`s (the catalogue keeps each step's own narrower type)
  const topics: readonly Topic[] = TOPICS

  for (const topic of topics) {
    it(`${topic.id}: «Lösung» reaches every goal in order, from the start the step before left`, () => {
      let doc = scene()
      for (const step of topic.steps) {
        doc = step.setup(doc, siteOf(doc.entities))
        let since: Snapshot = doc
        for (const [i, goal] of step.goals.entries()) {
          const site = siteOf(doc.entities)
          expect(goal.check(doc, site, since).s, `${step.id} · ${goal.id} before`).not.toBe('ok')
          doc = step.solve(doc, site, i, since)
          expect(goal.check(doc, siteOf(doc.entities), since), `${step.id} · ${goal.id} after`).toEqual({ s: 'ok' })
          since = doc
        }
      }
    })

    it(`${topic.id}: every step starts on its own – its start builds what the steps before it leave`, () => {
      for (const step of topic.steps) {
        let doc = step.setup(scene(), siteOf(scene().entities))
        // the start is stable: a Lage that already is the start stays untouched
        expect(step.setup(doc, siteOf(doc.entities)), step.id).toBe(doc)
        let since: Snapshot = doc
        for (const [i, goal] of step.goals.entries()) {
          doc = step.solve(doc, siteOf(doc.entities), i, since)
          expect(goal.check(doc, siteOf(doc.entities), since), `${step.id} · ${goal.id}`).toEqual({ s: 'ok' })
          since = doc
        }
      }
    })
  }
})
