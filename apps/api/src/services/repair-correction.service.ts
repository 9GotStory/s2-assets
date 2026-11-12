import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, normalizeLine, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import { normalizeConfirmedConflicts, withConfirmedConflicts, type ConfirmedConflictInput } from './conflict-confirmation.ts';
import { repairConflictCheck } from './repair-conflict.ts';
import { type RepairKind, type RepairOutcomeValue, type RepairerKind, type UnderWarranty } from './repair-read.service.ts';
import {
  OUTCOME_NOTE_MAX_LENGTH,
  REPAIRER_NAME_MAX_LENGTH,
  SYMPTOM_OR_WORK_MAX_LENGTH,
  amendRepairFact,
  assertRepairSource,
  brokenRepairDateRules,
  incrementRepairVersion,
  lockRepairRecordForWrite,
  normalizeCost,
  readStoredRepairFact,
  recordRepairCorrection,
  underRepairRefusalOf,
  voidRepairFact,
  type BrokenRepairDateRule,
  type CorrectedField,
  type RepairCorrectionTarget,
  type RepairStartRefusal,
  type StoredRepairFact,
} from './repair.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

const REASON_MAX_LENGTH = REMARK_MAX_LENGTH;

// What an amendment may name. Each target kind takes its own fields (AMENDABLE_FIELDS); a record's Asset
// is none of them (#98 Q18).
export interface RepairAmendmentInput {
  repair_kind?: RepairKind;
  start_date?: string;
  repairer?: { kind: RepairerKind; name?: string | null };
  symptom_or_work?: string;
  under_warranty?: UnderWarranty;
  warranty_end_date?: string | null;
  cost?: string | null;
  document_reference?: string | null;
  remark?: string | null;
  repair_source?: { loan_return_id: string } | null;
  outcome?: RepairOutcomeValue;
  outcome_date?: string;
  note?: string | null;
  next_recommended_maintenance_date?: string | null;
}

export interface CorrectRepairInput {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  target: RepairCorrectionTarget;
  reason: string;
  changes?: RepairAmendmentInput;
  // The Repair Conflicts the user saw in a warning and confirms (F005-T7, #98 Q17).
  confirmed_conflicts?: ConfirmedConflictInput[];
}

// What a Repair Correction answers.
export interface RecordedRepairCorrection {
  repair_record_id: string;
  version: number;
  correction_id: string;
}

/**
 * Voiding a Repair Outcome would put an Asset Under Repair while a Loan holds it or another Repair Record
 * keeps it (#98 Q3, Q15, Q18). Nothing is saved, and the answer names what must be dealt with first.
 */
export class RepairOutcomeVoidRefusedError extends Error {
  statusCode = 409;
  code = 'REPAIR_OUTCOME_VOID_REFUSED';
  asset: RepairStartRefusal;

  constructor(asset: RepairStartRefusal) {
    super(`${asset.name ?? asset.asset_number ?? asset.asset_id} cannot be Under Repair again now: ${asset.reason}`);
    this.name = 'RepairOutcomeVoidRefusedError';
    this.asset = asset;
  }
}

const AMENDABLE_FIELDS: Record<RepairCorrectionTarget['kind'], (keyof RepairAmendmentInput)[]> = {
  REPAIR_RECORD: [
    'repair_kind',
    'start_date',
    'repairer',
    'symptom_or_work',
    'under_warranty',
    'warranty_end_date',
    'cost',
    'document_reference',
    'remark',
    'repair_source',
  ],
  REPAIR_OUTCOME: ['outcome', 'outcome_date', 'note', 'document_reference', 'next_recommended_maintenance_date'],
};

// The fields a correction record keeps of each target kind, in the order it lists them.
const CORRECTED_FIELDS: Record<RepairCorrectionTarget['kind'], string[]> = {
  REPAIR_RECORD: [
    'repair_kind',
    'start_date',
    'repairer_kind',
    'repairer_name',
    'symptom_or_work',
    'under_warranty',
    'warranty_end_date',
    'cost',
    'document_reference',
    'remark',
    'repair_source_loan_return_id',
  ],
  REPAIR_OUTCOME: ['outcome', 'outcome_date', 'note', 'document_reference', 'next_recommended_maintenance_date'],
};

const DATE_RULE_MESSAGES: Record<BrokenRepairDateRule, string> = {
  START_DATE_AFTER_TODAY: 'start_date must not be after today (Asia/Bangkok)',
  OUTCOME_DATE_AFTER_TODAY: 'outcome_date must not be after today (Asia/Bangkok)',
  OUTCOME_DATE_BEFORE_START_DATE: 'outcome_date must not be before the Start Date',
};

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface CorrectionFacts {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  target: RepairCorrectionTarget;
  reason: string;
  // The amended values by the names the correction record keeps; null for a void.
  values: Record<string, string | null> | null;
}

