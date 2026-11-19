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

// SQL text, as a string or in a template, that matches this pattern.
const sqlText = (sql, message, flags = '') => ({
  selector: `:matches(Literal[value=/${sql}/${flags}], TemplateElement[value.raw=/${sql}/${flags}])`,
  message,
});
const writesTo = (tables, owner) =>
  sqlText(`\\b(INSERT INTO|UPDATE|DELETE FROM)\\s+(${tables})\\b`, `Write this table through ${owner}, the module that owns it (#76).`);
// #100: a rule that reads another feature's facts belongs to that feature's read module. The table
// follows FROM, JOIN or USING, or the earlier tables of a comma join, in either case. A name built
// with ${…} or a Kysely builder call goes unseen.
const readsFrom = (tables, owners) =>
  sqlText(
    `\\b(FROM|JOIN|USING)\\s+(\\w+(\\s+(AS\\s+)?\\w+)?\\s*,\\s*)*(${tables})\\b`,
    `Read this table through ${owners}, the modules that own it (#100).`,
    'i'
  );
const LOAN_TABLES = 'loans|loan_\\w+';
const REPAIR_TABLES = 'repair_\\w+';
// #157 retro: Retired has one SQL source, in retirement-read.service.ts (CODING_STANDARDS, a derived condition).
const RETIREMENT_TABLES = 'retirements|retirement_\\w+';
const WRITES_TO_LOAN_TABLES = writesTo(LOAN_TABLES, 'loan.service.ts');
const WRITES_TO_ASSIGNMENT_CHANGES = writesTo('assignment_changes', 'assignment.service.ts');
const WRITES_TO_REPAIR_TABLES = writesTo(REPAIR_TABLES, 'repair.service.ts');
const READS_LOAN_TABLES = readsFrom(LOAN_TABLES, 'services/loan*.ts');
const READS_REPAIR_TABLES = readsFrom(REPAIR_TABLES, 'services/repair*.ts');
const WRITES_TO_RETIREMENT_TABLES = writesTo(RETIREMENT_TABLES, 'retirement.service.ts');
const READS_RETIREMENT_TABLES = readsFrom(RETIREMENT_TABLES, 'services/retirement*.ts');
// Every block on apps/api/src keeps the Retirement guards except the Retirement modules' own.
const RETIREMENT_GUARDS = [WRITES_TO_RETIREMENT_TABLES, READS_RETIREMENT_TABLES];
// #176 retro: the Unit list belongs to unit.service.ts, which other modules read through unit*.ts
// (unit-entries.ts for a join), and the Stock Material tables to services/stock-material*.ts.
const UNIT_TABLES = 'units|unit_history';
const STOCK_MATERIAL_TABLES = 'stock_material\\w*';
const WRITES_TO_UNIT_TABLES = writesTo(UNIT_TABLES, 'unit.service.ts');
const READS_UNIT_TABLES = readsFrom(UNIT_TABLES, 'services/unit*.ts');
const WRITES_TO_STOCK_MATERIAL_TABLES = writesTo(STOCK_MATERIAL_TABLES, 'stock-material.service.ts');
const READS_STOCK_MATERIAL_TABLES = readsFrom(STOCK_MATERIAL_TABLES, 'services/stock-material*.ts');
const STOCK_MATERIAL_GUARDS = [WRITES_TO_STOCK_MATERIAL_TABLES, READS_STOCK_MATERIAL_TABLES];
// #179: the Brand and Material Category lists belong to catalog-list.service.ts, which other modules read through
// catalog-list*.ts (catalog-list-entries.ts for a join).
const CATALOG_LIST_TABLES = 'brands|brand_history|material_categories|material_category_history';
const WRITES_TO_CATALOG_LIST_TABLES = writesTo(CATALOG_LIST_TABLES, 'catalog-list.service.ts');
const READS_CATALOG_LIST_TABLES = readsFrom(CATALOG_LIST_TABLES, 'services/catalog-list*.ts');
const CATALOG_LIST_GUARDS = [WRITES_TO_CATALOG_LIST_TABLES, READS_CATALOG_LIST_TABLES];
// Every block on apps/api/src keeps the Material Catalog guards except the owning modules' own.
const MATERIAL_GUARDS = [WRITES_TO_UNIT_TABLES, READS_UNIT_TABLES, ...STOCK_MATERIAL_GUARDS, ...CATALOG_LIST_GUARDS];
// #181 retro: names are compared by one expression, comparedName in compared-name.ts, which the unique indexes of the
// Unit, Brand and Material Category lists share (CODING_STANDARDS, a derived condition); a copy drifts unseen.
const OWN_COMPARED_NAME = sqlText(
  'regexp_replace\\s*\\(\\s*btrim',
  'Compare names with comparedName from compared-name.ts, the one source of the expression (#181).',
  'i'
);
const apiSyntaxRule = (...guards) => ({ 'no-restricted-syntax': ['error', NO_PROMISED_REPLY, OWN_COMPARED_NAME, ...guards] });
// What every module of apps/api/src keeps, but for the modules that own a table.
const API_GUARDS = [WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS];

