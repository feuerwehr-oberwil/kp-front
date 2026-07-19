import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Flat config. Mirrors the backend's ruff gate: the build/CI runs `pnpm lint`.
// The high-value rule for this codebase is react-hooks (rules-of-hooks as an error,
// exhaustive-deps as a warning so the intentional one-time-init suppressions stay
// explicit). TS/style findings are warnings — they surface without wedging CI.
export default tseslint.config(
  // `.claude` holds transient agent worktrees (full repo copies) that must not be linted.
  { ignores: ['dist', 'dev-dist', 'coverage', 'node_modules', '.claude'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // rules-of-hooks is the non-negotiable correctness rule → stays an error.
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps + the React-Compiler static rules (immutability, purity,
      // set-state-in-effect, refs, preserve-manual-memoization) flag real cleanup that
      // is exactly the Phase 2/3 component refactor. Surface them as warnings now so the
      // lint gate is green and the signal is visible, then burn them down during the split.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // console.error/warn are intentional (ErrorBoundary, load failures); ban only log/debug.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // the codebase deliberately uses side-effecting ternaries / short-circuits as statements.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // only flag when EVERY destructured binding could be const (some share a let reassignment).
      'prefer-const': ['error', { destructuring: 'all' }],
      // pragmatic for an in-flight refactor — surface, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // test files run under node + vitest globals
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
)