const normalizeTarget = (target: RepairCorrectionTarget): RepairCorrectionTarget => {
  if (target.kind === 'REPAIR_RECORD') {
    return { kind: 'REPAIR_RECORD' };
  }
  if (!isValidUuid(target.id)) {
    throw new ValidationError('target.id must be a valid UUID');
  }
  return { kind: 'REPAIR_OUTCOME', id: target.id.trim().toLowerCase() };
};

const normalizeDate = (value: string, field: string): string => {
  if (!isCalendarDate(value)) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
};

const normalizeOptionalDate = (value: string | null, field: string): string | null => (value === null ? null : normalizeDate(value, field));

// A cost as the database reads it back, with two decimals, so that "10" and "10.00" are one value.
const twoDecimals = (cost: string | null): string | null => {
  if (cost === null) {
    return null;
  }
  const [baht, satang = ''] = cost.split('.');
  return `${baht}.${satang.padEnd(2, '0')}`;
};

// The amended values of a target kind, by the names the correction record keeps, in their order (CORRECTED_FIELDS).
const normalizeValues = (kind: RepairCorrectionTarget['kind'], changes: RepairAmendmentInput): Record<string, string | null> => {
  const named = Object.keys(changes) as (keyof RepairAmendmentInput)[];
  const foreign = named.filter((field) => !AMENDABLE_FIELDS[kind].includes(field));
  if (foreign.length > 0) {
    throw new ValidationError(`changes.${foreign[0]} cannot be amended on a ${kind}`);
  }
  const values: Record<string, string | null> = {};
  const { repair_kind, start_date, repairer, symptom_or_work, under_warranty, warranty_end_date, cost, document_reference, remark, repair_source } = changes;
  const { outcome, outcome_date, note, next_recommended_maintenance_date } = changes;
  if (repair_kind !== undefined) {
    values.repair_kind = repair_kind;
  }
  if (start_date !== undefined) {
    values.start_date = normalizeDate(start_date, 'start_date');
  }
  if (repairer !== undefined) {
    values.repairer_kind = repairer.kind;
    values.repairer_name = normalizeLine(repairer.name, 'repairer.name', REPAIRER_NAME_MAX_LENGTH);
  }
  if (symptom_or_work !== undefined) {
    values.symptom_or_work = normalizeText(symptom_or_work, 'symptom_or_work', SYMPTOM_OR_WORK_MAX_LENGTH, '');
    if (values.symptom_or_work === null) {
      throw new ValidationError('symptom_or_work is required');
    }
  }
  if (under_warranty !== undefined) {
    values.under_warranty = under_warranty;
  }
  if (warranty_end_date !== undefined) {
    values.warranty_end_date = normalizeOptionalDate(warranty_end_date, 'warranty_end_date');
  }
  if (cost !== undefined) {
    values.cost = twoDecimals(normalizeCost(cost));
  }
  if (document_reference !== undefined) {
    values.document_reference = normalizeText(document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, '');
  }
  if (remark !== undefined) {
    values.remark = normalizeText(remark, 'remark', REMARK_MAX_LENGTH, '');
  }
  if (repair_source !== undefined) {
    const sourceId = repair_source?.loan_return_id ?? null;
    if (sourceId !== null && !isValidUuid(sourceId)) {
      throw new ValidationError('repair_source.loan_return_id must be a valid UUID');
    }
    values.repair_source_loan_return_id = sourceId?.trim().toLowerCase() ?? null;
  }
  if (outcome !== undefined) {
    values.outcome = outcome;
  }
  if (outcome_date !== undefined) {
    values.outcome_date = normalizeDate(outcome_date, 'outcome_date');
  }
  if (note !== undefined) {
    values.note = normalizeText(note, 'note', OUTCOME_NOTE_MAX_LENGTH, '');
  }
  if (next_recommended_maintenance_date !== undefined) {
    values.next_recommended_maintenance_date = normalizeOptionalDate(next_recommended_maintenance_date, 'next_recommended_maintenance_date');
  }
  return Object.fromEntries(CORRECTED_FIELDS[kind].filter((field) => field in values).map((field) => [field, values[field]]));
};

