// The Lage-Grundgerüst's rules, pure: which list an Einsatz gets, when a row is done, where the
// card suggests putting a thing — and the two vocabularies the backend restates (the category
// labels in divera.py, the line presets in lage_grundgeruest.py), read straight out of the files.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appConfig } from '../config/appConfig'
import { haversineM } from './geo'
import {
  CATEGORY_LABELS, categoryKey, destinationPoint, grundgeruestProgress, grundgeruestRows,
  HYDRANT_MAX_M, hydrantNr, hydrantPoints, isHydrantLayer, linePresetIdFor, listFor, nearestHydrant,
  ownLocation, panClearOf, placeable, slotMatch, slotsFor, suggestionFor, suggestionText, takeOverKind, upwindPoint,
  type LageGrundgeruestPresets, type LageSlot,
} from './lageGrundgeruest'
import type { TacticalObject } from './tacticalObjects'
import type { LngLat, WeatherData } from '../types'

const KP: LageSlot = { id: 'kp', label: 'KP · Einsatzleitung', symbol: 'VKF KP Front', vorschlag: { wind: 'auf', m: 40 } }
const ZUFAHRT: LageSlot = { id: 'zufahrt', label: 'Zufahrt', linie: 'Zufahrt' }
const WASSER: LageSlot = { id: 'wasser', label: 'Wasserbezug', symbol: 'SI Wasserbezugsort', vorschlag: { naechster: 'hydrant' } }
const SAMMEL: LageSlot = { id: 'sammel', label: 'Sammelplatz', symbol: 'FW Sammelplatz' }
const HELI: LageSlot = { id: 'heli', label: 'Helilandeplatz', symbol: 'VKF Helilandeplatz', optional: true }

const PRESETS: LageGrundgeruestPresets = {
  'fks-standard': { kategorien: { brandbekaempfung: [KP, ZUFAHRT, WASSER, SAMMEL], strassenrettung: [KP, HELI] } },
  minimal: { kategorien: { brandbekaempfung: [KP, SAMMEL], diverse_einsaetze: [SAMMEL] } },
}

const CENTER: LngLat = [8.0, 47.0]

const onKarte = (symbol: string, extra: Partial<TacticalObject> = {}): TacticalObject =>
  ({ id: `o-${symbol}`, entity: { id: `o-${symbol}`, kind: 'symbol', layer: 'op', coord: CENTER, symbol }, ...extra }) as TacticalObject
const onPlan = (symbol: string): TacticalObject =>
  ({ id: `p-${symbol}`, sheet: { planId: 'modul6', anno: { id: `p-${symbol}`, kind: 'symbol', x: 0.4, y: 0.5, symbol } } }) as TacticalObject

describe('which list an Einsatz gets', () => {
  it('maps the stored German type to its category key', () => {
    expect(categoryKey('Brandbekämpfung')).toBe('brandbekaempfung')
    expect(categoryKey('BMA / unechte Alarme')).toBe('bma_unechte_alarme')
    expect(categoryKey('strassenrettung')).toBe('strassenrettung')
    expect(categoryKey('')).toBeNull()
    expect(categoryKey('Irgendwas')).toBeNull()
  })

  it('follows the Einsatzart, and a corrected one re-picks the list', () => {
    expect(slotsFor(null, PRESETS, 'Brandbekämpfung').slots.map((s) => s.id)).toEqual(['kp', 'zufahrt', 'wasser', 'sammel'])
    expect(slotsFor(null, PRESETS, 'Strassenrettung').slots.map((s) => s.id)).toEqual(['kp', 'heli'])
  })

  it('falls back to the Brand list when no Einsatzart is known — and says so', () => {
    for (const type of [null, '', 'Unbekannt', 'Diverse Einsätze']) {
      const sel = slotsFor({ preset: 'fks-standard' }, PRESETS, type)
      expect(sel.fallback).toBe(true)
      expect(sel.category).toBe('brandbekaempfung')
      expect(sel.slots.map((s) => s.id)).toEqual(['kp', 'zufahrt', 'wasser', 'sammel'])
    }
  })

  it('«Diverse Einsätze» with a list of its own is a deliberate answer, not a fallback', () => {
    const sel = slotsFor({ preset: 'minimal' }, PRESETS, 'Diverse Einsätze')
    expect(sel).toEqual({ category: 'diverse_einsaetze', slots: [SAMMEL], fallback: false })
  })

  it('a known Einsatzart the station did not cover shows nothing', () => {
    expect(slotsFor(null, PRESETS, 'Gerettete Tiere')).toEqual({ category: 'gerettete_tiere', slots: [], fallback: false })
  })

  it('the station replaces single Einsatzarten; an empty list is an answer', () => {
    const cfg = { preset: 'fks-standard', kategorien: { brandbekaempfung: [SAMMEL], strassenrettung: [] } }
    expect(listFor(cfg, PRESETS, 'brandbekaempfung')).toEqual([SAMMEL])
    expect(listFor(cfg, PRESETS, 'strassenrettung')).toEqual([])
    expect(slotsFor(cfg, PRESETS, 'Brandbekämpfung').slots).toEqual([SAMMEL])
  })

  it('names the preset in charge, and an unknown one falls back to the default', () => {
    expect(listFor({ preset: 'minimal' }, PRESETS, 'brandbekaempfung')).toEqual([KP, SAMMEL])
    expect(listFor({ preset: 'retired' }, PRESETS, 'brandbekaempfung')).toEqual([KP, ZUFAHRT, WASSER, SAMMEL])
    // an older server serves no presets at all: nothing to show, nothing invented
    expect(slotsFor(null, {}, 'Brandbekämpfung').slots).toEqual([])
  })
})

