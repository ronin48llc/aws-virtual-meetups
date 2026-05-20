'use strict';

/**
 * ESLint v9 flat-config for the CDK + Lambda codebase.
 *
 * All rules are at `error` severity. Zero-warnings is the bar — the
 * existing backlog was cleaned up when this config landed and the rule
 * patterns (`^_` prefix for intentionally-unused args/vars/caught errors)
 * are the documented escape hatch.
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
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Allow `require()` (CommonJS project)
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
      // Real footguns
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': 'error',
      'no-dupe-keys': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'error',
      'no-useless-escape': 'error',
      // Off project-wide — the codebase uses /[\x00-\x1F\x7F]/ deliberately
      // in input-sanitization code (lambda/shared/validation.js) and in
      // property-test filters that strip control characters from generated
      // strings. The control characters are the *point*, not a bug.
      'no-control-regex': 'off',
    },
    linterOptions: {
      // Flag any `// eslint-disable-...` directive that doesn't actually
      // silence a real violation. Forces the codebase to keep disables
      // tied to real reasons rather than accumulating dead comments.
      reportUnusedDisableDirectives: 'error',
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

  // Jest test files that opt into the jsdom environment via the
  // `@jest-environment jsdom` docblock get browser globals (document,
  // window, etc.). ESLint can't read the docblock, so we tell it via a
  // file-glob override on tests that load HTML fixtures.
  {
    files: ['test/unit/frontend-*.test.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
];
