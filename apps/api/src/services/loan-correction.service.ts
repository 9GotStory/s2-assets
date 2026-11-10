import pg from 'pg';
import { DOCUMENT_REFERENCE_MAX_LENGTH, REMARK_MAX_LENGTH, bangkokDate, isCalendarDate, normalizeText } from './assignment.service.ts';
import { isValidUuid } from './capability.service.ts';
import {
  CONDITION_NOTE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  amendLoanFact,
  brokenLoanDateRules,
  countedItemsOf,
  incrementLoanVersion,
  lockLoanForWrite,
  normalizeAuthorizer,
  normalizeBorrower,
  otherLoanHoldingAssetOf,
  readStoredLoanFact,
  recordLoanCorrection,
  voidLoanFact,
  type BorrowerInput,
  type BrokenLoanDateRule,
  type LoanCorrectionTarget,
  type StoredLoanFact,
} from './loan.service.ts';
import { loanConflictCheck, normalizeConfirmedConflicts, type ConfirmedLoanConflictInput } from './loan-conflict.ts';
import type { LoanCondition } from './loan-read.service.ts';
import { isSelectablePerson } from './reference.service.ts';
import { commitOnce } from './retryable-write.ts';
import { NotFoundError } from './service-errors.ts';
import { ValidationError } from './validation-error.ts';

// What an amendment may name. Each target kind takes its own fields (AMENDABLE_FIELDS).
export interface LoanAmendmentInput {
  borrower?: BorrowerInput;
  loan_date?: string;
  authorizer_person_id?: string | null;
  document_reference?: string | null;
  remark?: string | null;
  due_date?: string;
  condition?: LoanCondition;
  condition_note?: string | null;
  return_date?: string;
  not_returned_date?: string;
  reason?: string;
}

export interface CorrectLoanInput {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  target: LoanCorrectionTarget;
  reason: string;
  changes?: LoanAmendmentInput;
  // The Loan Conflicts the user saw in a warning and confirms (#74 Q25).
  confirmed_conflicts?: ConfirmedLoanConflictInput[];
}

// What a Loan Correction answers. It carries no Borrower detail, as for starting a Loan (LR-15, #74 Q24).
export interface RecordedLoanCorrection {
  loan_id: string;
  version: number;
  correction_id: string;
}

// The Asset of an ending whose void would put it on two Loans at once, and the other Loan (LR-11).
export interface HeldAsset {
  asset_id: string;
  name: string | null;
  asset_number: string | null;
  loan_id: string;
  reason: 'ON_LOAN' | 'NOT_RETURNED';
}

/** Voiding an ending would restore an item whose Asset another Loan now holds. Nothing is saved (#74 Q25, LR-11). */
export class AssetOnAnotherLoanError extends Error {
  statusCode = 409;
  code = 'ASSET_ON_ANOTHER_LOAN';
  asset: HeldAsset;

  constructor(asset: HeldAsset) {
    super(`${asset.name ?? asset.asset_number ?? asset.asset_id} is now held by another Loan: deal with that Loan first`);
    this.name = 'AssetOnAnotherLoanError';
    this.asset = asset;
  }
}

// The fields an amendment of each target kind may name (#74 Q25). A Due Date Extension is voided and
// recorded again, never amended, and a LoanItem's Asset never changes.
const AMENDABLE_FIELDS: Record<LoanCorrectionTarget['kind'], (keyof LoanAmendmentInput)[]> = {
  LOAN: ['borrower', 'loan_date', 'authorizer_person_id', 'document_reference', 'remark'],
  LOAN_ITEM: ['due_date', 'condition', 'condition_note'],
  LOAN_RETURN: ['return_date', 'condition', 'condition_note'],
  NOT_RETURNED: ['not_returned_date', 'reason'],
  DUE_DATE_EXTENSION: [],
};

const DATE_RULE_MESSAGES: Record<BrokenLoanDateRule, string> = {
  LOAN_DATE_AFTER_TODAY: 'loan_date must not be after today (Asia/Bangkok)',
  DUE_DATE_BEFORE_LOAN_DATE: 'A Due Date must not be before the Loan Date',
  RETURN_DATE_BEFORE_LOAN_DATE: 'A Return Date must not be before the Loan Date',
  NOT_RETURNED_DATE_BEFORE_LOAN_DATE: 'A Not Returned date must not be before the Loan Date',
  ENDING_DATE_AFTER_TODAY: 'A Return Date or Not Returned date must not be after today (Asia/Bangkok)',
  RETURN_DATE_BEFORE_NOT_RETURNED_DATE: "A Loan Return must not be dated before its item's Not Returned date",
  EXTENSION_NOT_AFTER_FIRST_DUE_DATE: "The first Due Date must be before each of the item's Due Date Extensions: void the extension first",
};

