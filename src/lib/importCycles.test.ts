import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// No VALUE import ring in src/ (sweep 23.10.2026, B.12). A ring of value imports works only as
// long as every module in it exports functions: the first top-level constant read during module
// init turns it into a TDZ error at boot, on whichever import order the bundler picked. The one
// ring there was (api/incidents → api/workspace → incidentClosed → api/incidents) was broken by
// moving isIncidentRunning to a leaf (lib/incidentRunning).
//
// Type-only imports are erased and cannot form a runtime ring, so they do not count (the copy
// overlays' `import type { Copy } from '../index'` is the common harmless case); neither does a
// dynamic import(), which runs after init. Break a reported ring by moving the shared piece to a
// leaf module, or by making one leg `import type`.

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    if (!/\.tsx?$/.test(e.name) || /\.(test|bench)\.tsx?$/.test(e.name) || e.name.endsWith('.d.ts')) return []
    return [p]
  })
}

const resolveLocal = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null // a package
  const base = resolve(dirname(from), spec)
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(p) && existsSync(p)) return p
  }
  return null // a css module, an asset, a `?worker&url`
}

/** The modules a file imports for their VALUES (type-only imports and exports left out). */
function valueImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
  const out: string[] = []
  for (const st of sf.statements) {
    let spec: ts.Expression | undefined
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings)
        && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)))
      if (!typeOnly) spec = st.moduleSpecifier
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const typeOnly = st.isTypeOnly || (!!st.exportClause && ts.isNamedExports(st.exportClause)
        && st.exportClause.elements.length > 0 && st.exportClause.elements.every((e) => e.isTypeOnly))
      if (!typeOnly) spec = st.moduleSpecifier
    }
    if (spec && ts.isStringLiteral(spec)) {
      const to = resolveLocal(file, spec.text)
      if (to) out.push(to)
    }
  }
  return out
}

/** Strongly connected components with more than one module (Tarjan), or a module importing itself. */
function rings(graph: Map<string, string[]>): string[][] {
  let next = 0
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>()
  const found: string[][] = []
  const visit = (v: string) => {
    index.set(v, next); low.set(v, next); next++
    stack.push(v); on.add(v)
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
    }
    if (low.get(v) !== index.get(v)) return
    const scc: string[] = []
    let w: string
    do { w = stack.pop()!; on.delete(w); scc.push(w) } while (w !== v)
    if (scc.length > 1 || graph.get(v)?.includes(v)) found.push(scc)
  }
  for (const v of graph.keys()) if (!index.has(v)) visit(v)
  return found
}

describe('import graph', () => {
  it('has no ring of value imports', () => {
    const files = sourceFiles(SRC)
    const graph = new Map(files.map((f) => [f, valueImports(f)]))
    // guard the guard: a parser that silently stopped seeing imports would make this pass forever
    expect([...graph.values()].reduce((n, e) => n + e.length, 0)).toBeGreaterThan(2000)
    const found = rings(graph).map((scc) => scc.map((f) => relative(SRC, f)).sort().join(' ↔ '))
    expect(found).toEqual([])
  }, 30_000) // parses every module in src/ with the TS compiler – ~1 s idle, 8 s on a loaded box
})
