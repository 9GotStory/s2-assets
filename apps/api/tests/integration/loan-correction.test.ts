import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';
import { lockHelpers } from './support/lock-helpers.ts';

const TODAY = '2026-11-05';
const LOAN_DATE = '2026-11-01';
const DUE = '2026-11-10';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = '081-234-5678';

// F004-T6 (#80): fixing a Loan fact recorded wrong, with a reason, and deleting nothing (#74 Q18, Q25).
describe('Loan Correction (Seam A - F004-T6)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  const now = new Date('2026-11-05T05:00:00Z');
  const logLines: string[] = [];

  const { entry } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { whileHolding } = lockHelpers(() => ({ api }));
  const { registered, loanOf, start, lent, returned, closedNotReturned } = loanHelpers(
    () => ({ api, custodian, reader: readonly }),
    { loanDate: LOAN_DATE, dueDate: DUE, contactName: 'คุณผู้ยืมแก้ไข' }
  );

  const correct = (loanId: string, payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, `/loans/${loanId}/corrections`, payload, { 'x-retry-token': token });

  // An amendment of `target`, against the Loan's latest version unless `overrides` says otherwise.
  const amendment = async (loanId: string, target: Record<string, unknown>, changes: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    action: 'AMEND',
    target,
    reason: 'บันทึกผิดจากใบยืม',
    changes,
    ...overrides,
  });

  // A void of `target`, against the Loan's latest version unless `overrides` says otherwise.
  const voiding = async (loanId: string, target: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    expected_version: (await loanOf(loanId)).version,
    action: 'VOID',
    target,
    reason: 'ไม่เคยเกิดขึ้นจริง',
    ...overrides,
  });

  const amended = async (loanId: string, target: Record<string, unknown>, changes: Record<string, unknown>) => {
    const res = await correct(loanId, await amendment(loanId, target, changes));
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const voided = async (loanId: string, target: Record<string, unknown>) => {
    const res = await correct(loanId, await voiding(loanId, target));
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  // A Due Date Extension of `itemIds` to `newDueDate`, against the Loan's latest version.
  const extended = async (loanId: string, itemIds: string[], newDueDate: string) => {
    const res = await api.post(
      custodian,
      `/loans/${loanId}/due-date-extensions`,
      { expected_version: (await loanOf(loanId)).version, new_due_date: newDueDate, items: itemIds.map((loan_item_id) => ({ loan_item_id })) },
      { 'x-retry-token': crypto.randomUUID() }
    );
    expect(res.statusCode).toBe(201);
  };

  const itemOfLoan = async (loanId: string, itemId: string) => (await loanOf(loanId)).items.find(({ id }: any) => id === itemId);

  const person = (name: string = `สมชาย ${crypto.randomUUID().slice(0, 8)}`): Promise<Entry> => entry('persons', name);

  const deactivated = async (name: string): Promise<Entry> => {
    const created = await person(name);
    const res = await api.post(admin, `/references/persons/${created.id}`, { expected_version: 1, is_active: false });
    expect(res.statusCode).toBe(200);
    return created;
  };

  const correctionsOf = async (loanId: string) => (await loanOf(loanId)).corrections;

  const countOf = async (table: string) => (await api.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_loan_correction', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_loan_correction', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_loan_correction', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('amending the Loan', () => {
    it('leaves the corrected value on the Loan and keeps the reason, the actor, Recorded At and the before and after', async () => {
      const { loanId, version } = await lent([await registered()], { remark: 'ยืมไปใช้งาน' });

      const res = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { remark: 'ยืมไปใช้ประชุม' }));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ loan_id: loanId, version: version + 1, correction_id: expect.stringMatching(UUID) });
      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ remark: 'ยืมไปใช้ประชุม', version: version + 1 });
      expect(loan.corrections).toEqual([
        {
          id: res.json().correction_id,
          target: { kind: 'LOAN', id: loanId },
          action: 'AMENDED',
          reason: 'บันทึกผิดจากใบยืม',
          changes: [{ field: 'remark', before: 'ยืมไปใช้งาน', after: 'ยืมไปใช้ประชุม' }],
          recorded_by: custodian.id,
          recorded_by_username: 'custodian_loan_correction',
          recorded_at: expect.any(String),
        },
      ]);
    });

    it('amends the Loan Date, the Authorizer and the document reference, and removes the remark, recording each field changed', async () => {
      const authorizer = await person('ผู้อนุญาตใหม่');
      const { loanId } = await lent([await registered()], { document_reference: 'ยม 1/2569', remark: 'หมายเหตุผิด' });

      await amended(loanId, { kind: 'LOAN' }, { loan_date: '2026-10-30', authorizer_person_id: authorizer.id, document_reference: 'ยม 2/2569', remark: null });

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ loan_date: '2026-10-30', authorizer: { id: authorizer.id, name: 'ผู้อนุญาตใหม่' }, document_reference: 'ยม 2/2569', remark: null });
      expect(loan.corrections[0].changes).toEqual([
        { field: 'loan_date', before: LOAN_DATE, after: '2026-10-30' },
        { field: 'authorizer_person_id', before: null, after: { id: authorizer.id, name: 'ผู้อนุญาตใหม่', is_active: true } },
        { field: 'document_reference', before: 'ยม 1/2569', after: 'ยม 2/2569' },
        { field: 'remark', before: 'หมายเหตุผิด', after: null },
      ]);
    });

    it('switches an External Borrower to an Internal one and back, recording the phone number only as changed', async () => {
      const internal = await person('สมหญิง ผู้ยืมภายใน');
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณภายนอก', organization_name: 'บริษัท ข', phone: PHONE } });

      await amended(loanId, { kind: 'LOAN' }, { borrower: { kind: 'INTERNAL', person_id: internal.id } });
      expect((await loanOf(loanId, custodian)).borrower).toEqual({ kind: 'INTERNAL', person: { id: internal.id, name: 'สมหญิง ผู้ยืมภายใน', is_active: true } });

      await amended(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณภายนอกจริง', phone: '02-111-2222' } });
      expect((await loanOf(loanId, custodian)).borrower).toEqual({ kind: 'EXTERNAL', contact_name: 'คุณภายนอกจริง', organization_name: null, phone: '02-111-2222' });

      const [toInternal, toExternal] = await correctionsOf(loanId);
      expect(toInternal.changes).toEqual([
        { field: 'borrower_kind', before: 'EXTERNAL', after: 'INTERNAL' },
        { field: 'borrower_person_id', before: null, after: { id: internal.id, name: 'สมหญิง ผู้ยืมภายใน', is_active: true } },
        { field: 'borrower_contact_name', before: 'คุณภายนอก', after: null },
        { field: 'borrower_organization_name', before: 'บริษัท ข', after: null },
        { field: 'borrower_phone' },
      ]);
      expect(toExternal.changes).toEqual([
        { field: 'borrower_kind', before: 'INTERNAL', after: 'EXTERNAL' },
        { field: 'borrower_person_id', before: { id: internal.id, name: 'สมหญิง ผู้ยืมภายใน', is_active: true }, after: null },
        { field: 'borrower_contact_name', before: null, after: 'คุณภายนอกจริง' },
        { field: 'borrower_phone' },
      ]);
    });

    it('removes the phone number, and keeps neither value anywhere in its history (#74 Q24)', async () => {
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', phone: PHONE } });
      const token = crypto.randomUUID();

      const res = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', phone: null } }), token);

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(PHONE);
      expect((await loanOf(loanId, custodian)).borrower).toEqual({ kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', organization_name: null, phone: null });
      const loan = await api.get(custodian, `/loans/${loanId}`);
      expect(loan.body).not.toContain(PHONE);
      expect(loan.json().corrections[0].changes).toEqual([{ field: 'borrower_phone' }]);
      const stored = await api.pool.query(`SELECT changes::text AS changes FROM loan_corrections WHERE loan_id = $1`, [loanId]);
      expect(stored.rows[0].changes).not.toContain(PHONE.slice(0, 3));
      const receipts = await api.pool.query(`SELECT response_body::text AS body FROM registration_retry_tokens WHERE token = $1`, [token]);
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0].body).not.toContain(PHONE);
    });

    it('records a changed phone number as changed, with neither value', async () => {
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณเปลี่ยนเบอร์', phone: PHONE } });

      await amended(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณเปลี่ยนเบอร์', phone: '090-000-1111' } });

      const res = await api.get(custodian, `/loans/${loanId}`);
      expect(res.json().borrower.phone).toBe('090-000-1111');
      expect(res.json().corrections[0].changes).toEqual([{ field: 'borrower_phone' }]);
      for (const phone of [PHONE, '090-000-1111']) {
        expect(JSON.stringify(res.json().corrections)).not.toContain(phone);
      }
    });

    it('may name deactivated Person entries, but only entries of the Person Reference List', async () => {
      const [leftBorrower, leftAuthorizer] = [await deactivated('ผู้ยืมลาออกแล้ว'), await deactivated('ผู้อนุญาตลาออกแล้ว')];
      const { loanId } = await lent([await registered()]);

      await amended(loanId, { kind: 'LOAN' }, { borrower: { kind: 'INTERNAL', person_id: leftBorrower.id }, authorizer_person_id: leftAuthorizer.id });
      expect(await loanOf(loanId)).toMatchObject({
        borrower: { kind: 'INTERNAL', person: { id: leftBorrower.id, is_active: false } },
        authorizer: { id: leftAuthorizer.id, is_active: false },
      });

      const before = await loanOf(loanId);
      for (const changes of [{ authorizer_person_id: crypto.randomUUID() }, { borrower: { kind: 'INTERNAL', person_id: crypto.randomUUID() } }, { authorizer_person_id: 'ผู้อนุญาต' }]) {
        const res = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, changes));
        expect(res.statusCode).toBe(400);
      }
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('refuses a Loan Date after today, or after a Due Date, a Return Date or a Not Returned date, and writes nothing', async () => {
      const [kept, back, gone] = [await registered(), await registered(), await registered()];
      const { loanId, itemOf } = await lent([kept, back, gone], { loan_date: '2026-10-20', due_date: '2026-10-25' });
      await returned(loanId, [itemOf[back]], '2026-10-28');
      await closedNotReturned(loanId, [itemOf[gone]], '2026-10-30');
      const before = await loanOf(loanId);

      for (const [loanDate, message] of [
        ['2026-11-06', /after today/],
        ['2026-10-26', /Due Date/],
        ['2026-10-29', /Due Date|Return Date/],
      ] as const) {
        const res = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { loan_date: loanDate }));
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(message);
      }
      expect(await loanOf(loanId)).toEqual(before);

      // The Due Date, the Return Date and the Not Returned date may each be the Loan Date itself.
      await amended(loanId, { kind: 'LOAN' }, { loan_date: '2026-10-25' });
    });

    it('needs a nonblank reason and a change, and takes only the Loan\'s own fields', async () => {
      const { loanId } = await lent([await registered()], { remark: 'เดิม' });
      const before = await loanOf(loanId);
      const refused = async (payload: Record<string, unknown>) => {
        const res = await correct(loanId, payload);
        expect(res.statusCode).toBe(400);
        return res.json().message as string;
      };

      expect(await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'ใหม่' }, { reason: '   ' }))).toMatch(/reason/);
      await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'ใหม่' }, { reason: undefined }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'ใหม่' }, { reason: over(2000) }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'ใหม่' }, { reason: 'มี\u0000ตัวควบคุม' }));
      expect(await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'เดิม' }))).toMatch(/changes nothing/);
      expect(await refused(await amendment(loanId, { kind: 'LOAN' }, {}))).toMatch(/changes nothing/);
      expect(await refused(await amendment(loanId, { kind: 'LOAN' }, { due_date: '2026-11-20' }))).toMatch(/cannot be amended/);
      await refused(await amendment(loanId, { kind: 'LOAN' }, { recorded_by: admin.id }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณ', id_number: '1234' } }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: '  ' } }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณ', phone: 'โทร 081' } }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { loan_date: '2026-02-30' }));
      await refused(await amendment(loanId, { kind: 'LOAN' }, { remark: 'มีบรรทัด\u0007ระฆัง' }));

      expect(await loanOf(loanId)).toEqual(before);
    });
  });

  describe('amending a LoanItem', () => {
    it('amends the Due Date as first recorded and the Condition at lending, which Overdue then follows', async () => {
      const [first, other] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, other]);

      await amended(loanId, { kind: 'LOAN_ITEM', id: itemOf[first] }, { due_date: '2026-11-03', condition: 'DAMAGED', condition_note: 'จอแตกตั้งแต่ก่อนยืม' });

      const loan = await loanOf(loanId);
      expect(loan.items.find(({ id }: any) => id === itemOf[first])).toMatchObject({
        due_date: '2026-11-03',
        first_due_date: '2026-11-03',
        condition: 'DAMAGED',
        condition_note: 'จอแตกตั้งแต่ก่อนยืม',
        is_overdue: true,
      });
      expect(loan.items.find(({ id }: any) => id === itemOf[other])).toMatchObject({ due_date: DUE, condition: 'NORMAL', is_overdue: false });
      expect(loan.is_overdue).toBe(true);
      expect(loan.corrections[0]).toMatchObject({
        target: { kind: 'LOAN_ITEM', id: itemOf[first] },
        changes: [
          { field: 'due_date', before: DUE, after: '2026-11-03' },
          { field: 'condition', before: 'NORMAL', after: 'DAMAGED' },
          { field: 'condition_note', before: null, after: 'จอแตกตั้งแต่ก่อนยืม' },
        ],
      });
    });

    it('leaves the current Due Date with a later Due Date Extension', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await extended(loanId, [itemOf[assetId]], '2026-11-20');

      await amended(loanId, { kind: 'LOAN_ITEM', id: itemOf[assetId] }, { due_date: '2026-11-08' });

      expect(await itemOfLoan(loanId, itemOf[assetId])).toMatchObject({ due_date: '2026-11-20', first_due_date: '2026-11-08' });
    });

    it('refuses a first Due Date on or after a Due Date Extension\'s, which would no longer move it later', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await extended(loanId, [itemOf[assetId]], '2026-11-20');
      const before = await loanOf(loanId);

      for (const due_date of ['2026-11-20', '2026-11-25']) {
        const refused = await correct(loanId, await amendment(loanId, { kind: 'LOAN_ITEM', id: itemOf[assetId] }, { due_date }));
        expect(refused.statusCode).toBe(400);
        expect(refused.json().message).toMatch(/Due Date Extension/);
      }
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('refuses a Due Date before the Loan Date, and never changes the item\'s Asset', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      const before = await loanOf(loanId);

      const early = await correct(loanId, await amendment(loanId, { kind: 'LOAN_ITEM', id: itemOf[assetId] }, { due_date: '2026-10-31' }));
      expect(early.statusCode).toBe(400);
      expect(early.json().message).toMatch(/Due Date/);
      for (const changes of [{ asset_id: await registered() }, { return_date: TODAY }, { loan_date: LOAN_DATE }]) {
        expect((await correct(loanId, await amendment(loanId, { kind: 'LOAN_ITEM', id: itemOf[assetId] }, changes))).statusCode).toBe(400);
      }
      expect(await loanOf(loanId)).toEqual(before);
    });
  });

  describe('amending an ending', () => {
    it('amends a Return Date and the Condition at return', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-04');
      const returnId = (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id;

      await amended(loanId, { kind: 'LOAN_RETURN', id: returnId }, { return_date: '2026-11-02', condition: 'DAMAGED', condition_note: 'ฝาหลังบุบ' });

      expect((await itemOfLoan(loanId, itemOf[assetId])).loan_return).toMatchObject({ id: returnId, return_date: '2026-11-02', condition: 'DAMAGED', condition_note: 'ฝาหลังบุบ' });
      expect((await correctionsOf(loanId))[0]).toMatchObject({
        target: { kind: 'LOAN_RETURN', id: returnId },
        changes: [
          { field: 'return_date', before: '2026-11-04', after: '2026-11-02' },
          { field: 'condition', before: 'NORMAL', after: 'DAMAGED' },
          { field: 'condition_note', before: null, after: 'ฝาหลังบุบ' },
        ],
      });
    });

    it('amends a Not Returned date and its reason', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-04');
      const notReturnedId = (await itemOfLoan(loanId, itemOf[assetId])).not_returned.id;

      await amended(loanId, { kind: 'NOT_RETURNED', id: notReturnedId }, { not_returned_date: '2026-11-03', reason: 'ผู้ยืมแจ้งว่าถูกขโมย' });

      expect((await itemOfLoan(loanId, itemOf[assetId])).not_returned).toMatchObject({ not_returned_date: '2026-11-03', reason: 'ผู้ยืมแจ้งว่าถูกขโมย' });
      const blank = await correct(loanId, await amendment(loanId, { kind: 'NOT_RETURNED', id: notReturnedId }, { reason: ' ' }));
      expect(blank.statusCode).toBe(400);
    });

    it('refuses an ending date before the Loan Date or after today, and a Loan Return dated before its item\'s Not Returned', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-03');
      await returned(loanId, [itemOf[assetId]], '2026-11-04');
      const item = await itemOfLoan(loanId, itemOf[assetId]);
      const before = await loanOf(loanId);

      for (const [target, changes, message] of [
        [{ kind: 'LOAN_RETURN', id: item.loan_return.id }, { return_date: '2026-10-31' }, /Return Date/],
        [{ kind: 'LOAN_RETURN', id: item.loan_return.id }, { return_date: '2026-11-06' }, /after today/],
        [{ kind: 'LOAN_RETURN', id: item.loan_return.id }, { return_date: '2026-11-02' }, /Not Returned/],
        [{ kind: 'NOT_RETURNED', id: item.not_returned.id }, { not_returned_date: '2026-10-31' }, /Not Returned date/],
        [{ kind: 'NOT_RETURNED', id: item.not_returned.id }, { not_returned_date: TODAY }, /Not Returned/],
        [{ kind: 'NOT_RETURNED', id: item.not_returned.id }, { condition: 'DAMAGED' }, /cannot be amended/],
      ] as const) {
        const res = await correct(loanId, await amendment(loanId, target, changes));
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(message);
      }
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('refuses to amend a Due Date Extension, which is voided and recorded again', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await extended(loanId, [itemOf[assetId]], '2026-11-20');
      const extensionId = (await itemOfLoan(loanId, itemOf[assetId])).due_date_extensions[0].id;

      const res = await correct(loanId, await amendment(loanId, { kind: 'DUE_DATE_EXTENSION', id: extensionId }, { due_date: '2026-11-15' }));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/void it and record it again/);
    });
  });

  describe('voiding', () => {
    it('voids a Loan with its items and every fact on them in one action; it stays shown and counts in nothing', async () => {
      const [out, back, gone, extendedAsset] = [await registered(), await registered(), await registered(), await registered()];
      const { loanId, itemOf } = await lent([out, back, gone, extendedAsset], { loan_date: '2026-10-20', due_date: '2026-10-25' });
      await returned(loanId, [itemOf[back]], '2026-10-28');
      await closedNotReturned(loanId, [itemOf[gone]], '2026-10-30');
      await extended(loanId, [itemOf[extendedAsset]], '2026-11-01');
      const correctionsBefore = await countOf('loan_corrections');

      const { correction_id: correctionId } = await voided(loanId, { kind: 'LOAN' });

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ is_voided: true, status: null, is_overdue: false });
      expect(loan.items).toHaveLength(4);
      for (const item of loan.items) {
        expect(item).toMatchObject({ is_voided: true, ending_kind: 'NONE', is_overdue: false, loan_return: null, not_returned: null });
      }
      expect((await itemOfLoan(loanId, itemOf[back])).voided_endings).toEqual([expect.objectContaining({ kind: 'LOAN_RETURN', return_date: '2026-10-28' })]);
      expect((await itemOfLoan(loanId, itemOf[gone])).voided_endings).toEqual([expect.objectContaining({ kind: 'NOT_RETURNED', not_returned_date: '2026-10-30' })]);
      expect((await itemOfLoan(loanId, itemOf[extendedAsset])).due_date_extensions).toEqual([expect.objectContaining({ is_voided: true })]);
      expect(loan.corrections).toEqual([expect.objectContaining({ id: correctionId, target: { kind: 'LOAN', id: loanId }, action: 'VOIDED', changes: [] })]);
      expect(await countOf('loan_corrections')).toBe(correctionsBefore + 1);

      // Neither On Loan, Overdue nor the uniqueness rule counts it: every Asset can be lent again.
      for (const assetId of [out, gone]) {
        expect((await api.get(readonly, `/assets/${assetId}`)).json()).toMatchObject({ on_loan: null, not_returned: null });
      }
      expect((await start([out, gone], { loan_date: TODAY })).statusCode).toBe(201);
    });

    it('lists a voided Loan with no status, outside the status and Overdue filters', async () => {
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณยกเลิกทั้งรายการ' }, due_date: '2026-11-02' });
      await voided(loanId, { kind: 'LOAN' });
      const listed = async (query: string) => (await api.get(readonly, `/loans?borrower_name=${encodeURIComponent('คุณยกเลิกทั้งรายการ')}${query}`)).json();

      expect((await listed('')).items).toEqual([expect.objectContaining({ id: loanId, is_voided: true, status: null, is_overdue: false, item_count: 0 })]);
      for (const query of ['&status=OUTSTANDING', '&overdue=true']) {
        expect((await listed(query)).items).toEqual([]);
      }
    });

    it('voids a LoanItem with the facts on it, which frees its Asset; the Loan counts the others', async () => {
      const [wrong, right, alsoWrong] = [await registered(), await registered(), await registered()];
      const { loanId, itemOf } = await lent([wrong, right, alsoWrong], { due_date: '2026-11-03' });
      await extended(loanId, [itemOf[wrong]], '2026-11-20');
      await returned(loanId, [itemOf[right], itemOf[alsoWrong]], TODAY);

      await voided(loanId, { kind: 'LOAN_ITEM', id: itemOf[wrong] });
      await voided(loanId, { kind: 'LOAN_ITEM', id: itemOf[alsoWrong] });

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ status: 'RETURNED', is_voided: false, is_overdue: false });
      expect(loan.items.find(({ id }: any) => id === itemOf[wrong])).toMatchObject({ is_voided: true, due_date_extensions: [expect.objectContaining({ is_voided: true })] });
      expect(loan.items.find(({ id }: any) => id === itemOf[alsoWrong])).toMatchObject({
        is_voided: true,
        loan_return: null,
        voided_endings: [expect.objectContaining({ kind: 'LOAN_RETURN' })],
      });
      expect((await api.get(readonly, `/assets/${wrong}`)).json().on_loan).toBeNull();
      expect((await start([wrong], { loan_date: TODAY })).statusCode).toBe(201);
    });

    it('refuses to void a Loan\'s last item: the Loan is voided instead', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      await voided(loanId, { kind: 'LOAN_ITEM', id: itemOf[first] });
      const before = await loanOf(loanId);

      const res = await correct(loanId, await voiding(loanId, { kind: 'LOAN_ITEM', id: itemOf[second] }));

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/void the Loan instead/);
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('voids a Due Date Extension, which restores the item\'s previous Due Date', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { due_date: '2026-11-03' });
      await extended(loanId, [itemOf[assetId]], '2026-11-08');
      await extended(loanId, [itemOf[assetId]], '2026-11-20');
      const [, later] = (await itemOfLoan(loanId, itemOf[assetId])).due_date_extensions;

      await voided(loanId, { kind: 'DUE_DATE_EXTENSION', id: later.id });
      expect(await itemOfLoan(loanId, itemOf[assetId])).toMatchObject({ due_date: '2026-11-08', is_overdue: false });

      const [earlier] = (await itemOfLoan(loanId, itemOf[assetId])).due_date_extensions;
      await voided(loanId, { kind: 'DUE_DATE_EXTENSION', id: earlier.id });
      const item = await itemOfLoan(loanId, itemOf[assetId]);
      expect(item).toMatchObject({ due_date: '2026-11-03', is_overdue: true });
      expect(item.due_date_extensions.map(({ is_voided }: any) => is_voided)).toEqual([true, true]);
    });

    it('needs a nonblank reason and no changes', async () => {
      const { loanId } = await lent([await registered()]);
      const before = await loanOf(loanId);

      expect((await correct(loanId, await voiding(loanId, { kind: 'LOAN' }, { reason: '' }))).statusCode).toBe(400);
      expect((await correct(loanId, await voiding(loanId, { kind: 'LOAN' }, { changes: { remark: 'x' } }))).statusCode).toBe(400);
      expect((await correct(loanId, await voiding(loanId, { kind: 'LOAN' }, { action: 'DELETE' }))).statusCode).toBe(400);
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('neither amends nor voids a voided fact again, nor a fact voided with its Loan or item', async () => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      await returned(loanId, [itemOf[first]], TODAY);
      await extended(loanId, [itemOf[second]], '2026-11-20');
      const returnId = (await itemOfLoan(loanId, itemOf[first])).loan_return.id;
      const extensionId = (await itemOfLoan(loanId, itemOf[second])).due_date_extensions[0].id;
      await voided(loanId, { kind: 'LOAN_RETURN', id: returnId });
      await voided(loanId, { kind: 'LOAN' });
      const before = await loanOf(loanId);

      for (const target of [
        { kind: 'LOAN' },
        { kind: 'LOAN_ITEM', id: itemOf[first] },
        { kind: 'LOAN_RETURN', id: returnId },
        { kind: 'DUE_DATE_EXTENSION', id: extensionId },
      ]) {
        const res = await correct(loanId, await voiding(loanId, target));
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/voided/);
      }
      expect((await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { remark: 'แก้หลังยกเลิก' }))).statusCode).toBe(400);
      expect((await correct(loanId, await amendment(loanId, { kind: 'LOAN_ITEM', id: itemOf[second] }, { condition: 'DAMAGED' }))).statusCode).toBe(400);
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('answers a fact the Loan does not have with 404, and a malformed target with 400', async () => {
      const [mine, theirs] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([mine]);
      const other = await lent([theirs]);

      for (const target of [{ kind: 'LOAN_ITEM', id: other.itemOf[theirs] }, { kind: 'LOAN_RETURN', id: crypto.randomUUID() }, { kind: 'NOT_RETURNED', id: itemOf[mine] }]) {
        expect((await correct(loanId, await voiding(loanId, target))).statusCode).toBe(404);
      }
      expect((await correct(crypto.randomUUID(), await voiding(loanId, { kind: 'LOAN' }))).statusCode).toBe(404);
      expect((await correct('not-a-loan', await voiding(loanId, { kind: 'LOAN' }))).statusCode).toBe(400);
      for (const target of [{ kind: 'LOAN_ITEM', id: 'item' }, { kind: 'LOAN_ITEM' }, { kind: 'ASSET', id: mine }, { kind: 'LOAN', id: loanId }]) {
        expect((await correct(loanId, await voiding(loanId, target))).statusCode).toBe(400);
      }
    });
  });

  describe('restoring an item\'s state (#74 Q25)', () => {
    it('returns an item to Outstanding when its Loan Return is voided, keeping the voided one shown', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId], { due_date: '2026-11-03' });
      await returned(loanId, [itemOf[assetId]], TODAY);
      const returnId = (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id;

      await voided(loanId, { kind: 'LOAN_RETURN', id: returnId });

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({ status: 'OUTSTANDING', is_overdue: true });
      expect(loan.items[0]).toMatchObject({
        ending_kind: 'NONE',
        loan_return: null,
        is_overdue: true,
        voided_endings: [{ kind: 'LOAN_RETURN', id: returnId, return_date: TODAY, condition: 'NORMAL', condition_note: null, document_reference: null, remark: null, action_reference: expect.stringMatching(UUID), recorded_by: custodian.id, recorded_by_username: 'custodian_loan_correction', recorded_at: expect.any(String) }],
      });
      expect((await api.get(readonly, `/assets/${assetId}`)).json().on_loan).toMatchObject({ loan_id: loanId });
      // The item can take a Loan Return again.
      await returned(loanId, [itemOf[assetId]], TODAY);
    });

    it('returns an item to Not Returned when only its later Loan Return is voided', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await closedNotReturned(loanId, [itemOf[assetId]], '2026-11-02');
      await returned(loanId, [itemOf[assetId]], '2026-11-04');

      await voided(loanId, { kind: 'LOAN_RETURN', id: (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id });

      expect(await loanOf(loanId)).toMatchObject({ status: 'CLOSED' });
      expect(await itemOfLoan(loanId, itemOf[assetId])).toMatchObject({ ending_kind: 'NOT_RETURNED', loan_return: null, not_returned: { not_returned_date: '2026-11-02' } });
      expect((await start([assetId], { loan_date: TODAY })).json()).toMatchObject({ code: 'ASSETS_NOT_LENDABLE', assets: [{ reason: 'NOT_RETURNED', loan_id: loanId }] });
    });

    it('returns an item to Outstanding when its Not Returned is voided, and leaves a later Loan Return winning', async () => {
      const [lost, found] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([lost, found]);
      await closedNotReturned(loanId, [itemOf[lost], itemOf[found]], '2026-11-02');
      await returned(loanId, [itemOf[found]], '2026-11-04');

      await voided(loanId, { kind: 'NOT_RETURNED', id: (await itemOfLoan(loanId, itemOf[lost])).not_returned.id });
      await voided(loanId, { kind: 'NOT_RETURNED', id: (await itemOfLoan(loanId, itemOf[found])).not_returned.id });

      expect(await itemOfLoan(loanId, itemOf[lost])).toMatchObject({ ending_kind: 'NONE', not_returned: null, voided_endings: [expect.objectContaining({ kind: 'NOT_RETURNED', reason: 'ผู้ยืมแจ้งว่าทำหาย' })] });
      expect(await itemOfLoan(loanId, itemOf[found])).toMatchObject({ ending_kind: 'LOAN_RETURN', not_returned: null, loan_return: { return_date: '2026-11-04' } });
      expect(await loanOf(loanId)).toMatchObject({ status: 'PARTIALLY_RETURNED' });
    });

    it('refuses the void when the Asset has since gone out on another Loan, naming that Loan, and writes nothing', async () => {
      const assetId = await registered('โปรเจกเตอร์ยืมต่อ');
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-03');
      const next = await lent([assetId], { loan_date: '2026-11-04' });
      const returnId = (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id;
      const before = await loanOf(loanId);

      const res = await correct(loanId, await voiding(loanId, { kind: 'LOAN_RETURN', id: returnId }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        statusCode: 409,
        code: 'ASSET_ON_ANOTHER_LOAN',
        asset: { asset_id: assetId, name: 'โปรเจกเตอร์ยืมต่อ', asset_number: null, loan_id: next.loanId, reason: 'ON_LOAN' },
      });
      expect(res.body).not.toContain('คุณผู้ยืมแก้ไข');
      expect(await loanOf(loanId)).toEqual(before);

      // Once that Loan has been dealt with, the void goes through, confirming the Loan Conflict it opens (#74 Q25).
      await returned(next.loanId, [next.itemOf[assetId]], TODAY);
      const confirmed = await correct(
        loanId,
        await voiding(loanId, { kind: 'LOAN_RETURN', id: returnId }, { confirmed_conflicts: [{ conflicting_loan_item_id: next.itemOf[assetId] }] })
      );
      expect(confirmed.statusCode).toBe(201);
    });

    it('refuses it too when the other Loan ended Not Returned', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await returned(loanId, [itemOf[assetId]], '2026-11-03');
      const next = await lent([assetId], { loan_date: '2026-11-04' });
      await closedNotReturned(next.loanId, [next.itemOf[assetId]], TODAY);

      const res = await correct(loanId, await voiding(loanId, { kind: 'LOAN_RETURN', id: (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id }));

      expect(res.statusCode).toBe(409);
      expect(res.json().asset).toMatchObject({ loan_id: next.loanId, reason: 'NOT_RETURNED' });
    });

    it('holds LR-11 when a void and a new Loan of the Asset race: one of them is refused', async () => {
      for (let round = 0; round < 3; round++) {
        const assetId = await registered();
        const { loanId, itemOf } = await lent([assetId]);
        await returned(loanId, [itemOf[assetId]], '2026-11-03');
        const payload = await voiding(loanId, { kind: 'LOAN_RETURN', id: (await itemOfLoan(loanId, itemOf[assetId])).loan_return.id });

        const [voidRes, startRes] = await Promise.all([correct(loanId, payload), start([assetId], { loan_date: TODAY })]);

        expect([voidRes.statusCode, startRes.statusCode].sort()).toEqual([201, 409]);
        const outstanding = await api.pool.query(`SELECT count(*)::int AS n FROM loan_items WHERE asset_id = $1 AND NOT is_voided AND ending_kind = 'NONE'`, [assetId]);
        expect(outstanding.rows[0].n).toBe(1);
      }
    });
  });

  describe('the Loan page', () => {
    it('shows corrections and their reasons to every reader, oldest first', async () => {
      const assetId = await registered();
      const { loanId, itemOf } = await lent([assetId]);
      await amended(loanId, { kind: 'LOAN' }, { remark: 'ครั้งแรก' });
      await amended(loanId, { kind: 'LOAN_ITEM', id: itemOf[assetId] }, { condition: 'DAMAGED' });

      const corrections = (await loanOf(loanId, readonly)).corrections;
      expect(corrections.map(({ target, reason }: any) => [target.kind, reason])).toEqual([
        ['LOAN', 'บันทึกผิดจากใบยืม'],
        ['LOAN_ITEM', 'บันทึกผิดจากใบยืม'],
      ]);
    });

    it('reads a named Person by current name', async () => {
      const authorizer = await person('ชื่อเดิมผู้อนุญาต');
      const { loanId } = await lent([await registered()]);
      await amended(loanId, { kind: 'LOAN' }, { authorizer_person_id: authorizer.id });
      expect((await api.post(admin, `/references/persons/${authorizer.id}`, { expected_version: 1, name: 'ชื่อใหม่ผู้อนุญาต' })).statusCode).toBe(200);

      expect((await correctionsOf(loanId))[0].changes).toEqual([{ field: 'authorizer_person_id', before: null, after: { id: authorizer.id, name: 'ชื่อใหม่ผู้อนุญาต', is_active: true } }]);
    });
  });

  describe('the phone number (LR-15, #74 Q24)', () => {
    it('goes to holders of loan:correct as well as loan:record, and to no one else', async () => {
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', phone: PHONE } });

      expect((await loanOf(loanId, admin)).borrower.phone).toBe(PHONE);
      expect((await loanOf(loanId, admin)).can_correct_loan).toBe(true);
      expect((await loanOf(loanId, custodian)).can_correct_loan).toBe(true);
      expect((await loanOf(loanId, readonly)).borrower).not.toHaveProperty('phone');
      expect((await loanOf(loanId, readonly)).can_correct_loan).toBe(false);
    });

    it('is left out for an Administrator when loan:correct alone is denied, or its lookup fails', async () => {
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณมีเบอร์', phone: PHONE } });

      await withCapabilityAnswer(api.app, 'loan:correct', async () => false, async () => {
        const loan = await loanOf(loanId, admin);
        expect(loan.borrower).not.toHaveProperty('phone');
        expect(loan.can_correct_loan).toBe(false);
      });
      await withCapabilityAnswer(api.app, 'loan:correct', async () => { throw new Error('lookup failed'); }, async () => {
        expect((await api.get(admin, `/loans/${loanId}`)).body).not.toContain(PHONE);
      });
    });
  });

  describe('concurrency', () => {
    it('refuses a stale version with the stale-before conflict, and writes nothing', async () => {
      const { loanId, version } = await lent([await registered()]);
      await amended(loanId, { kind: 'LOAN' }, { remark: 'ล่าสุด' });
      const before = await loanOf(loanId);

      const res = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { remark: 'จากฟอร์มเก่า' }, { expected_version: version }));

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'STALE_BEFORE_CONFLICT', current_values: { version: version + 1 }, expected_values: { version } });
      expect(await loanOf(loanId)).toEqual(before);
    });

    it('locks the Loan row first, then all of its Assets in identifier order', async () => {
      const [low, high] = [await registered(), await registered()].sort();
      const { loanId } = await lent([high, low]);

      const atLoanPayload = await amendment(loanId, { kind: 'LOAN' }, { remark: 'รอล็อก' });
      const [atLoan] = await whileHolding('loans', loanId, () => [correct(loanId, atLoanPayload)]);
      expect(atLoan.statusCode).toBe(201);

      const atAssetPayload = await amendment(loanId, { kind: 'LOAN' }, { remark: 'รอล็อก Asset' });
      const [atAsset] = await whileHolding('assets', low, () => [correct(loanId, atAssetPayload)]);
      expect(atAsset.statusCode).toBe(201);
    });

    it('ends concurrent corrections of one version with one correction, and the rest refused', async () => {
      const { loanId, version } = await lent([await registered()]);
      const payload = { expected_version: version, action: 'AMEND', target: { kind: 'LOAN' }, reason: 'พร้อมกัน', changes: { remark: 'พร้อมกัน' } };

      const results = await Promise.all(Array.from({ length: 5 }, () => correct(loanId, payload)));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await correctionsOf(loanId)).toHaveLength(1);
      expect((await loanOf(loanId)).version).toBe(version + 1);
    });
  });

  describe('retry token', () => {
    it('needs a token', async () => {
      const { loanId } = await lent([await registered()]);
      expect((await api.post(custodian, `/loans/${loanId}/corrections`, await voiding(loanId, { kind: 'LOAN' }))).statusCode).toBe(400);
      expect((await loanOf(loanId)).is_voided).toBe(false);
    });

    it('answers an identical replay with the committed result and writes nothing, and refuses a changed payload', async () => {
      const { loanId } = await lent([await registered()]);
      const token = crypto.randomUUID();
      const payload = await amendment(loanId, { kind: 'LOAN' }, { remark: 'แก้ครั้งเดียว' });

      const first = await correct(loanId, payload, token);
      expect(first.statusCode).toBe(201);
      const replay = await correct(loanId, payload, token);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await correctionsOf(loanId)).toHaveLength(1);

      const changed = await correct(loanId, { ...payload, reason: 'เหตุผลอื่น' }, token);
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });
  });

  describe('a failure to persist', () => {
    it.each([
      ['the correction record', 'fail_loan_correction_record', 'loan_corrections', 'INSERT'],
      ['a voided item', 'fail_loan_correction_item', 'loan_items', 'UPDATE'],
      ['the Loan\'s version', 'fail_loan_correction_version', 'loans', 'UPDATE'],
    ] as const)('saves nothing when %s cannot be written', async (_what, name, table, event) => {
      const [first, second] = [await registered(), await registered()];
      const { loanId, itemOf } = await lent([first, second]);
      const payload = await voiding(loanId, { kind: 'LOAN_ITEM', id: itemOf[first] });
      const token = crypto.randomUUID();
      const before = await loanOf(loanId);
      await api.pool.query(`
        CREATE FUNCTION ${name}() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected correction failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();
      `);
      try {
        const res = await correct(loanId, payload, token);
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain('injected');
        expect(await loanOf(loanId)).toEqual(before);
      } finally {
        await api.pool.query(`DROP TRIGGER ${name} ON ${table}; DROP FUNCTION ${name}();`);
      }
      expect((await correct(loanId, payload, token)).statusCode).toBe(201);
    });
  });

  describe('authorization', () => {
    it('lets an Administrator correct, and refuses a Read-only User and a System Maintainer, saving nothing', async () => {
      const { loanId } = await lent([await registered()]);
      const maintainer = await api.actor('maintainer_loan_correction', 'SYSTEM_MAINTAINER');
      const before = await loanOf(loanId);

      for (const actor of [readonly, maintainer]) {
        expect((await correct(loanId, await voiding(loanId, { kind: 'LOAN' }), crypto.randomUUID(), actor)).statusCode).toBe(403);
      }
      expect(await loanOf(loanId)).toEqual(before);

      const byAdmin = await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { remark: 'แก้โดยผู้ดูแลระบบ' }), crypto.randomUUID(), admin);
      expect(byAdmin.statusCode).toBe(201);
      expect((await correctionsOf(loanId))[0]).toMatchObject({ recorded_by: admin.id, recorded_by_username: 'admin_loan_correction' });
    });

    it('needs loan:correct itself, and fails closed when the lookup fails, saving nothing', async () => {
      const { loanId } = await lent([await registered()]);
      const payload = await voiding(loanId, { kind: 'LOAN' });

      expect((await withCapabilityAnswer(api.app, 'loan:correct', async () => false, () => correct(loanId, payload))).statusCode).toBe(403);
      const failed = await withCapabilityAnswer(api.app, 'loan:correct', async () => { throw new Error('lookup failed'); }, () => correct(loanId, payload));
      expect(failed.statusCode).toBe(500);
      expect((await loanOf(loanId)).is_voided).toBe(false);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const { loanId } = await lent([await registered()]);
      const payload = await voiding(loanId, { kind: 'LOAN' });
      const send = (headers: Record<string, string>) =>
        api.app.inject({ method: 'POST', url: `/loans/${loanId}/corrections`, headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers }, payload });

      expect([401, 403]).toContain((await send({})).statusCode);
      expect((await send({ cookie: custodian.cookie })).statusCode).toBe(403);
      const leaving = await api.actor('custodian_inactive_loan_correction', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await correct(loanId, payload, crypto.randomUUID(), leaving)).statusCode);
      expect((await loanOf(loanId)).is_voided).toBe(false);
    });
  });

  describe('logs (LR-15)', () => {
    it('hold no Borrower details', async () => {
      const name = 'คุณไม่ลงบันทึกแก้ไข';
      const { loanId } = await lent([await registered()], { borrower: { kind: 'EXTERNAL', contact_name: name, phone: PHONE } });
      logLines.length = 0;

      expect((await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: `${name}จริง`, phone: '099-888-7777' } }))).statusCode).toBe(201);
      expect((await correct(loanId, await amendment(loanId, { kind: 'LOAN' }, { borrower: { kind: 'EXTERNAL', contact_name: name, phone: 'ผิด' } }))).statusCode).toBe(400);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      for (const detail of [name, PHONE, '099-888-7777']) {
        expect(logged).not.toContain(detail);
      }
    });
  });
});
