import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createRequire } from 'node:module';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';
import { CapabilityService } from '../../src/services/capability.service.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

const dbRequire = createRequire(migrationFolder);
const { Kysely, PostgresDialect } = dbRequire('kysely');

describe('CapabilityService Real PostgreSQL Integration Tests (T024 - US2)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pool: pg.Pool;
  let kyselyDb: any;

  beforeAll(async () => {
    if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    }
    if (!process.env.DOCKER_HOST) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
      const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
      if (fs.existsSync(podmanSocket)) {
        process.env.DOCKER_HOST = `unix://${podmanSocket}`;
      }
    }

    container = await new PostgreSqlContainer('postgres:18.6-alpine').start();
    databaseUrl = container.getConnectionUri();

    // Run baseline migrations
    const migResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(migResult.error).toBeUndefined();

    pool = new Pool({ connectionString: databaseUrl });
    kyselyDb = new Kysely({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: databaseUrl }),
      }),
    });
  }, 90_000);

  afterAll(async () => {
    if (kyselyDb) {
      await kyselyDb.destroy().catch(() => {});
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (container) {
      await container.stop().catch(() => {});
    }
  }, 30_000);

  beforeEach(async () => {
    // Truncate tables and seed canonical roles
    await pool.query('TRUNCATE TABLE user_roles, sessions, users, roles CASCADE;');
    await pool.query(`
      INSERT INTO roles (id, description) VALUES
        ('SYSTEM_MAINTAINER', 'System maintainer with maintenance capabilities'),
        ('ADMINISTRATOR', 'Administrator with full system privileges'),
        ('ASSET_CUSTODIAN', 'Asset Custodian with registry capabilities'),
        ('READ_ONLY', 'Read-only observer role'),
        ('CUSTOM_UNMAPPED', 'Role with no code-defined capabilities')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  async function createTestUser(params?: {
    username?: string;
    isActive?: boolean;
    roles?: string[];
  }): Promise<{ id: string; username: string; isActive: boolean }> {
    const id = crypto.randomUUID();
    const username = params?.username || `user_${crypto.randomUUID().slice(0, 8)}`;
    const isActive = params?.isActive ?? true;

    await pool.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, username, '$argon2id$v=19$m=65536,t=3,p=4$dummy$dummy', isActive]
    );

    if (params?.roles && params.roles.length > 0) {
      for (const role of params.roles) {
        await pool.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, role]
        );
      }
    }

    return { id, username, isActive };
  }

  describe('Authoritative Real PostgreSQL Capability Resolution', () => {
    it('Case 1: SYSTEM_MAINTAINER grants system:maintain against committed PostgreSQL state', async () => {
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(true);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual(['SYSTEM_MAINTAINER']);

      const caps = await service.getCapabilities(user.id);
      expect(caps).toEqual(['system:maintain']);
    });

    it('ADMINISTRATOR grants system:maintain against committed PostgreSQL state', async () => {
      const user = await createTestUser({ roles: ['ADMINISTRATOR'] });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(true);
    });

    it('Case 2: user without role assignments is denied', async () => {
      const user = await createTestUser({ roles: [] });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(false);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual([]);
    });

    it('Case 3: READ_ONLY role does not grant system:maintain', async () => {
      const user = await createTestUser({ roles: ['READ_ONLY'] });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(false);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual(['READ_ONLY']);

      const caps = await service.getCapabilities(user.id);
      expect(caps.sort()).toEqual(['acquisition:view', 'asset:search', 'asset:view'].sort());
    });

    it('grants asset:search for user with READ_ONLY, ADMINISTRATOR, and ASSET_CUSTODIAN roles', async () => {
      // READ_ONLY
      const readOnlyUser = await createTestUser({ roles: ['READ_ONLY'] });
      const service = new CapabilityService({ db: pool });
      expect(await service.hasCapability(readOnlyUser.id, 'asset:search')).toBe(true);

      // ADMINISTRATOR
      const adminUser = await createTestUser({ roles: ['ADMINISTRATOR'] });
      expect(await service.hasCapability(adminUser.id, 'asset:search')).toBe(true);

      // ASSET_CUSTODIAN
      await pool.query(
        `INSERT INTO roles (id, description) VALUES ('ASSET_CUSTODIAN', 'Asset custodian role') ON CONFLICT (id) DO NOTHING`
      );
      const custodianUser = await createTestUser({ roles: ['ASSET_CUSTODIAN'] });
      expect(await service.hasCapability(custodianUser.id, 'asset:search')).toBe(true);

      // SYSTEM_MAINTAINER must NOT have asset:search
      const maintainerUser = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      expect(await service.hasCapability(maintainerUser.id, 'asset:search')).toBe(false);
    });

    it('Case 4: unknown role identifiers in PostgreSQL do not grant system:maintain', async () => {
      const user = await createTestUser({ roles: ['CUSTOM_UNMAPPED'] });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(false);

      const caps = await service.getCapabilities(user.id);
      expect(caps).toEqual([]);
    });

    it('Case 5: unknown capability requested is denied even for SYSTEM_MAINTAINER', async () => {
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(user.id, 'unknown:capability')).toBe(false);
      expect(await service.hasCapability(user.id, 'admin:*')).toBe(false);
      expect(await service.hasCapability(user.id, '*')).toBe(false);
    });

    it('Case 6: disabled users in PostgreSQL are denied even with SYSTEM_MAINTAINER role', async () => {
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'], isActive: false });
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(false);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual([]);

      const caps = await service.getCapabilities(user.id);
      expect(caps).toEqual([]);
    });

    it('Case 7: nonexistent users are denied', async () => {
      const nonExistentId = crypto.randomUUID();
      const service = new CapabilityService({ db: pool });

      const hasCap = await service.hasCapability(nonExistentId, 'system:maintain');
      expect(hasCap).toBe(false);

      const roles = await service.getUserRoles(nonExistentId);
      expect(roles).toEqual([]);
    });

    it('Case 8: missing or malformed user IDs are denied', async () => {
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability('', 'system:maintain')).toBe(false);
      // @ts-expect-error testing invalid type
      expect(await service.hasCapability(null, 'system:maintain')).toBe(false);
      expect(await service.hasCapability('not-a-valid-uuid', 'system:maintain')).toBe(false);
      expect(await service.getUserRoles('not-a-valid-uuid')).toEqual([]);
    });

    it('Case 12: multiple assigned roles in PostgreSQL evaluated correctly', async () => {
      const user = await createTestUser({ roles: ['READ_ONLY', 'SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(user.id, 'system:maintain')).toBe(true);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toContain('READ_ONLY');
      expect(roles).toContain('SYSTEM_MAINTAINER');
      expect(roles).toHaveLength(2);
    });
  });

  describe('Dynamic Role Grant and Immediate Revocation Invariants (FR-002, Cases 9, 10, 14)', () => {
    it('Case 9: newly assigned role becomes effective immediately on next evaluation without restart', async () => {
      // 1. User starts with no roles
      const user = await createTestUser({ roles: [] });
      const service = new CapabilityService({ db: pool });

      // Initial check: false
      const initial = await service.hasCapability(user.id, 'system:maintain');
      expect(initial).toBe(false);

      // 2. Grant SYSTEM_MAINTAINER directly in PostgreSQL
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
        [user.id, 'SYSTEM_MAINTAINER']
      );

      // 3. Next evaluation on the EXACT same service instance must be true immediately
      const subsequent = await service.hasCapability(user.id, 'system:maintain');
      expect(subsequent).toBe(true);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual(['SYSTEM_MAINTAINER']);
    });

    it('Case 10: removed role becomes ineffective immediately on next evaluation without restart', async () => {
      // 1. User starts with SYSTEM_MAINTAINER
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: pool });

      // Initial check: true
      const initial = await service.hasCapability(user.id, 'system:maintain');
      expect(initial).toBe(true);

      // 2. Revoke role directly in PostgreSQL
      await pool.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [user.id, 'SYSTEM_MAINTAINER']
      );

      // 3. Next evaluation on the EXACT same service instance must be false immediately
      const subsequent = await service.hasCapability(user.id, 'system:maintain');
      expect(subsequent).toBe(false);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual([]);
    });

    it('dynamically denies user immediately when user is deactivated in PostgreSQL', async () => {
      // 1. Active user with SYSTEM_MAINTAINER
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(user.id, 'system:maintain')).toBe(true);

      // 2. Deactivate user in PostgreSQL
      await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [user.id]);

      // 3. Next evaluation on EXACT same service instance must be false
      expect(await service.hasCapability(user.id, 'system:maintain')).toBe(false);
      expect(await service.getUserRoles(user.id)).toEqual([]);
    });
  });

  describe('Database Client Invariants & Kysely Integration (Cases 11, 13)', () => {
    it('works seamlessly with Kysely query builder instance against real PostgreSQL', async () => {
      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: kyselyDb });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(true);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual(['SYSTEM_MAINTAINER']);
    });

    it('Case 13: externally injected database clients remain externally owned and usable', async () => {
      const dedicatedPool = new Pool({ connectionString: databaseUrl });
      try {
        const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
        const service = new CapabilityService({ db: dedicatedPool });

        await service.hasCapability(user.id, 'system:maintain');

        // External pool must remain open and usable by caller
        const check = await dedicatedPool.query('SELECT 1 as num');
        expect(check.rows[0].num).toBe(1);
      } finally {
        await dedicatedPool.end().catch(() => {});
      }
    });

    it('Case 11: database query failure fails closed and never produces an authorization grant', async () => {
      // Closed pool simulates database failure / network partition
      const deadPool = new Pool({ connectionString: databaseUrl });
      await deadPool.end();

      const user = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });
      const service = new CapabilityService({ db: deadPool });

      const hasCap = await service.hasCapability(user.id, 'system:maintain');
      expect(hasCap).toBe(false);

      const roles = await service.getUserRoles(user.id);
      expect(roles).toEqual([]);
    });
  });

  describe('T2 P1: asset:correct Capability Matrix', () => {
    it('grants asset:correct to ADMINISTRATOR and ASSET_CUSTODIAN, denies READ_ONLY and SYSTEM_MAINTAINER', async () => {
      const admin = await createTestUser({ roles: ['ADMINISTRATOR'] });
      const custodian = await createTestUser({ roles: ['ASSET_CUSTODIAN'] });
      const readOnly = await createTestUser({ roles: ['READ_ONLY'] });
      const maintainer = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });

      const service = new CapabilityService({ db: pool });

      // ADMINISTRATOR
      expect(await service.hasCapability(admin.id, 'asset:correct')).toBe(true);
      expect(await service.hasCapability(admin.id, 'asset:view')).toBe(true);
      expect(await service.hasCapability(admin.id, 'asset:register')).toBe(false);
      expect(await service.hasCapability(admin.id, 'asset:duplicate-check')).toBe(false);

      // ASSET_CUSTODIAN
      expect(await service.hasCapability(custodian.id, 'asset:correct')).toBe(true);
      expect(await service.hasCapability(custodian.id, 'asset:view')).toBe(true);
      expect(await service.hasCapability(custodian.id, 'asset:register')).toBe(true);
      expect(await service.hasCapability(custodian.id, 'asset:duplicate-check')).toBe(true);

      // READ_ONLY
      expect(await service.hasCapability(readOnly.id, 'asset:correct')).toBe(false);
      expect(await service.hasCapability(readOnly.id, 'asset:view')).toBe(true);

      // SYSTEM_MAINTAINER
      expect(await service.hasCapability(maintainer.id, 'asset:correct')).toBe(false);
      expect(await service.hasCapability(maintainer.id, 'system:maintain')).toBe(true);
    });

    it('denies asset:correct fail-closed if administrator user is deactivated or role revoked', async () => {
      const admin = await createTestUser({ roles: ['ADMINISTRATOR'] });
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(admin.id, 'asset:correct')).toBe(true);

      // Revoke role
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [admin.id]);
      expect(await service.hasCapability(admin.id, 'asset:correct')).toBe(false);

      // Reassign role but deactivate
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ADMINISTRATOR')",
        [admin.id]
      );
      await pool.query('UPDATE users SET is_active = false WHERE id = $1', [admin.id]);
      expect(await service.hasCapability(admin.id, 'asset:correct')).toBe(false);
    });
  });

  describe('T5 D3: acquisition:create and acquisition:view Capability Matrix', () => {
    it('enforces exact D3 capability grants per role', async () => {
      const custodian = await createTestUser({ roles: ['ASSET_CUSTODIAN'] });
      const admin = await createTestUser({ roles: ['ADMINISTRATOR'] });
      const readOnly = await createTestUser({ roles: ['READ_ONLY'] });
      const maintainer = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });

      const service = new CapabilityService({ db: pool });

      // ASSET_CUSTODIAN: acquisition:create = true, acquisition:view = true
      expect(await service.hasCapability(custodian.id, 'acquisition:create')).toBe(true);
      expect(await service.hasCapability(custodian.id, 'acquisition:view')).toBe(true);

      // ADMINISTRATOR: acquisition:create = false, acquisition:view = true
      expect(await service.hasCapability(admin.id, 'acquisition:create')).toBe(false);
      expect(await service.hasCapability(admin.id, 'acquisition:view')).toBe(true);

      // READ_ONLY: acquisition:create = false, acquisition:view = true
      expect(await service.hasCapability(readOnly.id, 'acquisition:create')).toBe(false);
      expect(await service.hasCapability(readOnly.id, 'acquisition:view')).toBe(true);

      // SYSTEM_MAINTAINER: acquisition:create = false, acquisition:view = false
      expect(await service.hasCapability(maintainer.id, 'acquisition:create')).toBe(false);
      expect(await service.hasCapability(maintainer.id, 'acquisition:view')).toBe(false);
    });
  });

  describe('T6 D3: asset:bulk-register Capability Matrix', () => {
    it('grants asset:bulk-register ONLY to ASSET_CUSTODIAN, denies ADMINISTRATOR, READ_ONLY, and SYSTEM_MAINTAINER', async () => {
      const custodian = await createTestUser({ roles: ['ASSET_CUSTODIAN'] });
      const admin = await createTestUser({ roles: ['ADMINISTRATOR'] });
      const readOnly = await createTestUser({ roles: ['READ_ONLY'] });
      const maintainer = await createTestUser({ roles: ['SYSTEM_MAINTAINER'] });

      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(custodian.id, 'asset:bulk-register')).toBe(true);
      expect(await service.hasCapability(admin.id, 'asset:bulk-register')).toBe(false);
      expect(await service.hasCapability(readOnly.id, 'asset:bulk-register')).toBe(false);
      expect(await service.hasCapability(maintainer.id, 'asset:bulk-register')).toBe(false);
    });

    it('denies asset:bulk-register fail-closed when custodian is deactivated or role revoked', async () => {
      const custodian = await createTestUser({ roles: ['ASSET_CUSTODIAN'] });
      const service = new CapabilityService({ db: pool });

      expect(await service.hasCapability(custodian.id, 'asset:bulk-register')).toBe(true);

      // Revoke role
      await pool.query('DELETE FROM user_roles WHERE user_id = $1', [custodian.id]);
      expect(await service.hasCapability(custodian.id, 'asset:bulk-register')).toBe(false);

      // Restore role but deactivate user
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'ASSET_CUSTODIAN')",
        [custodian.id]
      );
      await pool.query('UPDATE users SET is_active = false WHERE id = $1', [custodian.id]);
      expect(await service.hasCapability(custodian.id, 'asset:bulk-register')).toBe(false);
    });
  });
});
