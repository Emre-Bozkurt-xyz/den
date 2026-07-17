// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
