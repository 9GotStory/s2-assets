import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, lockAssetsInIdentifierOrder, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { hasStrictControlChars } from './control-characters.ts';
import { loansHoldingAssets } from './loan.service.ts';
import { underRepairOfAssets, type RepairKind, type RepairerKind, type UnderWarranty } from './repair-read.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

const REPAIRER_NAME_MAX_LENGTH = 200;
const SYMPTOM_OR_WORK_MAX_LENGTH = REMARK_MAX_LENGTH;

// Baht, not negative, with at most two decimals, within numeric(12, 2) (#98 Q8).
const COST_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

export interface StartRepairInput {
  asset_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer: { kind: RepairerKind; name?: string | null };
  symptom_or_work: string;
  under_warranty?: UnderWarranty;
  warranty_end_date?: string | null;
  cost?: string | null;
  document_reference?: string | null;
  remark?: string | null;
}

export interface StartedRepair {
  repair_record_id: string;
  version: number;
}

// Why an Asset cannot be sent, naming the Loan or the Repair Record that keeps it (#98 Q3, Q15).
export type RepairStartRefusal = { asset_id: string; name: string | null; asset_number: string | null } & (
  | { reason: 'ON_LOAN' | 'NOT_RETURNED'; loan_id: string }
  | { reason: 'UNDER_REPAIR'; repair_record_id: string; repair_kind: RepairKind }
);

/** A Repair Start names an Asset that cannot be sent now. Nothing is saved, and the answer says why. */
export class RepairStartRefusedError extends Error {
  statusCode = 409;
  code = 'REPAIR_START_REFUSED';
  asset: RepairStartRefusal;

  constructor(asset: RepairStartRefusal) {
    super(`${asset.name ?? asset.asset_number ?? asset.asset_id} cannot be sent for repair or maintenance now: ${asset.reason}`);
    this.name = 'RepairStartRefusedError';
    this.asset = asset;
  }
}

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface RepairStartFacts {
  asset_id: string;
  repair_kind: RepairKind;
  start_date: string;
  repairer_kind: RepairerKind;
  repairer_name: string | null;
  symptom_or_work: string;
  under_warranty: UnderWarranty;
  warranty_end_date: string | null;
  cost: string | null;
  document_reference: string | null;
  remark: string | null;
}

// A cost is one line, so a control character is refused before trimming, even at its ends.
const normalizeCost = (value: string | null | undefined): string | null => {
  if (hasStrictControlChars(value ?? '')) {
    throw new ValidationError('cost must not contain control characters');
  }
  const cost = value?.trim() ?? '';
  if (cost === '') {
    return null;
  }
  if (!COST_PATTERN.test(cost)) {
    throw new ValidationError('cost must be baht, not negative, with at most two decimals');
  }
  return cost;
};

const normalizeFacts = (input: StartRepairInput, today: string): RepairStartFacts => {
  if (!isValidUuid(input.asset_id)) {
    throw new ValidationError('asset_id must be a valid UUID');
  }
  // #98 Q4: no lower bound, not even the Asset's registration. Dates compare as text in YYYY-MM-DD.
  if (!isCalendarDate(input.start_date)) {
    throw new ValidationError('start_date must be a date (YYYY-MM-DD)');
  }
  if (input.start_date > today) {
    throw new ValidationError(`start_date must not be after today (${today}, Asia/Bangkok)`);
  }
  const warrantyEndDate = input.warranty_end_date ?? null;
  if (warrantyEndDate !== null && !isCalendarDate(warrantyEndDate)) {
    throw new ValidationError('warranty_end_date must be a date (YYYY-MM-DD)');
  }
  const symptomOrWork = normalizeText(input.symptom_or_work, 'symptom_or_work', SYMPTOM_OR_WORK_MAX_LENGTH, '');
  if (symptomOrWork === null) {
    throw new ValidationError('symptom_or_work is required');
  }
  return {
    asset_id: input.asset_id.trim().toLowerCase(),
    repair_kind: input.repair_kind,
    start_date: input.start_date,
    repairer_kind: input.repairer.kind,
    repairer_name: normalizeLine(input.repairer.name, 'repairer.name', REPAIRER_NAME_MAX_LENGTH),
    symptom_or_work: symptomOrWork,
    under_warranty: input.under_warranty ?? 'UNSPECIFIED',
    warranty_end_date: warrantyEndDate,
    cost: normalizeCost(input.cost),
    document_reference: normalizeText(input.document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, ''),
    remark: normalizeText(input.remark, 'remark', REMARK_MAX_LENGTH, ''),
  };
};

/**
 * F005-T1 (#99): sending one Asset for repair or maintenance. A Repair Record never touches an
 * assignment fact (RM-05). The reads are in repair-read.service.ts.
 */
export class RepairService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Locks the Asset, the lock a Loan start takes, and refuses it while a Loan holds it or it is Under
  // Repair (RM-07, DR-16, #98 Q3, Q15). A Repair Start and a Loan start of one Asset therefore serialize.
  private async assertRepairMayStart(client: pg.PoolClient, assetId: string): Promise<void> {
    const [asset] = await lockAssetsInIdentifierOrder(client, [assetId]);
    if (!asset) {
      throw new NotFoundError('Asset not found');
    }
    const { name, asset_number } = asset;
    const held = (await loansHoldingAssets(client, [assetId])).get(assetId);
    if (held) {
      throw new RepairStartRefusedError({ asset_id: assetId, name, asset_number, ...held });
    }
    const repair = (await underRepairOfAssets(client, [assetId])).get(assetId);
    if (repair) {
      throw new RepairStartRefusedError({ asset_id: assetId, name, asset_number, reason: 'UNDER_REPAIR', repair_record_id: repair.repair_record_id, repair_kind: repair.repair_kind });
    }
  }

  async start(actorId: string, input: StartRepairInput, { retryToken }: { retryToken: string }): Promise<StartedRepair> {
    const facts = normalizeFacts(input, bangkokDate(this.clock()));
    return commitOnce(
      this.db,
      { actorId, operation: 'repair:start', retryToken, payload: { version: 1, ...facts }, explicitContinuation: false },
      async (client) => {
        await this.assertRepairMayStart(client, facts.asset_id);
        const res = await client.query(
          `INSERT INTO repair_records (asset_id, repair_kind, start_date, repairer_kind, repairer_name, symptom_or_work, under_warranty,
                                       warranty_end_date, cost, document_reference, remark, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, version`,
          [
            facts.asset_id,
            facts.repair_kind,
            facts.start_date,
            facts.repairer_kind,
            facts.repairer_name,
            facts.symptom_or_work,
            facts.under_warranty,
            facts.warranty_end_date,
            facts.cost,
            facts.document_reference,
            facts.remark,
            actorId,
          ]
        );
        return { repair_record_id: res.rows[0].id, version: res.rows[0].version };
      }
    );
  }
}
