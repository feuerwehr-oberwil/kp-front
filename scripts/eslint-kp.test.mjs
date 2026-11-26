// @ts-check
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'
import kp from './eslint-kp.mjs'

// One valid and one invalid case per line of each rule's contract (scripts/eslint-kp.mjs).
RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({ languageOptions: { sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } } })

tester.run('no-raw-effect', kp.rules['no-raw-effect'], {
  valid: [
    'useMemo(() => 1, [])', 'useEffectOnce()', 'other.useEffect()', "import { useEffect as e } from './mine'\ne()",
    "import { useMemo as m } from 'react'\nm.useEffect()",
  ],
  invalid: [
    { code: 'useEffect(() => {}, [])', errors: 1 },
    { code: 'React.useLayoutEffect(() => {})', errors: 1 },
    { code: "import { useEffect as onMount } from 'react'\nonMount(() => {})", errors: 1 },
    { code: "import * as R from 'react'\nR.useEffect(() => {})", errors: 1 },
    { code: "import { 'useEffect' as onMount } from 'react'\nonMount(() => {})", errors: 1 },
    { code: "import { default as R } from 'react'\nR.useEffect(() => {})", errors: 1 },
    { code: "import { 'default' as R } from 'react'\nR.useEffect(() => {})", errors: 1 },
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
    '<b>{busy ? C.saving : C.save}</b>',
    '<Row variant="primary" sub={C.open} />',
    '<b>{n} km/h · {p} bar · {m} min</b>',
    '<b>LV95 {x}<br />WGS84 {y}</b>',
    '<b>{t}10min</b>',
    "<b>{low ? `${p} bar` : clock}</b>",
    '<li><code>tafel:{id}</code><kbd>Esc</kbd></li>',
  ],
  invalid: [
    { code: '<b>Schliessen</b>', errors: 1 },
    { code: "<b>{'Zurück'}</b>", errors: 1 },
    { code: '<b title="Löschen" />', errors: 1 },
    { code: "<b aria-label={'Menü'} />", errors: 1 },
    { code: "<b>{busy ? 'Speichern…' : C.save}</b>", errors: 1 },
    { code: "<b>{open && 'Offen'}</b>", errors: 1 },
    { code: "<b>{busy ? 'Speichern…' : 'Speichern'}</b>", errors: 2 },
    { code: '<b title={`Menü ${n} Eintrag`} />', errors: 1 },
    { code: "<b>{`${busy ? 'Offen' : 'Zu'}`}</b>", errors: 2 },
    { code: "<b>{(busy && 'Speichern…') || C.save}</b>", errors: 1 },
    { code: "<b>{name ?? 'Unbekannt'}</b>", errors: 1 },
    { code: '<b aria-label={`Menü ${n}`} />', errors: 1 },
    { code: '<Row sub="Offen" />', errors: 1 },
    { code: '<b>{n} km/h Wind</b>', errors: 1 },
    { code: '<b>{n} Minuten</b>', errors: 1 },
    { code: '<b>WGS840 {y}</b>', errors: 1 },
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
    { code: '/* eslint-disable no-console --- */', errors: 1 },
  ],
})
