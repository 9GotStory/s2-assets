import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// An awaited call, such as pool.query, whose first argument is a string or template with this text.
const awaitedCallWith = (text) =>
  `ExpressionStatement:matches([expression.argument.arguments.0.value=/${text}/], [expression.argument.arguments.0.quasis.0.value.raw=/${text}/])`;

// A later block replaces no-restricted-syntax whole, so the blocks on apps/api/src share these.
const NO_PROMISED_REPLY = {
  selector: "TSTypeReference[typeName.name='Promise'] TSTypeReference[typeName.name='FastifyReply']",
  message:
    'A FastifyReply is thenable, so awaiting it yields undefined. Return a decision (such as a boolean) and let the route handler send the reply.',
};

// SQL text that writes one of these tables, as a string or in a template.
const writesTo = (tables, owner) => {
  const sql = `\\b(INSERT INTO|UPDATE|DELETE FROM)\\s+(${tables})\\b`;
  return {
    selector: `:matches(Literal[value=/${sql}/], TemplateElement[value.raw=/${sql}/])`,
    message: `Write this table through ${owner}, the module that owns it (#76).`,
  };
};
const WRITES_TO_LOAN_TABLES = writesTo('loans|loan_items|loan_item_endings|loan_due_date_extensions', 'loan.service.ts');
const WRITES_TO_ASSIGNMENT_CHANGES = writesTo('assignment_changes', 'assignment.service.ts');
const apiSyntaxRule = (...guards) => ({ 'no-restricted-syntax': ['error', NO_PROMISED_REPLY, ...guards] });

// An awaited expect, by its matcher, and whether it goes through .not.
const matcher = (name) => `[expression.argument.callee.property.name='${name}']`;
const NEGATED = "[expression.argument.callee.object.property.name='not']";
const NOT_NEGATED = "[expression.argument.callee.object.property.name!='not']";
const ABSENCE = `ExpressionStatement:matches(${matcher('toHaveCount')}[expression.argument.arguments.0.value=0]${NOT_NEGATED}, ${matcher('toBeHidden')}${NOT_NEGATED}, ${matcher('toBeVisible')}${NEGATED}, ${matcher('toBeAttached')}${NEGATED})`;

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
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES),
  },
  {
    files: ['apps/api/src/services/loan.service.ts'],
    rules: {
      ...apiSyntaxRule(WRITES_TO_ASSIGNMENT_CHANGES),
      // asset.service.ts imports this module for the Asset search (#78): importing it back is a cycle.
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: './asset.service.ts', message: 'Import from asset-lookups.ts or service-errors.ts: asset.service.ts imports loan.service.ts (#78).' }],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/services/assignment.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES),
  },
  {
    // #76: data kept across a key change shows one query's values under another's.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name='placeholderData'] > :matches(ArrowFunctionExpression[params.length=1], Identifier[name='keepPreviousData'])",
          message: 'Keep placeholder data only after comparing previousQuery: these values may belong to another key (#76).',
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
          selector: `${awaitedCallWith('DELETE FROM user_roles')} + ${awaitedCallWith('INSERT INTO user_roles')}`,
          message: 'Change a role with one UPDATE, so that no read of an open page finds the user without one (#75).',
        },
        {
          // #76: the page has read nothing yet, so the absence holds whatever its facts say.
          selector: `ExpressionStatement${matcher('goto')} + ${ABSENCE}`,
          message: 'Assert what the loaded page shows before what it does not: right after goto, nothing is there yet (#76).',
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
