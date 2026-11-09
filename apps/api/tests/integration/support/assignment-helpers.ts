import { expect } from 'vitest';
import type { Actor, ApiHarness } from './api-harness.ts';

export type Entry = { id: string; name: string; is_active: boolean };

// A dimension with no entry and no Legacy text, as the API answers it.
export const NO_VALUE = { entry: null, legacy_text: null };

// A dimension value as the API answers it, naming the active entry `e`.
export const at = (e: Entry) => ({ entry: { id: e.id, name: e.name, is_active: true }, legacy_text: null });

/**
 * Reference List entries and what an observer reads of an Asset's assignment, for new Seam A tests
 * of assignment writes. `context` is read on every call, so a test file can build these while its
 * `describe` runs, over the harness and actors it assigns in `beforeAll`.
 */
export function assignmentHelpers(context: () => { api: ApiHarness; admin: Actor; reader: Actor }) {
  const entry = async (kind: string, name: string): Promise<Entry> => {
    const { api, admin } = context();
    return (await api.post(admin, `/references/${kind}`, { name })).json();
  };

  // `count` entries of one list, named after `prefix`.
  const entries = (kind: string, prefix: string, count: number): Promise<Entry[]> =>
    Promise.all(Array.from({ length: count }, (_, i) => entry(kind, `${prefix} ${i + 1}`)));

  const detailOf = async (assetId: string) => {
    const { api, reader } = context();
    return (await api.get(reader, `/assets/${assetId}`)).json();
  };

  const timelineOf = async (assetId: string) => {
    const { api, reader } = context();
    const res = await api.get(reader, `/assets/${assetId}/assignments`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  // What an observer reads of an Asset's assignment, to show that a refused write changed nothing.
  const assignmentOf = async (assetId: string) => {
    const detail = await detailOf(assetId);
    return { current: detail.current_assignment, version: detail.assignment_version, timeline: await timelineOf(assetId) };
  };

  return { entry, entries, detailOf, timelineOf, assignmentOf };
}