// The phone number's change is kept without either value (#74 Q24).
const PHONE_FIELD = 'borrower_phone';

// One changed field of a correction record. The phone number's has neither value.
type CorrectedField = { field: string; before: string | null; after: string | null } | { field: typeof PHONE_FIELD };

// A request's facts once validated, before any lock. The retry fingerprint covers these.
interface CorrectionFacts {
  expected_version: number;
  action: 'AMEND' | 'VOID';
  target: LoanCorrectionTarget;
  reason: string;
  // The amended values by the names the correction record keeps; null for a void.
  values: Record<string, string | null> | null;
}

const normalizeTarget = (target: LoanCorrectionTarget): LoanCorrectionTarget => {
  if (target.kind === 'LOAN') {
    return { kind: 'LOAN' };
  }
  if (!isValidUuid(target.id)) {
    throw new ValidationError('target.id must be a valid UUID');
  }
  return { kind: target.kind, id: target.id.trim().toLowerCase() };
};

const normalizeDate = (value: string, field: string): string => {
  if (!isCalendarDate(value)) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
};

// The amended values of a target kind, by the names the correction record keeps, in the order of its fields.
const normalizeValues = (kind: LoanCorrectionTarget['kind'], changes: LoanAmendmentInput): Record<string, string | null> => {
  if (kind === 'DUE_DATE_EXTENSION') {
    throw new ValidationError('A Due Date Extension is not amended: void it and record it again');
  }
  const named = Object.keys(changes) as (keyof LoanAmendmentInput)[];
  const foreign = named.filter((field) => !AMENDABLE_FIELDS[kind].includes(field));
  if (foreign.length > 0) {
    throw new ValidationError(`changes.${foreign[0]} cannot be amended on a ${kind}`);
  }
  const values: Record<string, string | null> = {};
  const { borrower, loan_date, authorizer_person_id, document_reference, remark, due_date, condition, condition_note, return_date, not_returned_date, reason } =
    changes;
  if (borrower !== undefined) {
    const normalized = normalizeBorrower(borrower);
    values.borrower_kind = normalized.kind;
    values.borrower_person_id = normalized.kind === 'INTERNAL' ? normalized.person_id : null;
    values.borrower_contact_name = normalized.kind === 'EXTERNAL' ? normalized.contact_name : null;
    values.borrower_organization_name = normalized.kind === 'EXTERNAL' ? normalized.organization_name : null;
    values[PHONE_FIELD] = normalized.kind === 'EXTERNAL' ? normalized.phone : null;
  }
  if (loan_date !== undefined) {
    values.loan_date = normalizeDate(loan_date, 'loan_date');
  }
  if (authorizer_person_id !== undefined) {
    values.authorizer_person_id = normalizeAuthorizer(authorizer_person_id);
  }
  if (document_reference !== undefined) {
    values.document_reference = normalizeText(document_reference, 'document_reference', DOCUMENT_REFERENCE_MAX_LENGTH, '');
  }
  if (remark !== undefined) {
    values.remark = normalizeText(remark, 'remark', REMARK_MAX_LENGTH, '');
  }
  if (due_date !== undefined) {
    values.due_date = normalizeDate(due_date, 'due_date');
  }
  if (return_date !== undefined) {
    values.return_date = normalizeDate(return_date, 'return_date');
  }
  if (not_returned_date !== undefined) {
    values.not_returned_date = normalizeDate(not_returned_date, 'not_returned_date');
  }
  if (condition !== undefined) {
    values.condition = condition;
  }
  if (condition_note !== undefined) {
    values.condition_note = normalizeText(condition_note, 'condition_note', CONDITION_NOTE_MAX_LENGTH, '');
  }
  if (reason !== undefined) {
    values.reason = normalizeText(reason, 'changes.reason', REASON_MAX_LENGTH, '');
    if (values.reason === null) {
      throw new ValidationError('A Not Returned needs a reason');
    }
  }
  return values;
};

