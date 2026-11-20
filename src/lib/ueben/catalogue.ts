// «Üben»: the topics, in ONE short list, each a chain of short steps (owner picks, 20.11.2026:
// «a simple way to learn the app without being overwhelming» – and, after the first look, not
// «only scratching the top part of the surface»: the list stays short, the depth is in the steps).
// The ORDER is the order on the sheet and the one «Weiter» walks. Only a topic whose steps run is
// listed: a new one joins `TOPICS` together with its copy (`copy.ueben.topics.<id>`), and the
// sheet, the progress and the e2e walker (e2e/ueben.spec.ts) pick it up from here.
//
// Every other function is practised without a task: «Ausprobieren» in a Hilfe section opens the
// Übungsplatz on that surface (lib/ueben/tryOut).

import { appConfig } from '../../config/appConfig'
import { karte } from './karte'
import type { Step, Topic } from './model'

export const TOPICS = [karte] as const satisfies readonly Topic[]

export type TopicId = (typeof TOPICS)[number]['id']
/** a step's id – unique over ALL topics: it is what this device's done list holds */
export type StepId = (typeof TOPICS)[number]['steps'][number]['id']

type Placed = { topic: TopicId; id: StepId; step: Step; i: number; n: number }
const PLACED: readonly Placed[] = TOPICS.flatMap((t) => t.steps.map((step, i) => ({ topic: t.id, id: step.id, step, i: i + 1, n: t.steps.length })))

export const ALL_TOPICS: readonly TopicId[] = TOPICS.map((t) => t.id)
export const ALL_STEPS: readonly StepId[] = PLACED.map((p) => p.id)

export const isStepId = (v: unknown): v is StepId => ALL_STEPS.some((id) => id === v)

/** A step with its topic and its place in it («Karte & Zeichnen · 2 / 6»). */
export const placeOf = (id: StepId): Placed | undefined => PLACED.find((p) => p.id === id)

export const stepsOf = (topic: TopicId): readonly StepId[] => PLACED.filter((p) => p.topic === topic).map((p) => p.id)

/** The step that follows `id` in its topic – null after the topic's last one. */
export function stepAfter(id: StepId): StepId | null {
  const at = PLACED.findIndex((p) => p.id === id)
  const next = PLACED[at + 1]
  return at >= 0 && next && next.topic === PLACED[at].topic ? next.id : null
}

/** Where a topic stands on this device: how many of its steps are done, and the step it goes on
 *  with – the first one not done, the first one at all once the topic is through. */
export function topicProgress(topic: TopicId, done: ReadonlySet<StepId>): { n: number; total: number; next: StepId } {
  const steps = stepsOf(topic)
  return { n: steps.filter((id) => done.has(id)).length, total: steps.length, next: steps.find((id) => !done.has(id)) ?? steps[0] }
}

/** The first topic not through on this device. */
export const nextTopic = (done: ReadonlySet<StepId>): TopicId | null =>
  ALL_TOPICS.find((t) => stepsOf(t).some((id) => !done.has(id))) ?? null

/** A topic's copy: title, intro and what its closing card names. */
export const topicCopy = (topic: TopicId): { title: string; intro: string; more: readonly string[] } => appConfig.copy.ueben.topics[topic]

/** A step's copy: title, task, the goals' words and what the done card says was learned. */
export function stepCopy(id: StepId): { title: string; task: string; goals: Record<string, string>; learned: string } {
  const p = PLACED.find((x) => x.id === id)
  const steps: Record<string, { title: string; task: string; goals: Record<string, string>; learned: string }> = p ? appConfig.copy.ueben.topics[p.topic].steps : {}
  return steps[id]
}