const normalizeFacts = (input: CorrectRepairInput): CorrectionFacts => {
  const reason = normalizeText(input.reason, 'reason', REASON_MAX_LENGTH, '');
  if (reason === null) {
    throw new ValidationError('A correction needs a reason');
  }
  const target = normalizeTarget(input.target);
  if (input.action === 'VOID') {
    if (input.changes !== undefined) {
      throw new ValidationError('A void changes no field: leave changes out');
    }
    return { expected_version: input.expected_version, action: 'VOID', target, reason, values: null };
  }
  return { expected_version: input.expected_version, action: 'AMEND', target, reason, values: normalizeValues(target.kind, input.changes ?? {}) };
};

// #98 Q7: an amended Repair Outcome keeps its Next Recommended Maintenance Date after its Outcome Date.
const assertNextDateAfterOutcomeDate = (fact: StoredRepairFact, values: Record<string, string | null>): void => {
  const { outcome_date: outcomeDate, next_recommended_maintenance_date: nextDate } = { ...fact.fields, ...values };
  if (nextDate && outcomeDate && nextDate <= outcomeDate) {
    throw new ValidationError('next_recommended_maintenance_date must be after outcome_date');
  }
};

// The fields an amendment changes, as the correction record keeps them.
const changedFields = (fact: StoredRepairFact, values: Record<string, string | null>): CorrectedField[] => {
  const changed = Object.entries(values).filter(([field, after]) => fact.fields[field] !== after);
  if (changed.length === 0) {
    throw new ValidationError('This amendment changes nothing');
  }
  return changed.map(([field, after]) => ({ field, before: fact.fields[field], after }));
};

/**
 * F005-T6 (#104): fixes a Repair fact that was recorded wrong, with a reason. An amendment leaves the
 * corrected values on the fact; a void keeps the fact, struck through, and out of every count (#98 Q18).
 * Each correction keeps its reason and the before and after of every field it changed.
 */
export class RepairCorrectionService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  async correct(actorId: string, repairRecordId: string, input: CorrectRepairInput, { retryToken }: { retryToken: string }): Promise<RecordedRepairCorrection> {
    const facts = normalizeFacts(input);
    const confirmed = normalizeConfirmedConflicts(input.confirmed_conflicts);
    const today = bangkokDate(this.clock());
    return commitOnce(
      this.db,
      {
        actorId,
        operation: `repair:correct:${repairRecordId}`,
        retryToken,
        payload: withConfirmedConflicts({ version: 1, ...facts }, confirmed),
        explicitContinuation: false,
      },
      async (client) => {
        const record = await lockRepairRecordForWrite(client, repairRecordId, facts.expected_version);
        const conflicts = await repairConflictCheck(client, record.asset_id);
        const { target } = facts;
        const fact = await readStoredRepairFact(client, repairRecordId, target);
        if (!fact) {
          throw new NotFoundError('This Repair Record has no such fact');
        }
        if (fact.is_voided) {
          throw new ValidationError('This fact is voided: it can no longer be corrected');
        }

        let changes: CorrectedField[] = [];
        if (facts.values) {
          changes = changedFields(fact, facts.values);
          assertNextDateAfterOutcomeDate(fact, facts.values);
          const sourceId = changes.find(({ field }) => field === 'repair_source_loan_return_id')?.after;
          if (sourceId) {
            await assertRepairSource(client, record.asset_id, sourceId);
          }
          await amendRepairFact(client, target, fact.id, Object.fromEntries(changes.map(({ field, after }) => [field, after])));
        } else {
          // Voiding a Repair Outcome makes the Asset Under Repair again, so no Loan may hold it and no other
          // Repair Record may keep it (#98 Q18). The Asset is locked, the lock a Loan start and a Repair Start take.
          if (target.kind === 'REPAIR_OUTCOME') {
            const refusal = await underRepairRefusalOf(client, { asset_id: record.asset_id, ...record.asset });
            if (refusal) {
              throw new RepairOutcomeVoidRefusedError(refusal);
            }
          }
          changes = await voidRepairFact(client, repairRecordId, target, fact);
        }

        const broken = await brokenRepairDateRules(client, repairRecordId, today);
        if (broken.length > 0) {
          throw new ValidationError(DATE_RULE_MESSAGES[broken[0]]);
        }
        // An amended date or a voided Repair Outcome may open an overlap with another Repair Record or a
        // LoanItem of the Asset (#98 Q17, Q18).
        await conflicts.assertConfirmed({ repairRecordId, isNewRecord: false, confirmed });

        const correctionId = await recordRepairCorrection(client, {
          target,
          factId: fact.id,
          action: facts.values ? 'AMENDED' : 'VOIDED',
          reason: facts.reason,
          changes,
          actorId,
        });
        return { repair_record_id: repairRecordId, version: await incrementRepairVersion(client, repairRecordId), correction_id: correctionId };
      }
    );
  }
}