const normalizeFacts = (input: CorrectLoanInput): CorrectionFacts => {
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

// The fields an amendment changes, as the correction record keeps them.
const changedFields = (fact: StoredLoanFact, values: Record<string, string | null>): CorrectedField[] => {
  const changed = Object.entries(values).filter(([field, after]) => fact.fields[field] !== after);
  if (changed.length === 0) {
    throw new ValidationError('This amendment changes nothing');
  }
  return changed.map(([field, after]) => (field === PHONE_FIELD ? { field } : { field, before: fact.fields[field], after }));
};

/**
 * F004-T6 (#80): fixes a Loan fact that was recorded wrong, with a reason. An amendment leaves the
 * corrected values on the fact; a void keeps the fact, struck through, and out of every count (#74 Q25).
 * Each correction keeps its reason and the before and after of every field it changed.
 */
export class LoanCorrectionService {
  private readonly db: pg.Pool | any;
  private readonly clock: () => Date;

  constructor(options: { db: pg.Pool | any; clock?: () => Date }) {
    this.db = options.db;
    this.clock = options.clock ?? (() => new Date());
  }

  // Corrections may name deactivated Person entries (#74), but only entries of the list.
  private async assertNamedPersons(client: pg.PoolClient, values: Record<string, string | null>): Promise<void> {
    for (const field of ['borrower_person_id', 'authorizer_person_id']) {
      const id = values[field];
      if (id && !(await isSelectablePerson(client, id, { allowInactive: true }))) {
        throw new ValidationError(`${field === 'borrower_person_id' ? 'borrower.person_id' : field} must name an entry of the Person Reference List`);
      }
    }
  }

  // Voiding a Loan Return puts its item back in LR-11's count, Outstanding or Not Returned, so another
  // Loan must not hold its Asset now. The Assets are locked.
  private async assertAssetFree(client: pg.PoolClient, itemId: string, items: { id: string; asset_id: string; name: string | null; asset_number: string | null }[]) {
    const holding = await otherLoanHoldingAssetOf(client, itemId);
    if (holding) {
      const { asset_id, name, asset_number } = items.find(({ id }) => id === itemId)!;
      throw new AssetOnAnotherLoanError({
        asset_id,
        name,
        asset_number,
        loan_id: holding.loan_id,
        reason: holding.ending_kind === 'NONE' ? 'ON_LOAN' : 'NOT_RETURNED',
      });
    }
  }

  async correct(actorId: string, loanId: string, input: CorrectLoanInput, { retryToken }: { retryToken: string }): Promise<RecordedLoanCorrection> {
    const facts = normalizeFacts(input);
    const confirmed = normalizeConfirmedConflicts(input.confirmed_conflicts);
    const today = bangkokDate(this.clock());
    // An unconfirmed request keeps the payload it had before confirmation existed (#74 Q25).
    const payload = confirmed.length > 0 ? { version: 1, ...facts, confirmed_conflicts: confirmed } : { version: 1, ...facts };
    return commitOnce(
      this.db,
      { actorId, operation: `loan:correct:${loanId}`, retryToken, payload, explicitContinuation: false },
      async (client) => {
        const { items } = await lockLoanForWrite(client, loanId, facts.expected_version);
        const conflicts = await loanConflictCheck(client, [...new Set(items.map(({ asset_id }) => asset_id))]);
        const { target } = facts;
        const fact = await readStoredLoanFact(client, loanId, target);
        if (!fact) {
          throw new NotFoundError('This Loan has no such fact');
        }
        if (fact.is_voided) {
          throw new ValidationError('This fact is voided: it can no longer be corrected');
        }

        let changes: CorrectedField[] = [];
        if (facts.values) {
          changes = changedFields(fact, facts.values);
          await this.assertNamedPersons(client, facts.values);
          await amendLoanFact(client, target, fact.id, Object.fromEntries(Object.entries(facts.values).filter(([field]) => changes.some((c) => c.field === field))));
        } else {
          if (target.kind === 'LOAN_ITEM' && (await countedItemsOf(client, loanId)) === 1) {
            throw new ValidationError('This is the Loan\'s last item: void the Loan instead');
          }
          if (target.kind === 'LOAN_RETURN') {
            await this.assertAssetFree(client, fact.loan_item_id!, items);
          }
          await voidLoanFact(client, loanId, target, fact);
        }

        const broken = await brokenLoanDateRules(client, loanId, today);
        if (broken.length > 0) {
          throw new ValidationError(DATE_RULE_MESSAGES[broken[0]]);
        }
        // A corrected date or a voided ending may open an overlap with another Loan of the same Asset (#74 Q25).
        await conflicts.assertConfirmed({ loanId, isNewLoan: false, confirmed });

        const correctionId = await recordLoanCorrection(client, {
          target,
          factId: fact.id,
          action: facts.values ? 'AMENDED' : 'VOIDED',
          reason: facts.reason,
          changes,
          actorId,
        });
        return { loan_id: loanId, version: await incrementLoanVersion(client, loanId), correction_id: correctionId };
      }
    );
  }
}