describe('when a row is done', () => {
  it('a matching symbol on the Karte ticks it', () => {
    expect(slotMatch(SAMMEL, [onKarte('FW Sammelplatz')])).toEqual({ done: true, onKarte: true, onPlan: null })
    expect(slotMatch(SAMMEL, [onKarte('FW Warteraum')]).done).toBe(false)
  })

  it('a symbol that exists only on a plan still ticks, and is offered onto the Karte at a tap', () => {
    const plan = onPlan('FW Sammelplatz')
    expect(slotMatch(SAMMEL, [plan])).toEqual({ done: true, onKarte: false, onPlan: plan })
    expect(takeOverKind(plan)).toBe('tap')
  })

  it('a plan symbol baked onto the Karte through its fit is still the PLAN\'s — offered, in place', () => {
    // the 23.09.2026 case: a Sammelplatz drawn on a Gebäude storey shows on the Karte, and ticked
    // there without any way to make it the Karte's
    const both = { ...onPlan('FW Sammelplatz'), entity: onKarte('FW Sammelplatz').entity } as TacticalObject
    expect(slotMatch(SAMMEL, [both])).toEqual({ done: true, onKarte: false, onPlan: both })
    expect(takeOverKind(both)).toBe('inPlace')
  })

  it('once one is Karte-anchored, nothing is offered', () => {
    expect(slotMatch(SAMMEL, [onPlan('FW Sammelplatz'), onKarte('FW Sammelplatz')]).onPlan).toBeNull()
  })

  it('a line on an unlinked sheet has no ground position a tap could give it', () => {
    const planLine = { id: 'l3', sheet: { planId: 'm1', anno: { id: 'l3', kind: 'draw', pts: [], arrow: true, marker: 'Z' } } } as unknown as TacticalObject
    expect(takeOverKind(planLine)).toBeNull()
    expect(takeOverKind(null)).toBeNull()
    expect(takeOverKind(onKarte('FW Sammelplatz'))).toBeNull()
  })

  it('a live feed marker never counts', () => {
    const live = onKarte('VKF KP Front')
    live.entity!.live = true
    expect(slotMatch(KP, [live]).done).toBe(false)
  })

  it('a line is matched by the preset its style names — on the Karte or on a plan', () => {
    const z = appConfig.drawing.linePresets.find((p) => p.id === 'zufahrt')!.defaults
    const karteLine = { id: 'l1', drawing: { id: 'l1', kind: 'line', coords: [CENTER, CENTER], arrow: z.arrow, marker: z.marker } } as unknown as TacticalObject
    const rettung = { id: 'l2', drawing: { id: 'l2', kind: 'line', coords: [CENTER, CENTER], arrow: true, marker: 'R' } } as unknown as TacticalObject
    const planLine = { id: 'l3', sheet: { planId: 'm1', anno: { id: 'l3', kind: 'draw', pts: [], arrow: true, marker: 'Z' } } } as unknown as TacticalObject
    expect(slotMatch(ZUFAHRT, [karteLine]).onKarte).toBe(true)
    expect(slotMatch(ZUFAHRT, [rettung]).done).toBe(false)
    expect(slotMatch(ZUFAHRT, [planLine])).toMatchObject({ done: true, onKarte: false })
  })

  it('«2 / 6» counts required rows only; complete needs every required one', () => {
    const rows = grundgeruestRows([KP, SAMMEL, HELI], [onKarte('VKF KP Front')], { center: CENTER, weather: null, hydrants: null })
    expect(grundgeruestProgress(rows)).toEqual({ done: 1, total: 2, complete: false })
    const all = grundgeruestRows([KP, SAMMEL, HELI], [onKarte('VKF KP Front'), onPlan('FW Sammelplatz')], { center: CENTER, weather: null, hydrants: null })
    expect(grundgeruestProgress(all)).toEqual({ done: 2, total: 2, complete: true })
    // nothing but optional rows (or none) is never «complete» — there is nothing to finish
    expect(grundgeruestProgress(grundgeruestRows([HELI], [], { center: CENTER, weather: null, hydrants: null })).complete).toBe(false)
    expect(grundgeruestProgress([]).complete).toBe(false)
  })
})

