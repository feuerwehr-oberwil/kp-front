// The house eslint plugin: where an owner correction becomes a check (docs/testing/ci.md ·
// «Corrections become checks»). eslint.config.js registers it as `kp` and scopes each rule.
//
// A rule starts as a WARNING that the per-rule ratchet holds (scripts/lint-ratchet.mjs ·
// scripts/eslint-baseline.json): the existing count may only go down, a new occurrence fails
// `pnpm lint`. Once its count reaches 0 it becomes an error in eslint.config.js.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const EFFECTS = new Set(['useEffect', 'useLayoutEffect'])
const TIMERS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'])
/** `window.setTimeout(…)`: the globals a timer is reached through (React namespaces come from imports) */
const GLOBALS = new Set(['window', 'globalThis', 'self'])
/** attributes and props that a user reads or a screen reader speaks */
const COPY_ATTRS = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label', 'sub', 'hint'])
/** two letters in a row, any script: «OK» counts, «›» or «12» does not */
const WORDS = /\p{L}{2,}/u
/** words that read the same in de/en/fr/it: units and coordinate systems (owner pick 22.11.2026) */
const NEUTRAL = /(?<!\p{L})(?:(?:km\/h|mm\/h|km|bar|min|ppm)(?!\p{L})|(?:LV95|WGS84)(?![\p{L}\p{N}]))/gu
/** elements whose text is a name in code, not copy: `<code>admin_objects</code>` */
const CODE_TAGS = new Set(['code', 'kbd'])
const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)/
/** ESLint's own separator between a directive's rules and its reason */
const REASON = /\s-{2,}\s/u

/**
 * The names a call to one of `names` can take in this file: the bare names, a local alias from
 * `import { useEffect as x } from 'react'`, and `React.` / `import * as R` namespaces.
 */
function reactBindings(program, names) {
  const direct = new Set(names)
  const namespaces = new Set(['React'])
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'react') continue
    for (const s of node.specifiers) {
      // `import R`, `import * as R` and `import { default as R }` all reach React's namespace
      const imported = s.type !== 'ImportSpecifier' ? 'default'
        : s.imported.type === 'Identifier' ? s.imported.name : String(s.imported.value)
      if (names.has(imported)) direct.add(s.local.name)
      else if (imported === 'default') namespaces.add(s.local.name)
    }
  }
  return { direct, namespaces }
}

/** a rule that reports every call to one of `names`; `owners` are the objects it may be reached through */
const callRule = (names, message, { react }) => ({
  meta: { type: 'suggestion', schema: [], messages: { call: message } },
  create: (context) => {
    let direct = names
    let owners = GLOBALS
    return {
      Program(program) {
        if (!react) return
        const b = reactBindings(program, names)
        direct = b.direct
        owners = b.namespaces
      },
      CallExpression(node) {
        const c = node.callee
        const name = c.type === 'Identifier' && direct.has(c.name) ? c.name
          : c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' &&
            owners.has(c.object.name) && c.property.type === 'Identifier' && names.has(c.property.name)
            ? c.property.name : undefined
        if (name) context.report({ node: c, messageId: 'call', data: { name } })
      },
    }
  },
})

/** the string pieces an expression renders: a literal, a template's text and interpolations, either branch of `?:`, the right of `&&`, both sides of `||` / `??` */
function rendered(e) {
  if (!e) return []
  if (e.type === 'Literal') return typeof e.value === 'string' ? [{ node: e, text: e.value }] : []
  if (e.type === 'TemplateLiteral') return [...e.quasis.map((q) => ({ node: e, text: q.value.cooked ?? '' })), ...e.expressions.flatMap(rendered)]
  if (e.type === 'ConditionalExpression') return [...rendered(e.consequent), ...rendered(e.alternate)]
  if (e.type === 'LogicalExpression') return e.operator === '&&' ? rendered(e.right) : [...rendered(e.left), ...rendered(e.right)]
  return []
}

/** @type {import('eslint').ESLint.Plugin} */
export default {
  // ESLint's cache keys on the config, where a plugin is its name and version: the content hash
  // makes an edited rule re-lint every file instead of reusing stale counts.
  meta: { name: 'kp', version: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12) },
  rules: {
    // A raw effect needs nuance to get right, and agents copy the ones they see. Product code
    // reaches effects through named hooks in src/lib, where each one is tested once.
    'no-raw-effect': callRule(EFFECTS,
      '{{name}} in product code: use a named hook from src/lib, or write one there with a test.', { react: true }),

    // A raw timer usually patches over an ordering or layout problem instead of fixing it
    // (and many short-lived timers cost GC pauses on the iPad).
    'no-raw-timer': callRule(TIMERS,
      '{{name}} in product code: fix the ordering it waits for, or use a helper from src/lib.', { react: false }),

    // Words on a screen come from appConfig.copy.* (German first, then en/fr/it) –
    // docs/copy-and-wording.md. Text written into JSX is never translated.
    'no-literal-copy': {
      meta: { type: 'suggestion', schema: [], messages: { literal: 'Text on a screen comes from appConfig.copy.* – docs/copy-and-wording.md.' } },
      create: (context) => {
        // one report per literal (both branches of a `?:` count), one per template
        const reportWords = (pieces) => {
          const words = pieces.filter((p) => WORDS.test(p.text.replace(NEUTRAL, '')))
          for (const node of new Set(words.map((p) => p.node))) context.report({ node, messageId: 'literal' })
        }
        /** a child of `<code>` / `<kbd>` */
        const inCode = (node) => {
          const open = node.parent?.type === 'JSXElement' ? node.parent.openingElement.name : undefined
          return open?.type === 'JSXIdentifier' && CODE_TAGS.has(open.name)
        }
        return {
          JSXText(node) { if (!inCode(node)) reportWords([{ node, text: node.value }]) },
          'JSXElement > JSXExpressionContainer, JSXFragment > JSXExpressionContainer'(node) {
            if (!inCode(node)) reportWords(rendered(node.expression))
          },
          JSXAttribute(node) {
            const name = node.name.type === 'JSXIdentifier' ? node.name.name : undefined
            const v = node.value
            if (!name || !COPY_ATTRS.has(name) || !v) return
            reportWords(v.type === 'Literal' ? rendered(v) : v.type === 'JSXExpressionContainer' ? rendered(v.expression) : [])
          },
        }
      },
    },

    // A disable is an escape hatch; its reason is the one place a reviewer learns why the rule
    // is wrong here. Written after the rule list: `// eslint-disable-next-line rule -- why`.
    'disable-reason': {
      meta: { type: 'suggestion', schema: [], messages: { bare: 'Say why after `--`: `eslint-disable… <rule> -- <reason>`.' } },
      create: (context) => ({
        Program() {
          for (const c of context.sourceCode.getAllComments()) {
            if (!DIRECTIVE.test(c.value)) continue
            const [, ...rest] = c.value.split(REASON)
            if (!rest.join(' ').replace(/^-+/, '').trim()) context.report({ loc: c.loc, messageId: 'bare' })
          }
        },
      }),
    },
  },
}
