// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dev-dist/**',
      '**/node_modules/**',
      'app/public/**',
      'deploy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TS files: the TypeScript compiler already resolves identifiers, so
    // eslint's no-undef is redundant and produces false positives on DOM/Node
    // globals. Disable it for TS (typescript-eslint's recommendation).
    files: ['**/*.ts', '**/*.tsx'],
    rules: { 'no-undef': 'off' },
  },
  {
    // Plain Node scripts (.mjs): give them Node globals.
    files: ['**/*.mjs', '**/scripts/**'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    // Rules-of-hooks enforcement for the PWA. Added 2026-08-12 after a
    // feature where the only thing standing between us and a hooks-order
    // crash was people reasoning carefully by hand — twice, a hook called
    // inside a `.map()` over a variable-length list was caught by review
    // rather than by tooling. There is no component test harness here, so
    // this is the only mechanical guard against that class of bug.
    files: ['app/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Dependency completeness stays a WARNING, not an error: this codebase
      // has several deliberate, documented partial dependency lists (mount-
      // only effects reading refs, `ChatView`'s scroll-on-keyboard-edge).
      // Turning it into an error would either bury those in disable comments
      // or invite mechanical "fixes" that change behaviour.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      // `any` is allowed only with a justifying comment (enforced by review, not lint),
      // but flag the accidental ones.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
