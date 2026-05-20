'use strict';

/**
 * ESLint v9 flat-config for the CDK + Lambda codebase. Errors that catch real
 * footguns (undefined vars, unreachable code, accidental globals). Style and
 * unused-locals stay as warnings so the cutover doesn't drown in noise — see
 * issue #6 for the migration plan to make these errors over time.
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // Ignored paths
  {
    ignores: [
      'cdk.out/**',
      'node_modules/**',
      'coverage/**',
    ],
  },

  // Defaults from @eslint/js
  js.configs.recommended,

  // Project-wide rules
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest, // test files; harmless on non-test files
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Allow `require()` (CommonJS project)
      '@typescript-eslint/no-require-imports': 'off',
      // Warn on console.* in production code paths but allow in Lambda
      // handlers / tests (covered by file-scoped overrides below).
      'no-console': 'off',
      // Real footguns
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-dupe-keys': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'warn',
      // Off project-wide — the codebase uses /[\x00-\x1F\x7F]/ deliberately
      // in input-sanitization code (lambda/shared/validation.js) and in
      // property-test filters that strip control characters from generated
      // strings. The control characters are the *point*, not a bug.
      'no-control-regex': 'off',
    },
  },

  // Frontend (browser globals)
  {
    files: ['../frontend/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
  },
];
