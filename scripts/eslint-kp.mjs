// The house eslint plugin: where an owner correction becomes a check (docs/testing/ci.md ·
// «Corrections become checks»). eslint.config.js registers it as `kp` and scopes each rule.
//
// Every rule here is a WARNING that the per-rule ratchet holds (scripts/lint-ratchet.mjs ·
// scripts/eslint-baseline.json): the existing count may only go down, a new occurrence fails
// `pnpm lint`. A rule that the code already meets everywhere belongs in eslint.config.js as an
// error instead.

const EFFECTS = new Set(['useEffect', 'useLayoutEffect'])
const TIMERS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'])
/** `React.useEffect(…)`, `window.setTimeout(…)`: the objects a global or hook is reached through */
const OWNERS = new Set(['React', 'window', 'globalThis', 'self'])
/** JSX attributes that a user reads or a screen reader speaks */
const COPY_ATTRS = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt'])
/** two letters in a row, any script: «OK» counts, «›» or «12» does not */
const WORDS = /\p{L}{2,}/u
const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)/

/** the called name: `f()` → f, `React.f()` / `window.f()` → f, anything else → undefined */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name
  if (
    callee.type === 'MemberExpression' && !callee.computed &&
    callee.object.type === 'Identifier' && OWNERS.has(callee.object.name) &&
    callee.property.type === 'Identifier'
  ) return callee.property.name
  return undefined
}

/** a rule that reports every call to one of `names` with `message` */
const callRule = (names, message) => ({
  meta: { type: 'suggestion', schema: [], messages: { call: message } },
  create: (context) => ({
    CallExpression(node) {
      const name = calleeName(node.callee)
      if (name && names.has(name)) context.report({ node: node.callee, messageId: 'call', data: { name } })
    },
  }),
})

/** @type {import('eslint').ESLint.Plugin} */
export default {
  rules: {
    // A raw effect needs nuance to get right, and agents copy the ones they see. Product code
    // reaches effects through named hooks in src/lib, where each one is tested once.
    'no-raw-effect': callRule(EFFECTS,
      '{{name}} in product code: use a named hook from src/lib, or write one there with a test.'),

    // A raw timer usually patches over an ordering or layout problem instead of fixing it
    // (and many short-lived timers cost GC pauses on the iPad).
    'no-raw-timer': callRule(TIMERS,
      '{{name}} in product code: fix the ordering it waits for, or use a helper from src/lib.'),

    // Words on a screen come from appConfig.copy.* (German first, then en/fr/it) –
    // docs/copy-and-wording.md. Text written into JSX is never translated.
    'no-literal-copy': {
      meta: { type: 'suggestion', schema: [], messages: { literal: 'Text on a screen comes from appConfig.copy.* – docs/copy-and-wording.md.' } },
      create: (context) => {
        const report = (node) => context.report({ node, messageId: 'literal' })
        return {
          JSXText(node) { if (WORDS.test(node.value)) report(node) },
          'JSXElement > JSXExpressionContainer > Literal, JSXFragment > JSXExpressionContainer > Literal'(node) {
            if (typeof node.value === 'string' && WORDS.test(node.value)) report(node)
          },
          JSXAttribute(node) {
            const name = node.name.type === 'JSXIdentifier' ? node.name.name : undefined
            const v = node.value
            if (!name || !COPY_ATTRS.has(name) || !v) return
            const text = v.type === 'Literal' ? v.value
              : v.type === 'JSXExpressionContainer' && v.expression.type === 'Literal' ? v.expression.value
                : undefined
            if (typeof text === 'string' && WORDS.test(text)) report(v)
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
            const reason = c.value.split('--').slice(1).join('--').trim()
            if (!reason) context.report({ loc: c.loc, messageId: 'bare' })
          }
        },
      }),
    },
  },
}
