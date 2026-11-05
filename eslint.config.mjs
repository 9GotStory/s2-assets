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
    files: ['**/tests/**', '**/tests/**/*', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'prefer-const': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  }
);
