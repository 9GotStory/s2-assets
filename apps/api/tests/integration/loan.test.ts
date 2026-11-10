import * as crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, type Actor, type ApiHarness } from './support/api-harness.ts';
import { assignmentHelpers, type Entry } from './support/assignment-helpers.ts';
import { withCapabilityAnswer } from './support/capability-helpers.ts';
import { loanHelpers, over } from './support/loan-helpers.ts';

const TODAY = '2026-11-05';
const DUE = '2026-11-20';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// F004-T1 (#75): starting a Loan, and reading who holds an Asset.
describe('Starting a Loan (Seam A - F004-T1)', () => {
  let api: ApiHarness;
  let admin: Actor;
  let custodian: Actor;
  let readonly: Actor;
  let now = new Date('2026-11-05T05:00:00Z');
  const logLines: string[] = [];

  const { entry, entries, detailOf, assignmentOf } = assignmentHelpers(() => ({ api, admin, reader: readonly }));
  const { registered, loanOf } = loanHelpers(() => ({ api, custodian, reader: readonly }));

  const person = (name: string = `คน ${crypto.randomUUID()}`): Promise<Entry> => entry('persons', name);

  const itemsFor = (assetIds: string[]) => assetIds.map((asset_id) => ({ asset_id, condition: 'NORMAL' }));

  const internalBorrower = (borrower: Entry) => ({ kind: 'INTERNAL', person_id: borrower.id });

  // A valid request for `assetIds`, to an External Borrower unless `overrides` says otherwise.
  const base = (assetIds: string[], overrides: Record<string, unknown> = {}) => ({
    assets: itemsFor(assetIds),
    borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ยืม' },
    loan_date: TODAY,
    due_date: DUE,
    ...overrides,
  });

  const start =(payload: Record<string, unknown>, token: string = crypto.randomUUID(), actor: Actor = custodian) =>
    api.post(actor, '/loans', payload, { 'x-retry-token': token });

  const loansOf = async (assetId: string) => {
    const res = await api.get(readonly, `/assets/${assetId}/loans`);
    expect(res.statusCode).toBe(200);
    return res.json().items;
  };

  beforeAll(async () => {
    api = await startApiHarness({
      clock: () => now,
      logger: { level: 'trace', stream: { write: (line: string) => void logLines.push(line) } },
    });
    admin = await api.actor('admin_loan', 'ADMINISTRATOR');
    custodian = await api.actor('custodian_loan', 'ASSET_CUSTODIAN');
    readonly = await api.actor('readonly_loan', 'READ_ONLY');
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  describe('starting', () => {
    it('saves a Loan for an Internal Borrower, and the Loan page shows every fact of it', async () => {
      const borrower = await person('สมชาย ยืมของ');
      const authorizer = await person('สมศรี อนุญาต');
      const [first, second] = [await registered('โน้ตบุ๊ก A'), await registered('โน้ตบุ๊ก B')];
      const before = Date.now();

      const res = await start({
        assets: [
          { asset_id: first, condition: 'NORMAL' },
          { asset_id: second, condition: 'DAMAGED', condition_note: 'ฝาหลังบุบ' },
        ],
        borrower: internalBorrower(borrower),
        loan_date: TODAY,
        due_date: DUE,
        authorizer_person_id: authorizer.id,
        document_reference: 'บันทึก 7/2569',
        remark: 'ใช้ประชุมนอกสถานที่',
      });

      expect(res.statusCode).toBe(201);
      const { loan_id: loanId, version, items } = res.json();
      expect(loanId).toMatch(UUID);
      expect(version).toBe(1);
      expect(items.map(({ asset_id }: any) => asset_id).sort()).toEqual([first, second].sort());

      const loan = await loanOf(loanId);
      expect(loan).toMatchObject({
        id: loanId,
        borrower: { kind: 'INTERNAL', person: { id: borrower.id, name: 'สมชาย ยืมของ', is_active: true } },
        loan_date: TODAY,
        authorizer: { id: authorizer.id, name: 'สมศรี อนุญาต', is_active: true },
        document_reference: 'บันทึก 7/2569',
        remark: 'ใช้ประชุมนอกสถานที่',
        recorded_by: custodian.id,
        recorded_by_username: 'custodian_loan',
        is_voided: false,
        version: 1,
      });
      expect(Date.parse(loan.recorded_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(loan.recorded_at)).toBeLessThanOrEqual(Date.now());
      expect(loan.items).toEqual([
        {
          id: expect.stringMatching(UUID),
          asset: { id: first, name: 'โน้ตบุ๊ก A', asset_number: null },
          due_date: DUE,
          condition: 'NORMAL',
          condition_note: null,
          ending_kind: 'NONE',
          is_voided: false,
          is_overdue: false,
          loan_return: null,
          not_returned: null,
          due_date_extensions: [],
        },
        {
          id: expect.stringMatching(UUID),
          asset: { id: second, name: 'โน้ตบุ๊ก B', asset_number: null },
          due_date: DUE,
          condition: 'DAMAGED',
          condition_note: 'ฝาหลังบุบ',
          ending_kind: 'NONE',
          is_voided: false,
          is_overdue: false,
          loan_return: null,
          not_returned: null,
          due_date_extensions: [],
        },
      ]);
    });

    it('saves a Loan for an External Borrower with only the fields given', async () => {
      const assetId = await registered();

      const res = await start({
        ...base([assetId]),
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณสมหญิง' },
      });

      expect(res.statusCode).toBe(201);
      expect((await loanOf(res.json().loan_id, custodian)).borrower).toEqual({
        kind: 'EXTERNAL',
        contact_name: 'คุณสมหญิง',
        organization_name: null,
        phone: null,
      });
    });
  });

  describe('the phone number (LR-15)', () => {
    const PHONE = '081-234-5678';

    const lentExternally = async () => {
      const assetId = await registered();
      const res = await start({
        ...base([assetId]),
        borrower: { kind: 'EXTERNAL', contact_name: 'คุณเบอร์โทร', organization_name: 'บริษัท ก', phone: PHONE },
      });
      expect(res.statusCode).toBe(201);
      return { assetId, loanId: res.json().loan_id as string, response: res };
    };

    it('goes to a holder of loan:record and to no one else, and the field is left out', async () => {
      const { loanId } = await lentExternally();

      expect((await loanOf(loanId, custodian)).borrower.phone).toBe(PHONE);
      for (const reader of [readonly, admin]) {
        const { borrower } = await loanOf(loanId, reader);
        expect(borrower).toEqual({ kind: 'EXTERNAL', contact_name: 'คุณเบอร์โทร', organization_name: 'บริษัท ก' });
      }
    });

    it('is left out when loan:record alone is denied, even for a Custodian', async () => {
      const { loanId } = await lentExternally();

      await withCapabilityAnswer(api.app, 'loan:record', async () => false, async () => {
        const { borrower } = await loanOf(loanId, custodian);
        expect(borrower).not.toHaveProperty('phone');
      });
    });

    it('is not sent when the capability lookup fails', async () => {
      const { loanId } = await lentExternally();

      await withCapabilityAnswer(api.app, 'loan:record', async () => { throw new Error('lookup failed'); }, async () => {
        const res = await api.get(custodian, `/loans/${loanId}`);
        expect(res.body).not.toContain(PHONE);
      });
    });

    it('is on neither the Asset page nor its Loans, for anyone', async () => {
      const { assetId } = await lentExternally();

      for (const reader of [custodian, readonly]) {
        expect((await api.get(reader, `/assets/${assetId}`)).body).not.toContain(PHONE);
        expect((await api.get(reader, `/assets/${assetId}/loans`)).body).not.toContain(PHONE);
      }
    });
  });

  describe('who holds an Asset', () => {
    it('answers on the Asset page while it is On Loan, and is empty before', async () => {
      const borrower = await person('สมชาย ถือของ');
      const assetId = await registered();
      expect((await detailOf(assetId)).on_loan).toBeNull();

      const started = await start(base([assetId], { borrower: internalBorrower(borrower) }));

      expect((await detailOf(assetId)).on_loan).toEqual({
        loan_id: started.json().loan_id,
        borrower: { kind: 'INTERNAL', person: { id: borrower.id, name: 'สมชาย ถือของ', is_active: true } },
        due_date: DUE,
        is_overdue: false,
      });
    });

    it('lists the Asset\'s Loans', async () => {
      const assetId = await registered();
      const started = await start(base([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ถือ', organization_name: 'หน่วยนอก' } }));

      const res = await api.get(readonly, `/assets/${assetId}/loans`);

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        {
          id: started.json().items[0].id,
          loan_id: started.json().loan_id,
          loan_date: TODAY,
          due_date: DUE,
          borrower: { kind: 'EXTERNAL', contact_name: 'คุณผู้ถือ', organization_name: 'หน่วยนอก' },
          condition: 'NORMAL',
          condition_note: null,
          ending_kind: 'NONE',
          is_voided: false,
          is_overdue: false,
          loan_return: null,
          not_returned: null,
        },
      ]);
    });

    it('answers an Asset with no Loan with an empty list, an unknown one with 404, and a malformed id with 400', async () => {
      const assetId = await registered();

      expect((await api.get(readonly, `/assets/${assetId}/loans`)).json().items).toEqual([]);
      expect((await api.get(readonly, `/assets/${crypto.randomUUID()}/loans`)).statusCode).toBe(404);
      expect((await api.get(readonly, '/assets/not-a-uuid/loans')).statusCode).toBe(400);
    });

    it('keeps a deactivated Internal Borrower on the Loan, marked by the entry\'s state', async () => {
      const borrower = await person('สมชาย ลาออก');
      const assetId = await registered();
      const started = await start(base([assetId], { borrower: internalBorrower(borrower) }));

      const updated = await api.post(admin, `/references/persons/${borrower.id}`, { expected_version: 1, is_active: false });
      expect(updated.statusCode).toBe(200);

      const expected = { kind: 'INTERNAL', person: { id: borrower.id, name: 'สมชาย ลาออก', is_active: false } };
      expect((await loanOf(started.json().loan_id)).borrower).toEqual(expected);
      expect((await detailOf(assetId)).on_loan.borrower).toEqual(expected);
    });

    it('tells the page whether the viewer may start a Loan', async () => {
      const assetId = await registered();

      expect((await api.get(custodian, `/assets/${assetId}`)).json().can_record_loan).toBe(true);
      expect((await api.get(readonly, `/assets/${assetId}`)).json().can_record_loan).toBe(false);
      expect((await api.get(admin, `/assets/${assetId}`)).json().can_record_loan).toBe(false);
    });

    it('offers no start when loan:record alone is denied, even to a Custodian', async () => {
      const assetId = await registered();

      await withCapabilityAnswer(api.app, 'loan:record', async () => false, async () => {
        expect((await api.get(custodian, `/assets/${assetId}`)).json().can_record_loan).toBe(false);
      });
    });
  });

  describe('which Assets can be lent', () => {
    it('refuses an Asset that is On Loan whatever the Loan Date, and names the Loan that holds it (LR-11)', async () => {
      const assetId = await registered('เครื่องฉาย LR-11');
      const held = await start(base([assetId]));
      expect(held.statusCode).toBe(201);

      for (const loanDate of [TODAY, '2024-01-01']) {
        const res = await start(base([assetId], { loan_date: loanDate, due_date: DUE }));

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ statusCode: 409, code: 'ASSETS_NOT_LENDABLE', error: 'ASSETS_NOT_LENDABLE' });
        expect(res.json().assets).toEqual([
          { asset_id: assetId, name: 'เครื่องฉาย LR-11', asset_number: null, reason: 'ON_LOAN', loan_id: held.json().loan_id },
        ]);
      }
      expect(await loansOf(assetId)).toHaveLength(1);
    });

    it('saves nothing when any Asset cannot be lent, and names each such Asset and why', async () => {
      const [free, heldOne, heldTwo] = [await registered(), await registered('ของที่ถูกยืม 1'), await registered('ของที่ถูกยืม 2')];
      const missing = crypto.randomUUID();
      const loanOne = (await start(base([heldOne]))).json().loan_id;
      const loanTwo = (await start(base([heldTwo]))).json().loan_id;

      const res = await start(base([free, heldOne, heldTwo, missing]));

      expect(res.statusCode).toBe(409);
      const byAsset = Object.fromEntries(res.json().assets.map((asset: any) => [asset.asset_id, asset]));
      expect(Object.keys(byAsset).sort()).toEqual([heldOne, heldTwo, missing].sort());
      expect(byAsset[heldOne]).toMatchObject({ name: 'ของที่ถูกยืม 1', reason: 'ON_LOAN', loan_id: loanOne });
      expect(byAsset[heldTwo]).toMatchObject({ name: 'ของที่ถูกยืม 2', reason: 'ON_LOAN', loan_id: loanTwo });
      expect(byAsset[missing]).toEqual({ asset_id: missing, name: null, asset_number: null, reason: 'NOT_FOUND' });
      expect(await loansOf(free)).toEqual([]);
    });

    it('takes 1 to 100 Assets in one action', async () => {
      const assetIds = await Promise.all(Array.from({ length: 101 }, () => registered()));

      for (const tooMany of [[], assetIds]) {
        const res = await start(base(tooMany));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await loansOf(assetIds[0])).toEqual([]);

      const res = await start(base(assetIds.slice(0, 100)));
      expect(res.statusCode).toBe(201);
      expect(res.json().items).toHaveLength(100);
      expect(await loansOf(assetIds[100])).toEqual([]);
    }, 60_000);

    it('names each Asset once, and only by a well-formed id', async () => {
      const assetId = await registered();

      for (const assets of [
        [{ asset_id: assetId, condition: 'NORMAL' }, { asset_id: assetId, condition: 'DAMAGED' }],
        [{ asset_id: assetId, condition: 'NORMAL' }, { asset_id: assetId.toUpperCase(), condition: 'NORMAL' }],
        [{ asset_id: 'not-a-uuid', condition: 'NORMAL' }],
      ]) {
        const res = await start(base([], { assets }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_FAILED');
      }
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('has no way to add an Asset to a started Loan', async () => {
      const [lent, later] = [await registered(), await registered()];
      const token = crypto.randomUUID();
      const loanId = (await start(base([lent]), token)).json().loan_id;

      const namingTheLoan = await start(base([later], { loan_id: loanId }));
      const underItsToken = await start(base([lent, later]), token);

      expect(namingTheLoan.statusCode).toBe(400);
      expect(underItsToken.statusCode).toBe(409);
      expect(underItsToken.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect((await loanOf(loanId)).items.map(({ asset }: any) => asset.id)).toEqual([lent]);
      expect(await loansOf(later)).toEqual([]);
    });
  });

  describe('dates', () => {
    const atBangkokMidnight = async (work: () => Promise<void>) => {
      const before = now;
      try {
        await work();
      } finally {
        now = before;
      }
    };

    const refusedAsValidation = async (payload: Record<string, unknown>, assetId: string) => {
      const res = await start(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await loansOf(assetId)).toEqual([]);
    };

    it('takes today as a Loan Date and refuses tomorrow, at the Asia/Bangkok boundary', async () => {
      await atBangkokMidnight(async () => {
        const assetId = await registered();

        // 23:59:59 on 5 November in Bangkok.
        now = new Date('2026-11-05T16:59:59Z');
        await refusedAsValidation(base([assetId], { loan_date: '2026-11-06', due_date: '2026-11-20' }), assetId);

        // 00:00:00 on 6 November in Bangkok, still 5 November in UTC.
        now = new Date('2026-11-05T17:00:00Z');
        expect((await start(base([assetId], { loan_date: '2026-11-06', due_date: '2026-11-20' }))).statusCode).toBe(201);
      });
    });

    it('has no lower bound, and may be before the Asset was registered', async () => {
      const assetId = await registered();

      const res = await start(base([assetId], { loan_date: '1999-01-01', due_date: '1999-02-01' }));

      expect(res.statusCode).toBe(201);
      expect((await loanOf(res.json().loan_id)).loan_date).toBe('1999-01-01');
    });

    it('refuses a Loan Date or a Due Date that is no calendar date', async () => {
      const assetId = await registered();

      for (const dates of [
        { loan_date: '2026-02-30' },
        { loan_date: '05/11/2026' },
        { loan_date: '' },
        { due_date: '2026-13-01' },
        { due_date: 'soon' },
      ]) {
        await refusedAsValidation(base([assetId], dates), assetId);
      }
    });

    it('needs a Loan Date and a Due Date', async () => {
      const assetId = await registered();

      for (const field of ['loan_date', 'due_date']) {
        const payload: Record<string, unknown> = base([assetId]);
        delete payload[field];
        await refusedAsValidation(payload, assetId);
      }
    });

    it('takes a Due Date on or after the Loan Date, and in the past on a backdated Loan', async () => {
      const [early, sameDay, overdue] = [await registered(), await registered(), await registered()];

      await refusedAsValidation(base([early], { loan_date: TODAY, due_date: '2026-11-04' }), early);

      expect((await start(base([sameDay], { loan_date: TODAY, due_date: TODAY }))).statusCode).toBe(201);
      const backdated = await start(base([overdue], { loan_date: '2026-01-01', due_date: '2026-02-01' }));
      expect(backdated.statusCode).toBe(201);
      expect((await loanOf(backdated.json().loan_id)).items[0].due_date).toBe('2026-02-01');
    });

    it('gives every LoanItem the one Due Date', async () => {
      const assetIds = [await registered(), await registered(), await registered()];

      const res = await start(base(assetIds, { due_date: '2026-12-01' }));

      expect((await loanOf(res.json().loan_id)).items.map(({ due_date }: any) => due_date)).toEqual(Array(3).fill('2026-12-01'));
    });
  });

  describe('the Borrower and the Authorizer', () => {
    const refused = async (overrides: Record<string, unknown>) => {
      const assetId = await registered();
      const res = await start(base([assetId], overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await loansOf(assetId)).toEqual([]);
      return res;
    };

    const deactivated = async (name: string): Promise<Entry> => {
      const created = await person(name);
      const res = await api.post(admin, `/references/persons/${created.id}`, { expected_version: 1, is_active: false });
      expect(res.statusCode).toBe(200);
      return created;
    };

    it('takes an Internal Borrower only from the Person Reference List', async () => {
      const known = await person();

      await refused({ borrower: { kind: 'INTERNAL', person_id: 'นายสมชาย ใจดี' } });
      await refused({ borrower: { kind: 'INTERNAL', person_id: crypto.randomUUID() } });
      await refused({ borrower: { kind: 'INTERNAL' } });
      await refused({ borrower: { kind: 'INTERNAL', contact_name: 'นายสมชาย ใจดี' } });
      await refused({ borrower: { kind: 'INTERNAL', person_id: known.id, contact_name: 'นายสมชาย ใจดี' } });
    });

    it('needs an External Borrower\'s contact name, and accepts no other personal field', async () => {
      await refused({ borrower: { kind: 'EXTERNAL' } });
      await refused({ borrower: { kind: 'EXTERNAL', contact_name: '   ' } });
      await refused({ borrower: { kind: 'EXTERNAL', contact_name: 'คุณก', national_id: '1234567890123' } });
      await refused({ borrower: { kind: 'EXTERNAL', contact_name: 'คุณก', address: '1 ถนนสุขุมวิท' } });
      await refused({ borrower: { kind: 'OTHER', contact_name: 'คุณก' } });
    });

    it('takes a deactivated Person as Borrower or Authorizer only when the Loan Date is before today', async () => {
      const closedBorrower = await deactivated('สมชาย ปิดใช้งาน');
      const closedAuthorizer = await deactivated('สมศรี ปิดใช้งาน');

      await refused({ borrower: internalBorrower(closedBorrower), loan_date: TODAY });
      await refused({ borrower: internalBorrower(await person()), authorizer_person_id: closedAuthorizer.id, loan_date: TODAY });

      const backdated = await start(
        base([await registered()], { borrower: internalBorrower(closedBorrower), authorizer_person_id: closedAuthorizer.id, loan_date: '2026-11-04' })
      );
      expect(backdated.statusCode).toBe(201);
      const loan = await loanOf(backdated.json().loan_id);
      expect(loan.borrower.person.is_active).toBe(false);
      expect(loan.authorizer.is_active).toBe(false);
    });

    it('takes an Authorizer only from the Person Reference List, and needs none', async () => {
      await refused({ authorizer_person_id: 'นายใหญ่' });
      await refused({ authorizer_person_id: crypto.randomUUID() });

      for (const authorizer of [{}, { authorizer_person_id: null }]) {
        const res = await start(base([await registered()], authorizer));
        expect(res.statusCode).toBe(201);
        expect((await loanOf(res.json().loan_id)).authorizer).toBeNull();
      }
    });
  });

  describe('details', () => {
    const refused = async (overrides: Record<string, unknown>, assetIds?: string[]) => {
      const ids = assetIds ?? [await registered()];
      const res = await start(base(ids, overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await loansOf(ids[0])).toEqual([]);
      return res;
    };

    const external = (fields: Record<string, unknown>) => ({ borrower: { kind: 'EXTERNAL', contact_name: 'คุณก', ...fields } });

    it('needs each item\'s Condition to be ปกติ or ชำรุด', async () => {
      const assetId = await registered();

      await refused({ assets: [{ asset_id: assetId }] }, [assetId]);
      await refused({ assets: [{ asset_id: assetId, condition: 'BROKEN' }] }, [assetId]);
      await refused({ assets: [{ asset_id: assetId, condition: 'ปกติ' }] }, [assetId]);
    });

    it('bounds text', async () => {
      const assetId = await registered();

      await refused(external({ contact_name: over(200) }), [assetId]);
      await refused(external({ organization_name: over(200) }), [assetId]);
      await refused(external({ phone: '1'.repeat(33) }), [assetId]);
      await refused({ document_reference: over(500) }, [assetId]);
      await refused({ remark: over(2000) }, [assetId]);
      await refused({ assets: [{ asset_id: assetId, condition: 'NORMAL', condition_note: over(500) }] }, [assetId]);
    });

    it('takes text at its bounds', async () => {
      const at = (length: number) => 'ก'.repeat(length);

      const res = await start({
        ...base([], {
          assets: [{ asset_id: await registered(), condition: 'NORMAL', condition_note: at(500) }],
          ...external({ contact_name: at(200), organization_name: at(200), phone: '1'.repeat(32) }),
          document_reference: at(500),
          remark: at(2000),
        }),
      });

      expect(res.statusCode).toBe(201);
    });

    it('refuses every control character in a name or a phone number, even at its ends', async () => {
      const assetId = await registered();

      for (const text of ['ก\u0007ข', 'ก\nข', 'ก\tข', 'ก\r\nข', '\nก', 'ก\n']) {
        await refused(external({ contact_name: text }), [assetId]);
        await refused(external({ organization_name: text }), [assetId]);
      }
      await refused(external({ phone: '081-234-5678\n' }), [assetId]);
    });

    it('keeps line breaks and tabs inside a document reference, a remark and a Condition note, as an assignment does, and refuses any other control character inside them', async () => {
      const assetId = await registered();
      const bell = 'ก\u0007ข';

      await refused({ document_reference: bell }, [assetId]);
      await refused({ remark: bell }, [assetId]);
      await refused({ assets: [{ asset_id: assetId, condition: 'NORMAL', condition_note: bell }] }, [assetId]);

      const res = await start(
        base([], {
          assets: [{ asset_id: assetId, condition: 'NORMAL', condition_note: 'ก\r\nข' }],
          document_reference: 'ก\nข',
          remark: 'ก\tข',
        })
      );
      expect(res.statusCode).toBe(201);
      const loan = await loanOf(res.json().loan_id);
      expect(loan).toMatchObject({ document_reference: 'ก\nข', remark: 'ก\tข' });
      expect(loan.items[0].condition_note).toBe('ก\r\nข');
    });

    it('takes a phone number of digits, spaces, plus and hyphen only', async () => {
      const assetId = await registered();

      for (const phone of ['081-abc-5678', '081/2345678', '(081)2345678', '๐๘๑๒๓๔๕๖๗๘']) {
        await refused(external({ phone }), [assetId]);
      }

      const res = await start(base([await registered()], external({ phone: '  +66 81-234-5678  ' })));
      expect(res.statusCode).toBe(201);
      expect((await loanOf(res.json().loan_id, custodian)).borrower.phone).toBe('+66 81-234-5678');
    });

    it('stores blank optional text as none', async () => {
      const res = await start({
        ...base([], {
          assets: [{ asset_id: await registered(), condition: 'NORMAL', condition_note: '   ' }],
          ...external({ organization_name: '  ', phone: '  ' }),
          document_reference: ' ',
          remark: ' ',
        }),
      });

      expect(res.statusCode).toBe(201);
      const loan = await loanOf(res.json().loan_id, custodian);
      expect(loan.borrower).toEqual({ kind: 'EXTERNAL', contact_name: 'คุณก', organization_name: null, phone: null });
      expect(loan).toMatchObject({ document_reference: null, remark: null });
      expect(loan.items[0].condition_note).toBeNull();
    });

    it('answers a refusal by naming fields, never the Borrower\'s details', async () => {
      const res = await refused(external({ contact_name: 'คุณลับเฉพาะ', phone: '081-LEAK-99', organization_name: 'บริษัทลับ\u0007' }));

      expect(res.body).not.toContain('คุณลับเฉพาะ');
      expect(res.body).not.toContain('081-LEAK-99');
      expect(res.body).not.toContain('บริษัทลับ');
    });
  });

  describe('concurrency', () => {
    const isLocked = async (assetId: string): Promise<boolean> => {
      const client = await api.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE NOWAIT', [assetId]);
        return false;
      } catch (err: any) {
        expect(err.code).toBe('55P03');
        return true;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };

    it('ends concurrent starts for one Asset with exactly one Loan, and the others name it', async () => {
      const assetId = await registered();

      const results = await Promise.all(Array.from({ length: 8 }, () => start(base([assetId]))));

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, ...Array(7).fill(409)]);
      const winner = results.find((res) => res.statusCode === 201)!.json().loan_id;
      for (const refused of results.filter((res) => res.statusCode === 409)) {
        expect(refused.json().assets).toMatchObject([{ asset_id: assetId, reason: 'ON_LOAN', loan_id: winner }]);
      }
      expect(await loansOf(assetId)).toHaveLength(1);
    });

    it('locks its Assets in identifier order, however the request lists them', async () => {
      const [low, middle, high] = [await registered(), await registered(), await registered()].sort();

      const holder = await api.pool.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM assets WHERE id = $1 FOR UPDATE', [middle]);

      const write = start(base([high, middle, low]));

      // The start stops at the Asset held: the one before it is locked, the one after it is not.
      await expect.poll(() => isLocked(low), { timeout: 10_000, interval: 50 }).toBe(true);
      expect(await isLocked(high)).toBe(false);

      await holder.query('COMMIT');
      holder.release();
      expect((await write).statusCode).toBe(201);
    });

    it('serializes starts over the same Assets listed in opposite orders: one Loan, and the other refused', async () => {
      const assetIds = await Promise.all(Array.from({ length: 30 }, () => registered()));

      const results = await Promise.all([start(base(assetIds)), start(base([...assetIds].reverse()))]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
      expect(results.find((res) => res.statusCode === 409)!.json().assets).toHaveLength(30);
    }, 60_000);
  });

  describe('authorization', () => {
    it('refuses every role without loan:record, and saves nothing', async () => {
      const assetId = await registered();
      const maintainer = await api.actor('maintainer_loan', 'SYSTEM_MAINTAINER');

      for (const actor of [readonly, admin, maintainer]) {
        const res = await start(base([assetId]), crypto.randomUUID(), actor);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('needs loan:record itself: denying it alone refuses a Custodian and saves nothing', async () => {
      const assetId = await registered();

      const res = await withCapabilityAnswer(api.app, 'loan:record', async () => false, () => start(base([assetId])));

      expect(res.statusCode).toBe(403);
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('fails closed when the capability lookup fails, and saves nothing', async () => {
      const assetId = await registered();

      const res = await withCapabilityAnswer(api.app, 'loan:record', async () => { throw new Error('lookup failed'); }, () => start(base([assetId])));

      expect(res.statusCode).toBe(500);
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('needs a session and the CSRF token, and an inactive user is refused', async () => {
      const assetId = await registered();
      const send = (headers: Record<string, string>) =>
        api.app.inject({
          method: 'POST',
          url: '/loans',
          headers: { 'content-type': 'application/json', 'x-retry-token': crypto.randomUUID(), ...headers },
          payload: base([assetId]),
        });

      // The CSRF check answers first for a request with no session at all.
      expect([401, 403]).toContain((await send({})).statusCode);
      expect((await send({ cookie: custodian.cookie })).statusCode).toBe(403);

      const leaving = await api.actor('custodian_inactive_loan', 'ASSET_CUSTODIAN');
      await api.pool.query('UPDATE users SET is_active = false WHERE id = $1', [leaving.id]);
      expect([401, 403]).toContain((await start(base([assetId]), crypto.randomUUID(), leaving)).statusCode);

      expect(await loansOf(assetId)).toEqual([]);
    });

    it('lets every role with asset:view read Loans, and no one else', async () => {
      const assetId = await registered();
      const loanId = (await start(base([assetId]))).json().loan_id;
      const maintainer = await api.actor('maintainer_loan_reader', 'SYSTEM_MAINTAINER');

      for (const reader of [custodian, admin, readonly]) {
        expect((await api.get(reader, `/loans/${loanId}`)).statusCode).toBe(200);
        expect((await api.get(reader, `/assets/${assetId}/loans`)).statusCode).toBe(200);
      }
      expect((await api.get(maintainer, `/loans/${loanId}`)).statusCode).toBe(403);
      expect((await api.get(maintainer, `/assets/${assetId}/loans`)).statusCode).toBe(403);
    });

    it('needs asset:view itself to read: denying it alone, or failing to look it up, shows nothing', async () => {
      const assetId = await registered();
      const started = await start(base([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณไม่ควรเห็น' } }));
      const loanId = started.json().loan_id;

      for (const url of [`/loans/${loanId}`, `/assets/${assetId}/loans`]) {
        const denied = await withCapabilityAnswer(api.app, 'asset:view', async () => false, () => api.get(custodian, url));
        expect(denied.statusCode).toBe(403);
        expect(denied.body).not.toContain('คุณไม่ควรเห็น');

        const failed = await withCapabilityAnswer(api.app, 'asset:view', async () => { throw new Error('lookup failed'); }, () => api.get(custodian, url));
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain('คุณไม่ควรเห็น');
      }
    });

    it('shows a deep link nothing without a session', async () => {
      const assetId = await registered();
      const loanId = (await start(base([assetId]))).json().loan_id;

      for (const url of [`/loans/${loanId}`, `/assets/${assetId}/loans`, `/assets/${assetId}`]) {
        expect((await api.app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
    });

    it('answers a Loan that does not exist with 404, and a malformed id with 400', async () => {
      expect((await api.get(readonly, `/loans/${crypto.randomUUID()}`)).statusCode).toBe(404);
      expect((await api.get(readonly, '/loans/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('retry token', () => {
    const PHONE = '089-999-0000';
    const payloadFor = (assetIds: string[]) => base(assetIds, { borrower: { kind: 'EXTERNAL', contact_name: 'คุณส่งซ้ำ', phone: PHONE } });

    it('needs a token', async () => {
      const assetId = await registered();

      const res = await api.post(custodian, '/loans', base([assetId]));

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_FAILED');
      expect(await loansOf(assetId)).toEqual([]);
    });

    it('answers an identical replay with the committed result and writes nothing, even with the Assets listed in another order', async () => {
      const assetIds = [await registered(), await registered()];
      const token = crypto.randomUUID();
      const first = await start(payloadFor(assetIds), token);
      expect(first.statusCode).toBe(201);

      const replay = await start(payloadFor([...assetIds].reverse()), token);

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(await loansOf(assetIds[0])).toHaveLength(1);
    });

    it('refuses the same token with a changed payload, and writes nothing', async () => {
      const [assetId, other] = [await registered(), await registered()];
      const token = crypto.randomUUID();
      expect((await start(payloadFor([assetId]), token)).statusCode).toBe(201);

      const changed = await start(payloadFor([other]), token);

      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
      expect(await loansOf(other)).toEqual([]);
    });

    it('treats a change of the phone number as a changed payload', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();
      expect((await start(payloadFor([assetId]), token)).statusCode).toBe(201);

      const changed = await start(base([assetId], { borrower: { kind: 'EXTERNAL', contact_name: 'คุณส่งซ้ำ', phone: '089-999-0001' } }), token);

      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('RETRY_TOKEN_PAYLOAD_MISMATCH');
    });

    it('scopes a token to its actor', async () => {
      const otherCustodian = await api.actor('custodian_loan_two', 'ASSET_CUSTODIAN');
      const [first, second] = [await registered(), await registered()];
      const token = crypto.randomUUID();

      expect((await start(base([first]), token)).statusCode).toBe(201);
      expect((await start(base([second]), token, otherCustodian)).statusCode).toBe(201);
    });

    it('scopes a token to its operation', async () => {
      const token = crypto.randomUUID();
      const registration = await api.post(custodian, '/assets', { name: 'ของใต้โทเค็นเดียวกัน' }, { 'x-retry-token': token });
      expect(registration.statusCode).toBe(201);

      expect((await start(base([registration.json().asset.id]), token)).statusCode).toBe(201);
    });

    it('writes once for concurrent identical submissions, each answered with the committed result', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();

      const responses = await Promise.all(Array.from({ length: 8 }, () => start(payloadFor([assetId]), token)));

      expect(responses.map((res) => res.statusCode)).toEqual(Array(8).fill(201));
      expect(new Set(responses.map((res) => res.json().loan_id)).size).toBe(1);
      expect(await loansOf(assetId)).toHaveLength(1);
    });

    it('carries no phone number in the write response or its stored receipt', async () => {
      const token = crypto.randomUUID();

      const res = await start(payloadFor([await registered()]), token);

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(PHONE);
      const receipts = await api.pool.query(`SELECT response_body::text AS body FROM registration_retry_tokens WHERE token = $1 AND operation = 'loan:start'`, [token]);
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0].body).not.toContain(PHONE);
    });

    it('stores no receipt for a refusal, so the same token can carry the request once it can be saved', async () => {
      const assetId = await registered();
      const token = crypto.randomUUID();

      const refused = await start(base([assetId], { due_date: '2026-11-01' }), token);
      expect(refused.statusCode).toBe(400);

      expect((await start(base([assetId]), token)).statusCode).toBe(201);
    });
  });

  describe('a failure to persist', () => {
    // A Loan with no item is on no Asset, and T1 has no list of Loans to find it on.
    const loanCount = async (): Promise<number> => (await api.pool.query('SELECT count(*)::int AS n FROM loans')).rows[0].n;

    it('saves neither the Loan, nor its items, nor the receipt, and answers in the deterministic shape', async () => {
      const [first, second] = [await registered(), await registered()];
      const token = 'loan-fail-token';
      const loansBefore = await loanCount();
      await api.pool.query(`
        CREATE FUNCTION fail_loan_item() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected loan failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_loan_item BEFORE INSERT ON loan_items
          FOR EACH ROW EXECUTE FUNCTION fail_loan_item();
      `);
      try {
        const res = await start(base([first, second]), token);

        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('INTERNAL_SERVER_ERROR');
        expect(res.body).not.toContain('injected loan failure');
        expect(await loanCount()).toBe(loansBefore);
        expect(await loansOf(first)).toEqual([]);
        expect((await api.pool.query('SELECT count(*)::int AS n FROM registration_retry_tokens WHERE token = $1', [token])).rows[0].n).toBe(0);
      } finally {
        await api.pool.query('DROP TRIGGER fail_loan_item ON loan_items; DROP FUNCTION fail_loan_item();');
      }
      expect((await start(base([first, second]), token)).statusCode).toBe(201);
    });

    it('commits the Loan and its receipt together, or neither', async () => {
      const assetId = await registered();
      const token = 'loan-receipt-fail-token';
      const loansBefore = await loanCount();
      await api.pool.query(`
        CREATE FUNCTION fail_loan_receipt() RETURNS trigger AS $$
        BEGIN
          IF NEW.token = 'loan-receipt-fail-token' THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_loan_receipt BEFORE INSERT ON registration_retry_tokens
          FOR EACH ROW EXECUTE FUNCTION fail_loan_receipt();
      `);
      try {
        expect((await start(base([assetId]), token)).statusCode).toBe(500);
        expect(await loanCount()).toBe(loansBefore);
        expect(await loansOf(assetId)).toEqual([]);
      } finally {
        await api.pool.query('DROP TRIGGER fail_loan_receipt ON registration_retry_tokens; DROP FUNCTION fail_loan_receipt();');
      }
      expect((await start(base([assetId]), token)).statusCode).toBe(201);
    });
  });

  describe('the Permanent Assignment (LR-10, MR-15)', () => {
    const placed = async (location: Entry) => {
      const res = await api.post(custodian, '/assets', { name: 'ของมีที่อยู่', location_id: location.id, effective_date: '2024-01-01' });
      expect(res.statusCode).toBe(201);
      return res.json().asset.id as string;
    };

    it('stays exactly as it was: starting a Loan writes no assignment fact and moves no version', async () => {
      const [room] = await entries('locations', 'ห้องไม่เปลี่ยน', 1);
      const assetId = await placed(room);
      const before = await assignmentOf(assetId);

      expect((await start(base([assetId]))).statusCode).toBe(201);

      expect(await assignmentOf(assetId)).toEqual(before);
    });

    it('does not gate on it: an Asset with none, with Legacy text, or with an unresolved Assignment Conflict can be lent', async () => {
      const none = await registered();
      const legacy = (await api.post(custodian, '/assets', { name: 'ของข้อความเดิม', legacy_location_text: 'ห้องตามทะเบียนเก่า', effective_date: null })).json().asset.id;

      const [roomA, roomB, roomC] = await entries('locations', 'ห้องขัดแย้งยืม', 3);
      const contradicted = await placed(roomA);
      const reassign = (payload: Record<string, unknown>) =>
        detailOf(contradicted).then(({ assignment_version }) =>
          api.post(
            custodian,
            `/assets/${contradicted}/assignments`,
            { kind: 'REASSIGNMENT', expected_assignment_version: assignment_version, ...payload },
            { 'x-retry-token': crypto.randomUUID() }
          )
        );
      expect((await reassign({ effective_date: '2024-06-01', location_id: roomC.id })).statusCode).toBe(201);
      expect((await reassign({ effective_date: '2024-03-01', location_id: roomB.id, explicit_continuation: true })).statusCode).toBe(201);
      expect((await detailOf(contradicted)).has_assignment_conflict).toBe(true);

      const res = await start(base([none, legacy, contradicted]));

      expect(res.statusCode).toBe(201);
      expect(res.json().items).toHaveLength(3);
    });
  });

  describe('logs (LR-15)', () => {
    it('hold no Borrower details', async () => {
      const name = 'คุณไม่ลงบันทึก';
      const organization = 'บริษัทไม่ลงบันทึก';
      const phone = '061-777-8888';
      const borrower = { kind: 'EXTERNAL', contact_name: name, organization_name: organization, phone };
      const assetId = await registered();
      logLines.length = 0;

      expect((await start(base([assetId], { borrower }))).statusCode).toBe(201);
      expect((await start(base([assetId], { borrower }))).statusCode).toBe(409);
      expect((await start(base([await registered()], { borrower, due_date: '2020-01-01' }))).statusCode).toBe(400);
      await api.get(custodian, `/assets/${assetId}/loans`);

      expect(logLines.length).toBeGreaterThan(0);
      const logged = logLines.join('');
      expect(logged).not.toContain(name);
      expect(logged).not.toContain(organization);
      expect(logged).not.toContain(phone);
    });
  });
});