describe('where the card suggests a thing', () => {
  const wind = (dir: number | null, speed: number | null = 12): WeatherData =>
    ({ wind_dir_deg: dir, wind_speed_kmh: speed, wind_gust_kmh: null, temp_c: null, precip_mm: null, weather_code: null, observed_at: null, source: 't', station: null })

  it('puts a point the asked distance away on the asked bearing', () => {
    const p = destinationPoint(CENTER, 270, 80)
    expect(haversineM(CENTER, p)).toBeCloseTo(80, 1)
    expect(p[0]).toBeLessThan(CENTER[0])
    expect(p[1]).toBeCloseTo(CENTER[1], 5)
  })

  it('«Wind aufwärts» is the FROM bearing: wind from W ⇒ west of the Einsatzort', () => {
    const p = upwindPoint(CENTER, wind(270), 80)!
    expect(p[0]).toBeLessThan(CENTER[0])
    expect(haversineM(CENTER, p)).toBeCloseTo(80, 1)
    const n = upwindPoint(CENTER, wind(0), 40)!
    expect(n[1]).toBeGreaterThan(CENTER[1])
  })

  it('no reading, or calm, is no upwind suggestion', () => {
    expect(upwindPoint(CENTER, null, 40)).toBeNull()
    expect(upwindPoint(CENTER, wind(null), 40)).toBeNull()
    expect(upwindPoint(CENTER, wind(270, 1), 40)).toBeNull()
    // a direction without a speed is still a direction
    expect(upwindPoint(CENTER, wind(270, null), 40)).not.toBeNull()
  })

  it('names the wind the way the badge does, and the side it suggests', () => {
    const s = suggestionFor(KP, { center: CENTER, weather: wind(270), hydrants: null })!
    expect(s).toMatchObject({ kind: 'wind', fromDeg: 270, m: 40 })
    expect(suggestionText(s)).toBe('Wind aus W · Vorschlag westlich, 40 m')
  })

  it('says WHEN the wind reading was taken (source + timestamp, 3am tenet)', () => {
    const at = new Date(2026, 8, 24, 14, 5)
    const s = suggestionFor(KP, { center: CENTER, weather: { ...wind(270), observed_at: at.toISOString() }, hydrants: null })!
    expect(suggestionText(s)).toBe('Wind aus W (14:05) · Vorschlag westlich, 40 m')
  })

  it('no location of the incident\'s own, no suggestion at all — the station default is not the Einsatzort', () => {
    const points = [{ coord: [8.0005, 47.0003] as LngLat, nr: '7' }]
    expect(suggestionFor(KP, { center: null, weather: wind(270), hydrants: points })).toBeNull()
    expect(suggestionFor(WASSER, { center: null, weather: wind(270), hydrants: points })).toBeNull()
    expect(ownLocation(0, 0)).toBeNull()
    expect(ownLocation(null, 47.5)).toBeNull()
    expect(ownLocation(8.1, 47.1)).toEqual([8.1, 47.1])
  })

  it('a hydrant further than the cap is no answer — said, never placeable', () => {
    const far = destinationPoint(CENTER, 90, HYDRANT_MAX_M + 50)
    const s = suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: [{ coord: far, nr: '9' }] })!
    expect(s.kind).toBe('noHydrant')
    expect(placeable(s)).toBe(false)
    expect(suggestionText(s)).toBe(`Kein Hydrant im Umkreis von ${HYDRANT_MAX_M} m`)
    const near = destinationPoint(CENTER, 90, HYDRANT_MAX_M - 50)
    expect(placeable(suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: [{ coord: near, nr: '9' }] }))).toBe(true)
  })

  it('finds the nearest hydrant by straight line, with its number', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [8.005, 47.004] }, properties: { nr: 'H-9' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [8.0005, 47.0003] }, properties: { NR: 17 } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[8.0, 47.0], [8.001, 47.001]] }, properties: {} },
      ],
    }
    const points = hydrantPoints(fc)
    expect(points).toHaveLength(2)
    const near = nearestHydrant(CENTER, points)!
    expect(near.nr).toBe('17')
    const s = suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: points })!
    expect(s.kind).toBe('hydrant')
    expect(suggestionText(s)).toMatch(/^Hydrant Nr\. 17 · \d+ m$/)
  })

  it('a hydrant without a number is still the nearest hydrant', () => {
    const s = suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: [{ coord: [8.0005, 47.0003], nr: null }] })!
    expect(suggestionText(s)).toMatch(/^Nächster Hydrant · \d+ m$/)
  })

  it('no hydrant data, no suggestion — the row still arms the tool', () => {
    expect(suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: null })).toBeNull()
    expect(suggestionFor(WASSER, { center: CENTER, weather: null, hydrants: [] })).toBeNull()
    expect(suggestionFor(SAMMEL, { center: CENTER, weather: wind(90), hydrants: [] })).toBeNull()
  })

  it('a done row carries no suggestion', () => {
    const rows = grundgeruestRows([KP], [onKarte('VKF KP Front')], { center: CENTER, weather: wind(90), hydrants: null })
    expect(rows[0].suggestion).toBeNull()
  })

  it('reads a hydrant number off the usual property names — never an id or a name', () => {
    expect(hydrantNr({ Nummer: ' 17 ' })).toBe('17')
    expect(hydrantNr({ art: 'Überflurhydrant' })).toBeNull()
    expect(hydrantNr({ id: 'f-83b1', name: 'Hof Nord' })).toBeNull()
    expect(hydrantNr(null)).toBeNull()
  })

  it('finds the station hydrant layer among the reference layers', () => {
    expect(isHydrantLayer({ id: 'demo-hydrant', geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant' })).toBe(true)
    expect(isHydrantLayer({ id: 'wasser', label: 'Hydranten', geojson: '/x', vectorKind: 'point' })).toBe(true)
    expect(isHydrantLayer({ id: 'demo-wasserleitung', geojson: '/x', vectorKind: 'line', label: 'Hydrantenleitung' })).toBe(false)
    expect(isHydrantLayer({ id: 'hydrant-wms' })).toBe(false)
  })
})

describe('the vocabularies the backend restates', () => {
  it('the category labels are divera.CATEGORY_LABELS', () => {
    const src = readFileSync(new URL('../../backend/app/divera.py', import.meta.url), 'utf8')
    const block = /CATEGORY_LABELS: dict\[str, str\] = \{([\s\S]*?)\n\}/.exec(src)![1]
    const backend = Object.fromEntries([...block.matchAll(/"([a-z_]+)": "([^"]+)"/g)].map((m) => [m[1], m[2]]))
    expect(CATEGORY_LABELS).toEqual(backend)
  })

  it('the line presets a slot may name are the labels of appConfig.drawing.linePresets', () => {
    const src = readFileSync(new URL('../../backend/app/lage_grundgeruest.py', import.meta.url), 'utf8')
    const line = /LINE_PRESETS: tuple\[str, \.\.\.\] = \(([^)]*)\)/.exec(src)![1]
    const backend = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    // Freihand is the neutral line — a slot that places it would tick on every scribble
    expect(backend).toEqual(appConfig.drawing.linePresets.slice(1).map((p) => p.label))
    for (const label of backend) expect(linePresetIdFor(label)).toBeDefined()
  })
})

describe('panClearOf — «hier setzen» never lands under the card', () => {
  const card = { left: 100, top: 600, right: 440, bottom: 1060 }
  it('a point clear of the card needs no pan', () => {
    expect(panClearOf({ x: 600, y: 700 }, card)).toBeNull()
    expect(panClearOf({ x: 300, y: 400 }, card)).toBeNull()
  })
  it('takes the shorter way out: sideways near the right edge, up near the top', () => {
    // near the right edge: moving the content right by 440+48-420 = 68 px is shorter than up
    expect(panClearOf({ x: 420, y: 900 }, card)).toEqual([-68, 0])
    // near the top: up by 620-(600-48) = 68 px is shorter than right (440+48-150)
    expect(panClearOf({ x: 150, y: 620 }, card)).toEqual([0, 68])
  })
})
