import type pg from 'pg';
import { offered } from './requestable-material-offered.ts';

// F009-T4 (#206): the read the Material Request module asks the Requestable Material module through when a Material
// Request is created (#202 Q9, Q20; CODING_STANDARDS, "A feature's code gets its own files"). A leaf of the
// Requestable Material module: it imports only its own offered condition and pg's types.

// What creating a Material Request needs of one Requestable Material it asks for, as it is once locked.
export interface RequestableMaterialAskedFor {
  // Active with a current Compatible Stock Material (Q9), from the one SQL source.
  is_offered: boolean;
  whole_number_only: boolean;
  // The Request Unit the Requested Item records (P3).
  request_unit_id: string;
}

/**
 * The Requestable Materials `ids`, each locked `FOR SHARE` so that ending a Compatible Stock Material, making it
 * Inactive and changing its whole-number setting or Request Unit wait for the Material Request or are seen by it: each
 * of those writes locks the Requestable Material `FOR UPDATE` (#206 start decision 2). Its facts are read in a
 * statement after the lock, whose snapshot sees each such write that committed while the lock waited; the lock's own
 * statement would read the Compatible Stock Materials of the snapshot it started with (PostgreSQL 18, §13.2.1). An id
 * that names no Requestable Material is missing from the answer.
 */
export async function requestableMaterialsAskedFor(client: pg.PoolClient, ids: string[]): Promise<Map<string, RequestableMaterialAskedFor>> {
  // In id order, so that two Material Requests asking for the same ones never wait on each other in a cycle.
  await client.query('SELECT id FROM requestable_materials WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
  const res = await client.query(
    `SELECT r.id, ${offered('r')} AS is_offered, r.whole_number_only, r.request_unit_id FROM requestable_materials r WHERE r.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(res.rows.map(({ id, ...facts }: any) => [id, facts as RequestableMaterialAskedFor]));
}
