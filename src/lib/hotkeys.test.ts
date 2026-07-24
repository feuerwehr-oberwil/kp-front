import { describe, it, expect } from 'vitest'
import { resolveHotkey, isTypingTarget, type HotkeyCommand } from './hotkeys'

// minimal KeyboardEvent stand-in — resolveHotkey only reads these five fields
const ev = (key: string, mod: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mod }) as KeyboardEvent

const resolve = (key: string, mod?: Partial<KeyboardEvent>): HotkeyCommand | null => resolveHotkey(ev(key, mod))

describe('resolveHotkey — modules & fit (numbers address the plan modules)', () => {
  it('digits 1..9 map to the module with that number', () => {
    for (let n = 1; n <= 9; n++) expect(resolve(String(n))).toEqual({ type: 'module', n })
  })
  it('0 is einpassen/fit, not a module', () => {
    expect(resolve('0')).toEqual({ type: 'fit' })
  })
})

describe('resolveHotkey — non-module surfaces carry their own letter', () => {
  it('K/H/A/W/I select the fixed surfaces', () => {
    expect(resolve('k')).toEqual({ type: 'surface', surface: 'map' })
    expect(resolve('h')).toEqual({ type: 'surface', surface: 'checklists' })
    expect(resolve('a')).toEqual({ type: 'surface', surface: 'atemschutz' })
    expect(resolve('w')).toEqual({ type: 'surface', surface: 'anwesenheit' })
    expect(resolve('i')).toEqual({ type: 'surface', surface: 'mittel' })
  })
})

describe('resolveHotkey — doc-level ops need Cmd/Ctrl', () => {
  it('Cmd+Z undo, Cmd+Shift+Z redo, Ctrl+Y redo', () => {
    expect(resolve('z', { metaKey: true })).toEqual({ type: 'undo' })
    expect(resolve('z', { metaKey: true, shiftKey: true })).toEqual({ type: 'redo' })
    expect(resolve('y', { ctrlKey: true })).toEqual({ type: 'redo' })
  })
  it('handles capital Z (Shift produces uppercase key)', () => {
    expect(resolve('Z', { metaKey: true, shiftKey: true })).toEqual({ type: 'redo' })
  })
  it('Cmd+D duplicates; bare d is the Messen tool (no collision)', () => {
    expect(resolve('d', { metaKey: true })).toEqual({ type: 'duplicate' })
    expect(resolve('d')).toEqual({ type: 'tool', tool: 'measure' })
  })
  it('Cmd+[ / Cmd+] step surfaces, Cmd+, opens settings', () => {
    expect(resolve('[', { metaKey: true })).toEqual({ type: 'nav', dir: -1 })
    expect(resolve(']', { ctrlKey: true })).toEqual({ type: 'nav', dir: 1 })
    expect(resolve(',', { metaKey: true })).toEqual({ type: 'panel', panel: 'settings' })
  })
})

describe('resolveHotkey — bare tool/panel/view keys', () => {
  it('maps the tool letters (Absperrkreis is P — K belongs to the Karte surface)', () => {
    expect(resolve('v')).toEqual({ type: 'tool', tool: 'select' })
    expect(resolve('m')).toEqual({ type: 'tool', tool: 'lasso' })
    expect(resolve('s')).toEqual({ type: 'tool', tool: 'symbol' })
    expect(resolve('l')).toEqual({ type: 'tool', tool: 'line' })
    expect(resolve('f')).toEqual({ type: 'tool', tool: 'area' })
    expect(resolve('p')).toEqual({ type: 'tool', tool: 'circle' })
    expect(resolve('n')).toEqual({ type: 'tool', tool: 'note' })
    expect(resolve('t')).toEqual({ type: 'tool', tool: 'team' })
  })
  it('maps the panel letters', () => {
    expect(resolve('j')).toEqual({ type: 'panel', panel: 'journal' })
    expect(resolve('e')).toEqual({ type: 'panel', panel: 'composer' })
    expect(resolve('b')).toEqual({ type: 'panel', panel: 'layers' })
    expect(resolve('o')).toEqual({ type: 'panel', panel: 'picker' })
  })
  it('maps the view keys', () => {
    expect(resolve('g')).toEqual({ type: 'view', view: 'locate' })
    expect(resolve('c')).toEqual({ type: 'view', view: 'coord' })
    expect(resolve('r')).toEqual({ type: 'view', view: 'north' })
    expect(resolve('+')).toEqual({ type: 'view', view: 'zoomIn' })
    expect(resolve('=')).toEqual({ type: 'view', view: 'zoomIn' })
    expect(resolve('-')).toEqual({ type: 'view', view: 'zoomOut' })
  })
  it('? opens help', () => {
    expect(resolve('?')).toEqual({ type: 'panel', panel: 'help' })
  })
  it('is case-insensitive for letters', () => {
    expect(resolve('S')).toEqual({ type: 'tool', tool: 'symbol' })
  })
})

describe('resolveHotkey — non-shortcuts', () => {
  it('bare letters that are not bound return null', () => {
    for (const k of ['q', 'u', 'x', 'y', 'z']) expect(resolve(k)).toBeNull()
  })
  it('a bound letter with Cmd is NOT a bare tool (never hijack browser combos)', () => {
    expect(resolve('s', { metaKey: true })).toBeNull() // Cmd+S = browser save
    expect(resolve('l', { ctrlKey: true })).toBeNull()
  })
  it('Alt combos are ignored', () => {
    expect(resolve('v', { altKey: true })).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('detects inputs / textareas / contentEditable', () => {
    expect(isTypingTarget({ tagName: 'INPUT', isContentEditable: false } as unknown as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA', isContentEditable: false } as unknown as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as unknown as Element)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
