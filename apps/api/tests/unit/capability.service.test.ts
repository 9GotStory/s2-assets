import { describe, it, expect, vi } from 'vitest';
import {
  CapabilityService,
  ROLE_CAPABILITY_MAP,
  KNOWN_CAPABILITIES,
  KNOWN_ROLES,
  isValidUuid,
  isKnownCapability,
} from '../../src/services/capability.service.ts';

describe('CapabilityService Unit Tests (T024 - US2)', () => {
  const validUserId = 'a0000000-0000-4000-8000-000000000001';
  const otherUserId = 'b0000000-0000-4000-8000-000000000002';

  describe('Static & Mapping Invariants', () => {
    it('defines immutable role capability mapping with Object.freeze', () => {
      expect(Object.isFrozen(ROLE_CAPABILITY_MAP)).toBe(true);
      expect(Object.isFrozen(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER)).toBe(true);
      expect(Object.isFrozen(ROLE_CAPABILITY_MAP.ADMINISTRATOR)).toBe(true);
      expect(Object.isFrozen(ROLE_CAPABILITY_MAP.READ_ONLY)).toBe(true);
      expect(Object.isFrozen(ROLE_CAPABILITY_MAP.ASSET_CUSTODIAN)).toBe(true);

      // Attempting mutation must fail in strict mode or have no effect
      expect(() => {
        // @ts-expect-error mutating frozen object
        ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER = ['system:all'];
      }).toThrow();
    });

    it('maps SYSTEM_MAINTAINER to system:maintain', () => {
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).toEqual(['system:maintain']);
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).not.toContain('acquisition:create');
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).not.toContain('acquisition:view');
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).not.toContain('evidence:view');
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).not.toContain('evidence:create');
      expect(ROLE_CAPABILITY_MAP.SYSTEM_MAINTAINER).not.toContain('evidence:correct');
    });

    it('maps ADMINISTRATOR to system:maintain, asset:view, asset:correct, asset:search, acquisition:view, evidence:view, evidence:correct, and reference:maintain without wildcards or registration capabilities', () => {
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).toEqual([
        'system:maintain',
        'asset:view',
        'asset:correct',
        'asset:search',
        'acquisition:view',
        'evidence:view',
        'evidence:correct',
        'reference:maintain',
      ]);
      // T4 (#25, D3): reference:maintain is granted to ADMINISTRATOR only.
      for (const role of ['SYSTEM_MAINTAINER', 'READ_ONLY', 'ASSET_CUSTODIAN']) {
        expect(ROLE_CAPABILITY_MAP[role]).not.toContain('reference:maintain');
      }
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).not.toContain('*');
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).not.toContain('asset:register');
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).not.toContain('asset:duplicate-check');
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).not.toContain('acquisition:create');
      expect(ROLE_CAPABILITY_MAP.ADMINISTRATOR).not.toContain('evidence:create');
    });

    it('maps READ_ONLY to asset:view, asset:search, acquisition:view, and evidence:view (no mutation or duplicate-check grants)', () => {
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).toEqual([
        'asset:view',
        'asset:search',
        'acquisition:view',
        'evidence:view',
      ]);
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).not.toContain('asset:correct');
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).not.toContain('asset:register');
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).not.toContain('acquisition:create');
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).not.toContain('evidence:create');
      expect(ROLE_CAPABILITY_MAP.READ_ONLY).not.toContain('evidence:correct');
    });

    it('maps ASSET_CUSTODIAN to asset:view, asset:duplicate-check, asset:register, asset:bulk-register, asset:correct, asset:search, acquisition:create, acquisition:view, evidence:view, evidence:create, and evidence:correct', () => {
      expect(ROLE_CAPABILITY_MAP.ASSET_CUSTODIAN).toEqual([
        'asset:view',
        'asset:duplicate-check',
        'asset:register',
        'asset:bulk-register',
        'asset:correct',
        'asset:search',
        'acquisition:create',
        'acquisition:view',
        'evidence:view',
        'evidence:create',
        'evidence:correct',
      ]);
    });

    it('validates UUIDs correctly with isValidUuid', () => {
      expect(isValidUuid(validUserId)).toBe(true);
      expect(isValidUuid('not-a-uuid')).toBe(false);
      expect(isValidUuid('')).toBe(false);
      expect(isValidUuid(null)).toBe(false);
      expect(isValidUuid(undefined)).toBe(false);
      expect(isValidUuid(12345)).toBe(false);
      expect(isValidUuid('12345678-1234-1234-1234-123456789012')).toBe(true);
    });

    it('validates known capabilities with isKnownCapability', () => {
      expect(isKnownCapability('system:maintain')).toBe(true);
      expect(isKnownCapability('asset:view')).toBe(true);
      expect(isKnownCapability('asset:duplicate-check')).toBe(true);
      expect(isKnownCapability('asset:register')).toBe(true);
      expect(isKnownCapability('asset:bulk-register')).toBe(true);
      expect(isKnownCapability('asset:correct')).toBe(true);
      expect(isKnownCapability('asset:search')).toBe(true);
      expect(isKnownCapability('acquisition:create')).toBe(true);
      expect(isKnownCapability('acquisition:view')).toBe(true);
      expect(isKnownCapability('evidence:view')).toBe(true);
      expect(isKnownCapability('evidence:create')).toBe(true);
      expect(isKnownCapability('evidence:correct')).toBe(true);
      expect(isKnownCapability('unknown:capability')).toBe(false);
      expect(isKnownCapability('*')).toBe(false);
      expect(isKnownCapability('')).toBe(false);
      expect(isKnownCapability(null)).toBe(false);
      expect(isKnownCapability(undefined)).toBe(false);
    });
  });

  describe('hasCapability Evaluation via pg mock interface', () => {
    it('Case 1: grants system:maintain for user with SYSTEM_MAINTAINER role', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT users.id AS user_id'),
        [validUserId]
      );
    });

    it('grants system:maintain for user with ADMINISTRATOR role', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'ADMINISTRATOR' }],
        }),
      };

      const service = new CapabilityService(mockDb);
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(true);
    });

    it('Case 2: denies user without role assignments', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: null }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
    });

    it('Case 3: denies user with READ_ONLY role', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'READ_ONLY' }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
    });

    it('Case 4: denies user with unknown role identifier', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'UNKNOWN_CUSTOM_ROLE' }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
    });

    it('Case 5: denies unknown capabilities even for SYSTEM_MAINTAINER', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'unknown:capability');

      expect(hasCap).toBe(false);
      // Fails fast before querying the database for invalid capability
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('Case 6: denies disabled user even if they possess SYSTEM_MAINTAINER', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: false, role_id: 'SYSTEM_MAINTAINER' }],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
      const roles = await service.getUserRoles(validUserId);
      expect(roles).toEqual([]);
      const caps = await service.getCapabilities(validUserId);
      expect(caps).toEqual([]);
    });

    it('Case 7: denies nonexistent user', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
      const roles = await service.getUserRoles(validUserId);
      expect(roles).toEqual([]);
    });

    it('Case 8: denies missing or malformed user IDs without querying database', async () => {
      const mockDb = {
        query: vi.fn(),
      };

      const service = new CapabilityService({ db: mockDb });

      expect(await service.hasCapability('', 'system:maintain')).toBe(false);
      // @ts-expect-error testing invalid type
      expect(await service.hasCapability(null, 'system:maintain')).toBe(false);
      // @ts-expect-error testing invalid type
      expect(await service.hasCapability(undefined, 'system:maintain')).toBe(false);
      expect(await service.hasCapability('not-a-uuid', 'system:maintain')).toBe(false);
      expect(await service.hasCapability('12345', 'system:maintain')).toBe(false);
      expect(await service.hasCapability("'; DROP TABLE users; --", 'system:maintain')).toBe(false);

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('Case 11: database query failure fails closed and never produces a grant', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('Connection lost')),
      };

      const service = new CapabilityService({ db: mockDb });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(false);
      const roles = await service.getUserRoles(validUserId);
      expect(roles).toEqual([]);
      const caps = await service.getCapabilities(validUserId);
      expect(caps).toEqual([]);
    });

    it('fails closed when database client is not configured', async () => {
      const service = new CapabilityService();
      expect(await service.hasCapability(validUserId, 'system:maintain')).toBe(false);
      expect(await service.getUserRoles(validUserId)).toEqual([]);
      expect(await service.getCapabilities(validUserId)).toEqual([]);
    });

    it('Case 12: evaluates multiple assigned roles correctly (union of capabilities)', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { user_id: validUserId, is_active: true, role_id: 'READ_ONLY' },
            { user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' },
          ],
        }),
      };

      const service = new CapabilityService({ db: mockDb });
      expect(await service.hasCapability(validUserId, 'system:maintain')).toBe(true);

      const roles = await service.getUserRoles(validUserId);
      expect(roles).toEqual(['READ_ONLY', 'SYSTEM_MAINTAINER']);

      const caps = await service.getCapabilities(validUserId);
      expect(caps.sort()).toEqual(
        ['asset:search', 'asset:view', 'system:maintain', 'acquisition:view', 'evidence:view'].sort()
      );
    });

    it('Case 13: externally injected database clients remain externally owned', async () => {
      const endSpy = vi.fn();
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' }],
        }),
        end: endSpy,
      };

      const service = new CapabilityService({ db: mockDb });
      await service.hasCapability(validUserId, 'system:maintain');

      expect(endSpy).not.toHaveBeenCalled();
    });

    it('Case 14: no capability state is cached in service instances', async () => {
      let callCount = 0;
      const mockDb = {
        query: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First call: has SYSTEM_MAINTAINER
            return Promise.resolve({
              rows: [{ user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' }],
            });
          } else {
            // Second call: role revoked in DB
            return Promise.resolve({
              rows: [{ user_id: validUserId, is_active: true, role_id: null }],
            });
          }
        }),
      };

      const service = new CapabilityService({ db: mockDb });

      // First evaluation: granted
      expect(await service.hasCapability(validUserId, 'system:maintain')).toBe(true);

      // Second evaluation: immediately reflects DB mutation without restarting service
      expect(await service.hasCapability(validUserId, 'system:maintain')).toBe(false);

      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('hasCapability Evaluation via Kysely mock interface', () => {
    it('executes query builder correctly using Kysely interface', async () => {
      const mockExecute = vi.fn().mockResolvedValue([
        { user_id: validUserId, is_active: true, role_id: 'SYSTEM_MAINTAINER' },
      ]);
      const mockWhere = vi.fn().mockReturnValue({ execute: mockExecute });
      const mockSelect = vi.fn().mockReturnValue({ where: mockWhere });
      const mockLeftJoin2 = vi.fn().mockReturnValue({ select: mockSelect });
      const mockLeftJoin1 = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin2 });
      const mockSelectFrom = vi.fn().mockReturnValue({ leftJoin: mockLeftJoin1 });

      const mockKysely = {
        selectFrom: mockSelectFrom,
      };

      const service = new CapabilityService({ db: mockKysely });
      const hasCap = await service.hasCapability(validUserId, 'system:maintain');

      expect(hasCap).toBe(true);
      expect(mockSelectFrom).toHaveBeenCalledWith('users');
      expect(mockLeftJoin1).toHaveBeenCalledWith(
        'user_roles',
        'users.id',
        'user_roles.user_id'
      );
      expect(mockLeftJoin2).toHaveBeenCalledWith(
        'roles',
        'user_roles.role_id',
        'roles.id'
      );
      expect(mockSelect).toHaveBeenCalledWith([
        'users.id as user_id',
        'users.is_active as is_active',
        'roles.id as role_id',
      ]);
      expect(mockWhere).toHaveBeenCalledWith('users.id', '=', validUserId);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('fails closed when Kysely execute throws an error', async () => {
      const mockKysely = {
        selectFrom: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  execute: vi.fn().mockRejectedValue(new Error('Kysely DB failure')),
                }),
              }),
            }),
          }),
        }),
      };

      const service = new CapabilityService({ db: mockKysely });
      expect(await service.hasCapability(validUserId, 'system:maintain')).toBe(false);
      expect(await service.getUserRoles(validUserId)).toEqual([]);
    });
  });
});
