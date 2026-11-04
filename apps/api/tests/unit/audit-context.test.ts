import { describe, it, expect } from 'vitest';
import type { AuditContext } from '../../src/types/audit-context.ts';

describe('AuditContext Type Contract (T029 - US3)', () => {
  it('instantiates valid AuditContext with all required fields', () => {
    const now = new Date();
    const context: AuditContext = {
      actor: 'a0000000-0000-4000-8000-000000000001',
      action: 'asset:create',
      recorded_at: now,
    };

    expect(context.actor).toBe('a0000000-0000-4000-8000-000000000001');
    expect(context.action).toBe('asset:create');
    expect(context.recorded_at).toBe(now);
    expect(context.recorded_at).toBeInstanceOf(Date);
  });

  it('passes explicitly to downstream business functions', () => {
    function recordBusinessEvent(ctx: AuditContext, payload: { detail: string }) {
      return {
        actorId: ctx.actor,
        actionType: ctx.action,
        timestamp: ctx.recorded_at,
        payload,
      };
    }

    const eventDate = new Date('2026-10-14T20:00:00.000Z');
    const audit: AuditContext = {
      actor: 'b1111111-1111-4111-8111-111111111111',
      action: 'material:transfer',
      recorded_at: eventDate,
    };

    const result = recordBusinessEvent(audit, { detail: 'transfer-sample' });
    expect(result.actorId).toBe('b1111111-1111-4111-8111-111111111111');
    expect(result.actionType).toBe('material:transfer');
    expect(result.timestamp).toBe(eventDate);
    expect(result.payload.detail).toBe('transfer-sample');
  });

  it('enforces compile-time type constraints on all fields', () => {
    // Valid instance
    const valid: AuditContext = {
      actor: 'actor-uuid',
      action: 'action-id',
      recorded_at: new Date(),
    };
    expect(valid).toBeDefined();

    // Compile-time negative checks:

    // @ts-expect-error missing actor
    const missingActor: AuditContext = {
      action: 'action-id',
      recorded_at: new Date(),
    };
    expect(missingActor).toBeDefined();

    // @ts-expect-error missing action
    const missingAction: AuditContext = {
      actor: 'actor-uuid',
      recorded_at: new Date(),
    };
    expect(missingAction).toBeDefined();

    // @ts-expect-error missing recorded_at
    const missingRecordedAt: AuditContext = {
      actor: 'actor-uuid',
      action: 'action-id',
    };
    expect(missingRecordedAt).toBeDefined();

    const stringRecordedAt: AuditContext = {
      actor: 'actor-uuid',
      action: 'action-id',
      // @ts-expect-error recorded_at must be Date, not string
      recorded_at: '2026-10-14T20:00:00.000Z',
    };
    expect(stringRecordedAt).toBeDefined();

    const numberRecordedAt: AuditContext = {
      actor: 'actor-uuid',
      action: 'action-id',
      // @ts-expect-error recorded_at must be Date, not unix timestamp number
      recorded_at: Date.now(),
    };
    expect(numberRecordedAt).toBeDefined();

    const numberActor: AuditContext = {
      // @ts-expect-error actor must be string, not number
      actor: 12345,
      action: 'action-id',
      recorded_at: new Date(),
    };
    expect(numberActor).toBeDefined();

    const booleanAction: AuditContext = {
      actor: 'actor-uuid',
      // @ts-expect-error action must be string, not boolean
      action: true,
      recorded_at: new Date(),
    };
    expect(booleanAction).toBeDefined();
  });
});
