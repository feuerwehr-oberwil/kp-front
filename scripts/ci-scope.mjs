#!/usr/bin/env node
// Which gates `just ci` runs for this branch: prints `ci-all`, `ci-no-backend`, `ci-backend`, or
// nothing. A stack's gates run when the branch changes one of its files, or a file its code or
// tests name by path — the backend tests read src/data/, src/lib/prefs.ts, examples/, public/ and
// CHANGELOG.md, the frontend tests read backend JSON and Python. The change set is everything that
// differs from the merge base with origin/main: committed, staged, unstaged and untracked. GitHub
// CI still runs every gate, so a wrong skip turns the PR red, never main. `just ci-all` forces
// everything. docs/testing/ci.md has the whole picture.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Who owns a changed file; `named` files reach a stack only when its sources name them. */
const OWNERS = [
  // The gates themselves, the cross-repo contract, and the scripts both stacks' tests run.
  ['both', /^justfile$|^shared\/|^scripts\/.*\.(?:py|sh)$/],
  ['backend', /^backend\/|^docker-compose\.dev\.yml$/],
  ['frontend', /^(?:src|public|site|e2e|tools|scripts)\/|^(?:package\.json|pnpm-[\w-]+\.yaml|index\.html|[\w.-]+\.config\.[jt]s|tsconfig[\w.-]*\.json)$/],
  ['named', /./],
]

/** The sources that can read a file from disk, per stack. */
const READERS = {
  backend: /^backend\/.*\.py$/,
  frontend: /^(?:src|scripts|site|e2e)\/.*\.(?:ts|tsx|mjs|js)$|^vite\.config\.ts$/,
}

/**
 * Source text a path can be read from: comments and docstrings dropped (they name files they
 * only talk about), Python path joins flattened so `ROOT / "src" / "data"` reads `"src/data"`.
 */
export function readable(text, language) {
  const code =
    language === 'py'
      ? text.replace(/("""|''')[\s\S]*?\1/g, '').replace(/#[^\n]*/g, '')
      : text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  return code.replace(/(["'])\s*\/\s*\1/g, '/')
}

/**
 * Whether `source` reads `path`: a string that ends in the path or one of its folders below the
 * top (`ROOT / "src/data/boardTemplates"`, `'../../backend/app/api/events.py'`); a root file only
 * as a whole quoted name. A path mid-string is prose or test data («see docs/X.md», a stack trace).
 */
export function names(source, path) {
  const parts = path.split('/')
  const ends = (p) => ['"', "'", '`'].some((q) => source.includes(p + q))
  if (parts.length === 1) return ['"', "'"].some((q) => source.includes(q + path + q))
  return parts.slice(1).some((_, i) => ends(parts.slice(0, i + 2).join('/')))
}

/** Per stack, the first changed file that reaches it (null: skip). `sources` from `readable`. */
export function scope(files, sources) {
  const why = { frontend: null, backend: null }
  for (const f of files) {
    const [owner] = OWNERS.find(([, re]) => re.test(f))
    for (const stack of ['frontend', 'backend']) {
      if (owner === 'both' || owner === stack || names(sources[stack], f)) why[stack] ??= f
    }
  }
  return why
}

/** The recipe that runs exactly the reached stacks. */
export const recipe = ({ frontend, backend }) =>
  frontend && backend ? 'ci-all' : frontend ? 'ci-no-backend' : backend ? 'ci-backend' : ''

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const lines = (s) => s.split('\n').filter(Boolean)

export function readSources() {
  const tracked = lines(git('ls-files')).filter((f) => existsSync(f))
  const read = (re) =>
    tracked
      .filter((f) => re.test(f))
      .map((f) => readable(readFileSync(f, 'utf8'), f.endsWith('.py') ? 'py' : 'js'))
      .join('\n')
  return { backend: read(READERS.backend), frontend: read(READERS.frontend) }
}

function changedFiles() {
  const base = git('merge-base', 'origin/main', 'HEAD').trim()
  return [...new Set([...lines(git('diff', '--name-only', base)), ...lines(git('ls-files', '--others', '--exclude-standard'))])]
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = changedFiles()
  // No change against main (or on main itself): nothing to narrow down.
  const none = 'no change against origin/main'
  const why = files.length ? scope(files, readSources()) : { frontend: none, backend: none }
  const say = (stack) => (why[stack] ? `runs (${why[stack]})` : 'skipped')
  console.error(`ci-scope: ${files.length} changed files · frontend ${say('frontend')} · backend ${say('backend')}`)
  console.log(recipe(why))
}
