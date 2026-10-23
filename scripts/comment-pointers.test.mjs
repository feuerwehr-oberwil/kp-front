import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Code comments point at the `docs/` page that holds a rule, never at the repo guide for agents:
// that file is a short index whose headings move (39 comments pointed at sections it no longer
// had after #385). Every page and its topic: docs/README.md.
const GUIDE = ['AGENTS', 'md'].join('.')
const CODE = /\.(ts|tsx|js|mjs|cjs|css|py|sh)$/

describe('comment pointers', () => {
  it('no code file names the agents guide – point at the docs/ page instead', () => {
    const files = execFileSync('git', ['ls-files', 'src', 'backend', 'e2e', 'scripts', 'shared', 'tools'], { encoding: 'utf-8' })
      .split('\n')
      .filter((f) => CODE.test(f))
    const hits = files.flatMap((f) =>
      readFileSync(f, 'utf-8')
        .split('\n')
        .flatMap((line, i) => (line.includes(GUIDE) ? [`${f}:${i + 1}`] : [])),
    )
    expect(hits).toEqual([])
  })
})
