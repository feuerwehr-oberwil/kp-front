import tseslint from 'typescript-eslint'
import base from './eslint.config.js'

// The typed lint run, `pnpm lint:typed` (scripts/lint-ratchet.mjs --typed, CI's Frontend job; not
// the pre-push hook). Rules that need the type checker live here, apart from eslint.config.js:
// in one process with the untyped rules the run went past Node's 4 GB default heap (26.11.2026),
// and alone it peaks at 4.4 GB resident, so the script gives Node a 6 GB heap. It lints src/ only,
// with the types of tsconfig.json. Its warnings have their own ratchet,
// scripts/eslint-typed-baseline.json.
//
// The base config's plugins are registered so that an `eslint-disable` of their rules still
// resolves; none of their rules runs here, so an unused-directive report would be noise.
const plugins = Object.assign({}, ...base.map((c) => c.plugins ?? {}))

export default tseslint.config(
  { ignores: base[0].ignores },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // a promise nobody awaits or catches fails without a trace
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },
)