// An awaited expect, by its matcher, and whether it goes through .not.
const matcher = (name) => `[expression.argument.callee.property.name='${name}']`;
const NEGATED = "[expression.argument.callee.object.property.name='not']";
const NOT_NEGATED = "[expression.argument.callee.object.property.name!='not']";
const ABSENCE = `ExpressionStatement:matches(${matcher('toHaveCount')}[expression.argument.arguments.0.value=0]${NOT_NEGATED}, ${matcher('toBeHidden')}${NOT_NEGATED}, ${matcher('toBeVisible')}${NEGATED}, ${matcher('toBeAttached')}${NEGATED})`;

// #155 retro: a loop of refused payloads that asserts only a 400 or VALIDATION_FAILED stays green when
// another rule refuses one of them. Each payload names the rule that refuses it, in the message or details.
// A loop over a named array goes unseen.
const REFUSAL_LOOP_NAMES_NO_RULE = {
  selector:
    "ForOfStatement[right.type='ArrayExpression']:has(:matches(Literal[value=400], Literal[value='VALIDATION_FAILED'])):not(:has(Identifier[name=/^(message|details)$/]))",
  message: 'Assert which rule refused each payload, by its message or details: a code alone stays green when another rule refuses it (CODING_STANDARDS.md, #155).',
};

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
    rules: apiSyntaxRule(...API_GUARDS),
  },
  {
    // The one source of the name comparison.
    files: ['apps/api/src/services/compared-name.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_PROMISED_REPLY, ...API_GUARDS] },
  },
  {
    files: ['apps/api/src/services/loan*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/loan.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/assignment.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/repair*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/repair.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, READS_LOAN_TABLES, ...RETIREMENT_GUARDS, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/retirement*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, WRITES_TO_RETIREMENT_TABLES, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/retirement.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...MATERIAL_GUARDS),
  },
  {
    files: ['apps/api/src/services/unit*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, WRITES_TO_UNIT_TABLES, ...STOCK_MATERIAL_GUARDS, ...CATALOG_LIST_GUARDS),
  },
  {
    files: ['apps/api/src/services/unit.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, ...STOCK_MATERIAL_GUARDS, ...CATALOG_LIST_GUARDS),
  },
  {
    files: ['apps/api/src/services/stock-material*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, WRITES_TO_UNIT_TABLES, READS_UNIT_TABLES, WRITES_TO_STOCK_MATERIAL_TABLES, ...CATALOG_LIST_GUARDS),
  },
  {
    files: ['apps/api/src/services/stock-material.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, WRITES_TO_UNIT_TABLES, READS_UNIT_TABLES, ...CATALOG_LIST_GUARDS),
  },
  {
    files: ['apps/api/src/services/catalog-list*.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, WRITES_TO_UNIT_TABLES, READS_UNIT_TABLES, ...STOCK_MATERIAL_GUARDS, WRITES_TO_CATALOG_LIST_TABLES),
  },
  {
    files: ['apps/api/src/services/catalog-list.service.ts'],
    rules: apiSyntaxRule(WRITES_TO_LOAN_TABLES, WRITES_TO_ASSIGNMENT_CHANGES, WRITES_TO_REPAIR_TABLES, READS_LOAN_TABLES, READS_REPAIR_TABLES, ...RETIREMENT_GUARDS, WRITES_TO_UNIT_TABLES, READS_UNIT_TABLES, ...STOCK_MATERIAL_GUARDS),
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
    // #102 retro: a container stop under host load outlasted a 30 s afterAll while every test passed.
    files: ['apps/api/tests/integration/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='afterAll'][arguments.length>1]",
          message: 'Leave the afterAll timeout to hookTimeout in apps/api/vitest.config.ts: stopping a container can outlast a shorter one (#102).',
        },
        REFUSAL_LOOP_NAMES_NO_RULE,
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
