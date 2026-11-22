# Entity pattern: where each layer's prior art is

A new catalog-style entity (a named record with a Stable ID, a version, an append-only history,
`*:view` and `*:manage` capabilities, a paged list and a page) follows the layers below. F009-T1's
Requestable Material is the smallest complete example; F008's Stock Material and catalog lists add
the writes T1 has none of. Find each symbol with `grep -n '<symbol>' <file>` and read that range
with `sed -n`; the files run 10–20 KB each, so reading them whole costs a compaction.

## API

| Layer | File | Symbols |
|---|---|---|
| Migration | `packages/db/src/migrations/0029_requestable_materials.ts` | `HISTORY_KINDS`, `up` (compared-name unique index), `down` (refuses while rows or `<op>:%` receipts exist) |
| Migration list | `apps/api/tests/integration/db.test.ts` | `MIGRATIONS` |
| Route | `apps/api/src/routes/requestable-material.routes.ts` | `Create…Schema` (strict), `…ListQuerySchema` (search + `pageQueryFields`), `refusalOf`, `requireCapability`, `can_manage` |
| Write helpers | `apps/api/src/routes/write-request.ts`, `list-query.ts` | `parseWrite`, `errorBody`, `pageQueryFields`, `invalidQueryBody` |
| Write service | `apps/api/src/services/requestable-material.service.ts` | `normalizeFacts`, `create` inside `commitOnce` (`retryable-write.ts`), `isNameTaken`, `nameTakenOr`, `…NameTakenError` |
| A list entry read under a lock | `apps/api/src/services/catalog-list.service.ts` | `selectableCatalogListEntry` (FOR SHARE, active, name for history) |
| Read service | `apps/api/src/services/requestable-material-read.service.ts` | `list` (filtered / counted / paged CTE), `read` (row + history), `toRow`; joins from `catalog-list-entries.ts` (`joinUnitEntry`, `joinCatalogListEntry`) |
| Names | `apps/api/src/services/compared-name.ts` | `comparedName` (lint `OWN_COMPARED_NAME` requires it) |
| Wiring | `apps/api/src/app.ts` | `app.register(requestableMaterialRoutes` |
| Rename, Inactive, reactivate, stale version | `apps/api/src/services/catalog-list.service.ts`, `stock-material.service.ts` | `rename`, `inactivate`, `reactivate`, `expectedVersion` checks |

## API tests

| Seam | File | Symbols |
|---|---|---|
| A | `apps/api/tests/integration/requestable-material.test.ts` | `describe` blocks: creating, text, a name already used, history, concurrency, the list, the page, permissions, retry token |
| Lock order | `apps/api/tests/integration/support/lock-helpers.ts` | `whileWriting`, `untilWaiting(table, count, mode)` |
| Isolating capability tests | `apps/api/tests/integration/support/capability-helpers.ts` | `withCapabilityAnswer` |
| C | `apps/api/tests/integration/requestable-material-migration.test.ts` | up from the previous migration, constraints, down refusals, clean rollback |

## Web

| Layer | File | Symbols |
|---|---|---|
| Types and labels | `apps/web/src/components/requestableMaterialFacts.ts`; shared ones in `materialFacts.ts` | `*_LABEL`, `…HISTORY_KIND_LABELS`, `wholeNumberLine`, `HISTORY_KIND_LABELS` |
| Queries | `apps/web/src/components/materialQueries.ts` | `readList`, `useUnitList`, `useCsrfToken` |
| List page | `apps/web/src/pages/RequestableMaterialList.tsx` | URL `search` / `offset`, `PAGE_SIZE`, `can_manage` add action |
| Create page | `apps/web/src/pages/RequestableMaterialCreate.tsx` | `LoanSaveForm` (`components/LoanSaveForm.tsx`), `requestError`, name-taken link |
| Page | `apps/web/src/pages/RequestableMaterialDetail.tsx` | `recordedValue`, history rows |
| Routes and menu | `apps/web/src/router.tsx`, `pages/Dashboard.tsx`, `apps/web/vite.config.ts` (dev proxy entry with the html bypass) | the entity's paths |

## Web tests

| Seam | File | Symbols |
|---|---|---|
| B | `apps/web/tests/e2e/material-request.spec.ts` | `loginAs`, `delaySessionCheck`; `switchActor` in `material.spec.ts` |
| Route smoke | `apps/web/tests/e2e/route-smoke.spec.ts` | the route rows and their fixture |
