import pg from 'pg';
import { normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { selectableCatalogListEntry } from './catalog-list.service.ts';
import { comparedName } from './compared-name.ts';
import { commitOnce } from './retryable-write.ts';
import { ValidationError } from './validation-error.ts';

// #202 P7: the longest name and description of a Requestable Material.
export const REQUESTABLE_MATERIAL_NAME_MAX_LENGTH = 200;
export const REQUESTABLE_MATERIAL_DESCRIPTION_MAX_LENGTH = 2000;

export interface CreateRequestableMaterialInput {
  name: string;
  // The Request Unit (หน่วยที่ขอ): an active Unit of the shared list (MRQ-28, Q15).
  request_unit_id: string;
  // Whole-number-only unless told otherwise (Q5).
  whole_number_only?: boolean;
  description?: string | null;
}

// What a Requestable Material write answers: the Requestable Material it wrote and the version a later write must expect.
export interface RequestableMaterialVersion {
  requestable_material_id: string;
  version: number;
}

// A Requestable Material as the refusal of a name already used names it.
export interface RequestableMaterialEntry {
  id: string;
  name: string;
  is_active: boolean;
  version: number;
}

/** A name another Requestable Material holds, Inactive ones included; the answer names it so it can be reactivated (Q6). */
export class RequestableMaterialNameTakenError extends Error {
  statusCode = 409;
  code = 'DUPLICATE_NAME';
  entry: RequestableMaterialEntry;

  constructor(entry: RequestableMaterialEntry) {
    super('A Requestable Material with this name already exists');
    this.name = 'RequestableMaterialNameTakenError';
    this.entry = entry;
  }
}

// The refusal of the unique index on the compared name (0029_requestable_materials).
const isNameTaken = (err: any) => err?.code === '23505' && err?.constraint === 'requestable_materials_name_unique';

// A request's facts once validated, before any lock. The retry fingerprint covers these.
const normalizeFacts = (input: CreateRequestableMaterialInput) => {
  // The name is one line (CODING_STANDARDS, "A text field's kind decides its control characters").
  const name = normalizeLine(input.name, 'name', REQUESTABLE_MATERIAL_NAME_MAX_LENGTH);
  if (name === null) {
    throw new ValidationError('name must not be blank');
  }
  if (!isValidUuid(input.request_unit_id)) {
    throw new ValidationError('request_unit_id must be a valid UUID');
  }
  return {
    name,
    request_unit_id: input.request_unit_id.trim().toLowerCase(),
    whole_number_only: input.whole_number_only ?? true,
    // Free text, keeping tab and line breaks inside it.
    description: normalizeText(input.description, 'description', REQUESTABLE_MATERIAL_DESCRIPTION_MAX_LENGTH, ''),
  };
};

/**
 * F009-T1 (#203): the writes of the Requestable Materials (วัสดุสำหรับขอเบิก) that a Supply Officer keeps for Requesters
 * to ask for in the words of their work (#202 MRQ-01, Q5). Each is its own record under a Stable ID, and every change
 * appends to its history (Q17). The reads are in requestable-material-read.service.ts.
 */
export class RequestableMaterialService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  async create(actorId: string, input: CreateRequestableMaterialInput, { retryToken }: { retryToken: string }): Promise<RequestableMaterialVersion> {
    const facts = normalizeFacts(input);
    try {
      return await commitOnce(this.db, { actorId, operation: 'requestable-material:create', retryToken, payload: facts, explicitContinuation: false }, async (client) => {
        // Locks the Unit FOR SHARE, so making it Inactive or renaming it waits for this write or is seen by it, and
        // reads its name now for the history (#175 P6).
        const requestUnit = await selectableCatalogListEntry(client, 'unit', facts.request_unit_id);
        if (requestUnit === null) {
          throw new ValidationError('request_unit_id must name an active Unit of the list');
        }

        const res = await client.query(
          `INSERT INTO requestable_materials (name, request_unit_id, whole_number_only, description, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, version`,
          [facts.name, facts.request_unit_id, facts.whole_number_only, facts.description, actorId]
        );
        const { id, version } = res.rows[0];

        // The values created, the description only when it has one, the Request Unit under its name now.
        const recorded = { name: facts.name, request_unit: requestUnit, whole_number_only: facts.whole_number_only, description: facts.description };
        const changes = Object.entries(recorded)
          .filter(([, value]) => value !== null)
          .map(([field, after]) => ({ field, before: null, after }));
        await client.query(
          `INSERT INTO requestable_material_history (requestable_material_id, version, kind, changes, recorded_by) VALUES ($1, $2, 'CREATED', $3::jsonb, $4)`,
          [id, version, JSON.stringify(changes), actorId]
        );
        return { requestable_material_id: id, version };
      });
    } catch (err) {
      throw await this.nameTakenOr(err, facts.name);
    }
  }

  // The answer to a write the unique index refused, naming the Requestable Material that holds the name (Q6), or `err`.
  private async nameTakenOr(err: unknown, name: string): Promise<unknown> {
    if (!isNameTaken(err)) {
      return err;
    }
    // The unique index answered after the Requestable Material holding the name committed, so it can be read now.
    const taken = await this.db.query(`SELECT id, name, is_active, version FROM requestable_materials WHERE ${comparedName('name')} = ${comparedName('$1')}`, [name]);
    return new RequestableMaterialNameTakenError(taken.rows[0]);
  }
}
