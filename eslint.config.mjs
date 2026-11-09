import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/.tmp*/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // A FastifyReply is thenable: awaiting a Promise<FastifyReply> waits until the reply is sent and
    // yields undefined, so a helper that hands one back lets its route run on after a 403 (#51).
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSTypeReference[typeName.name='Promise'] TSTypeReference[typeName.name='FastifyReply']",
          message:
            'A FastifyReply is thenable, so awaiting it yields undefined. Return a decision (such as a boolean) and let the route handler send the reply.',
        },
      ],
    },
  },
  {
    // #66: a request that starts while a page's last route is removed can stay paused with no
    // response, so unrouteAll is only the last statement of its block.
    files: ['apps/web/tests/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ExpressionStatement:not(:last-child) > AwaitExpression > CallExpression[callee.property.name='unrouteAll']",
          message: 'Remove routes by name until the journey ends: unrouteAll takes the catch-all route with it (#66).',
        },
        {
          // Playwright 1.63 marks networkidle DISCOURAGED for tests and points to web assertions.
          selector: "Literal[value='networkidle']",
          message: 'Wait with a web assertion on what the page shows: Playwright discourages networkidle in tests (#75).',
        },
        {
          // #75: a read that lands between the two statements finds the user with no role.
          selector:
            'ExpressionStatement:matches([expression.argument.arguments.0.value=/DELETE FROM user_roles/], [expression.argument.arguments.0.quasis.0.value.raw=/DELETE FROM user_roles/]) + ExpressionStatement:matches([expression.argument.arguments.0.value=/INSERT INTO user_roles/], [expression.argument.arguments.0.quasis.0.value.raw=/INSERT INTO user_roles/])',
          message: 'Change a role with one UPDATE, so that no read of an open page finds the user without one (#75).',
        },
      ],
    },
  },
  {
    files: ['**/tests/**', '**/tests/**/*', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'prefer-const': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  }
);
