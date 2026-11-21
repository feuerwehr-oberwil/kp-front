import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import kp from './eslint-kp.mjs'

// One valid and one invalid case per line of each rule's contract (scripts/eslint-kp.mjs).
RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } })

tester.run('no-raw-effect', kp.rules['no-raw-effect'], {
  valid: ['useMemo(() => 1, [])', 'useEffectOnce()', 'other.useEffect()'],
  invalid: [
    { code: 'useEffect(() => {}, [])', errors: 1 },
    { code: 'React.useLayoutEffect(() => {})', errors: 1 },
  ],
})

tester.run('no-raw-timer', kp.rules['no-raw-timer'], {
  valid: ['clearTimeout(t)', 'sched.setTimeout(f, 1)'],
  invalid: [
    { code: 'setTimeout(f, 1)', errors: 1 },
    { code: 'window.requestAnimationFrame(f)', errors: 1 },
    { code: 'globalThis.setInterval(f, 5)', errors: 1 },
  ],
})

tester.run('no-literal-copy', kp.rules['no-literal-copy'], {
  valid: [
    '<b>{C.title}</b>',
    '<b>› 12 {n}</b>',
    '<b data-x="abc" className="row" />',
    '<b title={C.close} aria-label={`${n}`} />',
  ],
  invalid: [
    { code: '<b>Schliessen</b>', errors: 1 },
    { code: "<b>{'Zurück'}</b>", errors: 1 },
    { code: '<b title="Löschen" />', errors: 1 },
    { code: "<b aria-label={'Menü'} />", errors: 1 },
  ],
})

tester.run('disable-reason', kp.rules['disable-reason'], {
  valid: [
    '// eslint-disable-next-line no-console -- the boot log is the point\nconsole.log(1)',
    '/* eslint-disable no-console -- a CLI */',
    '// eslint-enable no-console',
    '// eslint-disabled is not a directive',
  ],
  invalid: [
    { code: '// eslint-disable-next-line no-console\nconsole.log(1)', errors: 1 },
    { code: 'f() // eslint-disable-line no-console', errors: 1 },
    { code: '/* eslint-disable no-console */', errors: 1 },
  ],
})
