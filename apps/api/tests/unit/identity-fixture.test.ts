import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateTargetDatabase,
  setupTestIdentities,
  cleanupTestIdentities,
  loadEnvFile,
  type TestIdentityState,
} from '../fixtures/identity.ts';
import { UserService, isArgon2idHash } from '../../src/services/user.service.ts';
import { CapabilityService } from '../../src/services/capability.service.ts';

describe('Identity Fixture Unit Tests (T044 - US4)', () => {
  const validDbUrl = 'postgresql://test_user:super_secret_pw@127.0.0.1:5432/s2_foundation_test_db';
  const expectedDbName = 's2_foundation_test_db';
  const testRunId = 'test_run_001';
  const testBaseUsername = 'testuser_t044';
  const testPassword = 'Secure_Test_Password_123';

  let tempDir: string;
  let tempStateFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-test-'));
    await fs.chmod(tempDir, 0o700);
    tempStateFile = path.join(tempDir, `fixture-state-${testRunId}.json`);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  // In-memory mock database store simulating real PostgreSQL tables
  function createMockDb() {
    const users: Array<{
      id: string;
      username: string;
      password_hash: string;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }> = [];
    const roles: Array<{ id: string; description: string }> = [];
    const userRoles: Array<{ user_id: string; role_id: string }> = [];
    const sessions: Array<{ id: string; user_id: string; expires_at: Date; created_at: Date }> = [];

    const query = vi.fn(async (sql: string, params: any[] = []) => {
      const trimmed = sql.trim();

      // 1. SELECT id, username FROM users WHERE username = $1 OR username = $2
      if (trimmed.startsWith('SELECT id, username FROM users WHERE username = $1 OR username = $2')) {
        const matched = users.filter((u) => u.username === params[0] || u.username === params[1]);
        return { rows: matched, rowCount: matched.length };
      }

      // 2. SELECT id FROM roles WHERE id = $1
      if (trimmed.startsWith('SELECT id FROM roles WHERE id = $1')) {
        const matched = roles.filter((r) => r.id === params[0]);
        return { rows: matched, rowCount: matched.length };
      }

      // 3. INSERT INTO roles (id, description) VALUES ($1, $2)
      if (trimmed.startsWith('INSERT INTO roles (id, description) VALUES ($1, $2)')) {
        roles.push({ id: params[0], description: params[1] });
        return { rows: [], rowCount: 1 };
      }

      // 4. INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
      if (trimmed.startsWith('INSERT INTO users')) {
        const row = {
          id: params[0],
          username: params[1],
          password_hash: params[2],
          is_active: params[3],
          created_at: new Date(),
          updated_at: new Date(),
        };
        users.push(row);
        return { rows: [row], rowCount: 1 };
      }

      // 5. INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
      if (trimmed.startsWith('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)')) {
        userRoles.push({ user_id: params[0], role_id: params[1] });
        return { rows: [], rowCount: 1 };
      }

      // 6. SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = $1
      if (trimmed.startsWith('SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = $1')) {
        const matched = users.filter((u) => u.username === params[0]);
        return { rows: matched, rowCount: matched.length };
      }

      // 7. Capability check query: SELECT users.id AS user_id, users.is_active AS is_active, roles.id AS role_id FROM users ...
      if (trimmed.includes('FROM users') && trimmed.includes('LEFT JOIN user_roles') && trimmed.includes('LEFT JOIN roles')) {
        const targetUserId = params[0];
        const user = users.find((u) => u.id === targetUserId);
        if (!user) return { rows: [], rowCount: 0 };
        const userGrants = userRoles.filter((ur) => ur.user_id === targetUserId);
        if (userGrants.length === 0) {
          return {
            rows: [{ user_id: user.id, is_active: user.is_active, role_id: null }],
            rowCount: 1,
          };
        }
        const rows = userGrants.map((g) => ({
          user_id: user.id,
          is_active: user.is_active,
          role_id: g.role_id,
        }));
        return { rows, rowCount: rows.length };
      }

      // 8. Cleanup queries
      if (trimmed.startsWith('DELETE FROM sessions WHERE id = ANY($1)')) {
        const ids: string[] = params[0] || [];
        const before = sessions.length;
        const filtered = sessions.filter((s) => !ids.includes(s.id));
        const removed = before - filtered.length;
        sessions.length = 0;
        sessions.push(...filtered);
        return { rows: [], rowCount: removed };
      }

      if (trimmed.startsWith('DELETE FROM sessions WHERE user_id = ANY($1)')) {
        const ids: string[] = params[0] || [];
        const before = sessions.length;
        const filtered = sessions.filter((s) => !ids.includes(s.user_id));
        const removed = before - filtered.length;
        sessions.length = 0;
        sessions.push(...filtered);
        return { rows: [], rowCount: removed };
      }

      if (trimmed.startsWith('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2')) {
        const before = userRoles.length;
        const filtered = userRoles.filter(
          (ur) => !(ur.user_id === params[0] && ur.role_id === params[1])
        );
        const removed = before - filtered.length;
        userRoles.length = 0;
        userRoles.push(...filtered);
        return { rows: [], rowCount: removed };
      }

      if (trimmed.startsWith('DELETE FROM users WHERE id = ANY($1)')) {
        const ids: string[] = params[0] || [];
        const before = users.length;
        const filtered = users.filter((u) => !ids.includes(u.id));
        const removed = before - filtered.length;
        users.length = 0;
        users.push(...filtered);
        return { rows: [], rowCount: removed };
      }

      if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1')) {
        const inUse = userRoles.some((ur) => ur.role_id === params[0]);
        return { rows: inUse ? [{ '?column?': 1 }] : [], rowCount: inUse ? 1 : 0 };
      }

      if (trimmed.startsWith('DELETE FROM roles WHERE id = $1')) {
        const before = roles.length;
        const filtered = roles.filter((r) => r.id !== params[0]);
        const removed = before - filtered.length;
        roles.length = 0;
        roles.push(...filtered);
        return { rows: [], rowCount: removed };
      }

      return { rows: [], rowCount: 0 };
    });

    return {
      query,
      users,
      roles,
      userRoles,
      sessions,
    };
  }

  describe('1. Target Database & URL Validation', () => {
    it('accepts valid database URL starting with s2_foundation_', () => {
      const { dbName } = validateTargetDatabase(validDbUrl);
      expect(dbName).toBe(expectedDbName);
    });

    it('accepts valid database URL matching expectedDb exactly', () => {
      const { dbName } = validateTargetDatabase(validDbUrl, expectedDbName);
      expect(dbName).toBe(expectedDbName);
    });

    it('rejects missing or empty database URL', () => {
      expect(() => validateTargetDatabase('')).toThrow(
        /Database URL is required and must be a non-empty string/
      );
      expect(() => validateTargetDatabase(undefined)).toThrow(
        /Database URL is required and must be a non-empty string/
      );
    });

    it('rejects malformed database URL', () => {
      expect(() => validateTargetDatabase('not-a-valid-url')).toThrow(
        /Invalid database URL format/
      );
    });

    it('rejects non-PostgreSQL protocols', () => {
      expect(() =>
        validateTargetDatabase('mysql://user:pw@127.0.0.1:3306/s2_foundation_test')
      ).toThrow(/Invalid database protocol: expected postgresql:/);
      expect(() =>
        validateTargetDatabase('http://user:pw@127.0.0.1:5432/s2_foundation_test')
      ).toThrow(/Invalid database protocol: expected postgresql:/);
    });

    it('rejects production database hostnames', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@db-prod.internal:5432/s2_foundation_test')
      ).toThrow(/Production database target is prohibited/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@my-production.aws.rds.com:5432/s2_foundation_test')
      ).toThrow(/Production database target is prohibited/);
    });

    it('rejects database names not starting with s2_foundation_', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/s2_assets')
      ).toThrow(/Database target must begin with "s2_foundation_"/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/my_unmarked_db')
      ).toThrow(/Database target must begin with "s2_foundation_"/);
    });

    it('rejects default or shared database names', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/s2_foundation_s2_assets')
      ).toThrow(/Database target cannot be default or shared database/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/postgres')
      ).toThrow(/Database target must begin with "s2_foundation_"/);
    });

    it('rejects mismatched database when expectedDb does not match URL target', () => {
      expect(() =>
        validateTargetDatabase(validDbUrl, 's2_foundation_other_run')
      ).toThrow(/Database target mismatch/);
    });

    it('never leaks connection secrets or passwords in error messages', () => {
      const secretPassword = 'SUPER_SENSITIVE_DB_PASSWORD_XYZ';
      const secretUrl = `postgresql://my_user:${secretPassword}@127.0.0.1:5432/invalid_name`;

      try {
        validateTargetDatabase(secretUrl);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).not.toContain(secretPassword);
        expect(err.message).toContain('Database target must begin with "s2_foundation_"');
      }
    });
  });

  describe('2. Environment & Parameter Validation', () => {
    it('rejects NODE_ENV !== test', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'production',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/Fixture operations are strictly restricted to NODE_ENV=test/);

      await expect(
        setupTestIdentities({
          nodeEnv: 'development',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/Fixture operations are strictly restricted to NODE_ENV=test/);
    });

    it('rejects missing or invalid FOUNDATION_TEST_RUN_ID', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: '',
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_RUN_ID is required/);

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: 'invalid run with spaces',
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_RUN_ID is required/);
    });

    it('rejects missing or invalid FOUNDATION_TEST_USERNAME', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: '',
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_USERNAME is required/);
    });

    it('rejects short or trivial passwords', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: 'short',
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/at least 8 non-whitespace characters/);

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: 'password',
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/cannot use default or trivial passwords/);
    });

    it('rejects missing stateFile', async () => {
      const origEnvFile = process.env.FOUNDATION_ENV_FILE;
      delete process.env.FOUNDATION_ENV_FILE;
      delete process.env.FOUNDATION_FIXTURE_STATE_FILE;

      try {
        await expect(
          setupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            runId: testRunId,
            baseUsername: testBaseUsername,
            password: testPassword,
            stateFile: undefined,
          })
        ).rejects.toThrow(/FOUNDATION_FIXTURE_STATE_FILE is required/);
      } finally {
        if (origEnvFile) process.env.FOUNDATION_ENV_FILE = origEnvFile;
      }
    });
  });

  describe('3. Fixture Setup & Authentication Invariants', () => {
    // In-memory mock database store simulating real PostgreSQL tables
    function createMockDb() {
      const users: Array<{
        id: string;
        username: string;
        password_hash: string;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
      }> = [];
      const roles: Array<{ id: string; description: string }> = [];
      const userRoles: Array<{ user_id: string; role_id: string }> = [];
      const sessions: Array<{ id: string; user_id: string; expires_at: Date; created_at: Date }> = [];

      const query = vi.fn(async (sql: string, params: any[] = []) => {
        const trimmed = sql.trim();

        // 1. SELECT id, username FROM users WHERE username = $1 OR username = $2
        if (trimmed.startsWith('SELECT id, username FROM users WHERE username = $1 OR username = $2')) {
          const matched = users.filter((u) => u.username === params[0] || u.username === params[1]);
          return { rows: matched, rowCount: matched.length };
        }

        // 2. SELECT id FROM roles WHERE id = $1
        if (trimmed.startsWith('SELECT id FROM roles WHERE id = $1')) {
          const matched = roles.filter((r) => r.id === params[0]);
          return { rows: matched, rowCount: matched.length };
        }

        // 3. INSERT INTO roles (id, description) VALUES ($1, $2)
        if (trimmed.startsWith('INSERT INTO roles (id, description) VALUES ($1, $2)')) {
          roles.push({ id: params[0], description: params[1] });
          return { rows: [], rowCount: 1 };
        }

        // 4. INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
        if (trimmed.startsWith('INSERT INTO users')) {
          const row = {
            id: params[0],
            username: params[1],
            password_hash: params[2],
            is_active: params[3],
            created_at: new Date(),
            updated_at: new Date(),
          };
          users.push(row);
          return { rows: [row], rowCount: 1 };
        }

        // 5. INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
        if (trimmed.startsWith('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)')) {
          userRoles.push({ user_id: params[0], role_id: params[1] });
          return { rows: [], rowCount: 1 };
        }

        // 6. SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = $1
        if (trimmed.startsWith('SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = $1')) {
          const matched = users.filter((u) => u.username === params[0]);
          return { rows: matched, rowCount: matched.length };
        }

        // 7. Capability check query: SELECT users.id AS user_id, users.is_active AS is_active, roles.id AS role_id FROM users ...
        if (trimmed.includes('FROM users') && trimmed.includes('LEFT JOIN user_roles') && trimmed.includes('LEFT JOIN roles')) {
          const targetUserId = params[0];
          const user = users.find((u) => u.id === targetUserId);
          if (!user) return { rows: [], rowCount: 0 };
          const userGrants = userRoles.filter((ur) => ur.user_id === targetUserId);
          if (userGrants.length === 0) {
            return {
              rows: [{ user_id: user.id, is_active: user.is_active, role_id: null }],
              rowCount: 1,
            };
          }
          const rows = userGrants.map((g) => ({
            user_id: user.id,
            is_active: user.is_active,
            role_id: g.role_id,
          }));
          return { rows, rowCount: rows.length };
        }

        // 8. Cleanup queries
        if (trimmed.startsWith('DELETE FROM sessions WHERE id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = sessions.length;
          const filtered = sessions.filter((s) => !ids.includes(s.id));
          const removed = before - filtered.length;
          sessions.length = 0;
          sessions.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM sessions WHERE user_id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = sessions.length;
          const filtered = sessions.filter((s) => !ids.includes(s.user_id));
          const removed = before - filtered.length;
          sessions.length = 0;
          sessions.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2')) {
          const before = userRoles.length;
          const filtered = userRoles.filter(
            (ur) => !(ur.user_id === params[0] && ur.role_id === params[1])
          );
          const removed = before - filtered.length;
          userRoles.length = 0;
          userRoles.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM users WHERE id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = users.length;
          const filtered = users.filter((u) => !ids.includes(u.id));
          const removed = before - filtered.length;
          users.length = 0;
          users.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1')) {
          const inUse = userRoles.some((ur) => ur.role_id === params[0]);
          return { rows: inUse ? [{ '?column?': 1 }] : [], rowCount: inUse ? 1 : 0 };
        }

        if (trimmed.startsWith('DELETE FROM roles WHERE id = $1')) {
          const before = roles.length;
          const filtered = roles.filter((r) => r.id !== params[0]);
          const removed = before - filtered.length;
          roles.length = 0;
          roles.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        return { rows: [], rowCount: 0 };
      });

      return {
        query,
        users,
        roles,
        userRoles,
        sessions,
      };
    }

    it('creates maintainer and standard test identities with proper roles and capabilities', async () => {
      const mockDb = createMockDb();

      const state = await setupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        baseUsername: testBaseUsername,
        password: testPassword,
        stateFile: tempStateFile,
        db: mockDb,
      });

      // 1. Verify returned state structure
      expect(state.status).toBe('active');
      expect(state.runId).toBe(testRunId);
      expect(state.database).toBe(expectedDbName);
      expect(state.maintainer.username).toBe(`${testBaseUsername}_maintainer`);
      expect(state.maintainer.role).toBe('SYSTEM_MAINTAINER');
      expect(state.standard.username).toBe(`${testBaseUsername}_standard`);
      expect(state.standard.role).toBe(null);
      expect(state.createdUserIds.length).toBe(2);
      expect(state.createdGrants.length).toBe(1);
      expect(state.createdGrants[0]).toEqual({
        userId: state.maintainer.id,
        roleId: 'SYSTEM_MAINTAINER',
      });

      // 2. Verify state file written to disk with permissions 600
      expect(fsSync.existsSync(tempStateFile)).toBe(true);
      const fileContent = JSON.parse(await fs.readFile(tempStateFile, 'utf-8'));
      expect(fileContent.runId).toBe(testRunId);
      expect(fileContent.createdUserIds).toEqual(state.createdUserIds);

      const fileStat = await fs.stat(tempStateFile);
      const mode = (fileStat.mode & 0o777).toString(8);
      expect(mode).toBe('600');

      // 3. Verify passwords hashed with Argon2id in mock database
      expect(mockDb.users.length).toBe(2);
      for (const u of mockDb.users) {
        expect(isArgon2idHash(u.password_hash)).toBe(true);
      }

      // 4. Verify authentication using UserService
      const userService = new UserService({ db: mockDb });
      const authMaintainer = await userService.verifyCredentials(
        `${testBaseUsername}_maintainer`,
        testPassword
      );
      expect(authMaintainer.valid).toBe(true);
      expect(authMaintainer.user?.username).toBe(`${testBaseUsername}_maintainer`);

      const authStandard = await userService.verifyCredentials(
        `${testBaseUsername}_standard`,
        testPassword
      );
      expect(authStandard.valid).toBe(true);
      expect(authStandard.user?.username).toBe(`${testBaseUsername}_standard`);

      // 5. Wrong password rejected
      const authWrong = await userService.verifyCredentials(
        `${testBaseUsername}_maintainer`,
        'WrongPassword_123!'
      );
      expect(authWrong.valid).toBe(false);

      // 6. Verify capability mapping using CapabilityService
      const capService = new CapabilityService({ db: mockDb });
      expect(await capService.hasCapability(state.maintainer.id, 'system:maintain')).toBe(true);
      expect(await capService.hasCapability(state.standard.id, 'system:maintain')).toBe(false);

      // 7. Verify role creation tracking (SYSTEM_MAINTAINER was inserted and tracked)
      expect(state.createdRoleIds).toEqual(['SYSTEM_MAINTAINER']);
      expect(mockDb.roles).toContainEqual({
        id: 'SYSTEM_MAINTAINER',
        description: 'System maintainer with maintenance capabilities',
      });
    });

    it('does not re-create or track role if SYSTEM_MAINTAINER already exists prior to setup', async () => {
      const mockDb = createMockDb();
      // Pre-seed SYSTEM_MAINTAINER role
      mockDb.roles.push({
        id: 'SYSTEM_MAINTAINER',
        description: 'Preexisting system maintainer',
      });

      const state = await setupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        baseUsername: testBaseUsername,
        password: testPassword,
        stateFile: tempStateFile,
        db: mockDb,
      });

      // Role was NOT created by this run
      expect(state.createdRoleIds).toEqual([]);
      expect(mockDb.roles.length).toBe(1);
    });

    it('rejects conflicting preexisting identities without mutating any database rows', async () => {
      const mockDb = createMockDb();
      // Pre-seed a conflicting user
      mockDb.users.push({
        id: '11111111-1111-4000-8000-111111111111',
        username: `${testBaseUsername}_maintainer`,
        password_hash: 'preexisting_hash',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Conflicting preexisting test identities found/);

      // No additional users or grants were added
      expect(mockDb.users.length).toBe(1);
      expect(mockDb.userRoles.length).toBe(0);
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
    });
  });

  describe('4. Fixture Cleanup Invariants', () => {
    function createMockDbWithFixture(state: TestIdentityState) {
      const users = [
        {
          id: state.maintainer.id,
          username: state.maintainer.username,
          password_hash: 'hash_m',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: state.standard.id,
          username: state.standard.username,
          password_hash: 'hash_s',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
        // Unrelated user
        {
          id: '99999999-9999-4000-8000-999999999999',
          username: 'unrelated_user',
          password_hash: 'hash_unrelated',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const roles = [
        { id: 'SYSTEM_MAINTAINER', description: 'System maintainer' },
        { id: 'ADMINISTRATOR', description: 'Administrator' },
      ];

      const userRoles = [
        { user_id: state.maintainer.id, role_id: 'SYSTEM_MAINTAINER' },
      ];

      const sessions = [
        {
          id: 'sess_maintainer',
          user_id: state.maintainer.id,
          expires_at: new Date(Date.now() + 3600000),
          created_at: new Date(),
        },
        {
          id: 'sess_unrelated',
          user_id: '99999999-9999-4000-8000-999999999999',
          expires_at: new Date(Date.now() + 3600000),
          created_at: new Date(),
        },
      ];

      const query = vi.fn(async (sql: string, params: any[] = []) => {
        const trimmed = sql.trim();

        if (trimmed.startsWith('DELETE FROM sessions WHERE id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = sessions.length;
          const filtered = sessions.filter((s) => !ids.includes(s.id));
          const removed = before - filtered.length;
          sessions.length = 0;
          sessions.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM sessions WHERE user_id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = sessions.length;
          const filtered = sessions.filter((s) => !ids.includes(s.user_id));
          const removed = before - filtered.length;
          sessions.length = 0;
          sessions.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2')) {
          const before = userRoles.length;
          const filtered = userRoles.filter(
            (ur) => !(ur.user_id === params[0] && ur.role_id === params[1])
          );
          const removed = before - filtered.length;
          userRoles.length = 0;
          userRoles.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM users WHERE id = ANY($1)')) {
          const ids: string[] = params[0] || [];
          const before = users.length;
          const filtered = users.filter((u) => !ids.includes(u.id));
          const removed = before - filtered.length;
          users.length = 0;
          users.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1')) {
          const inUse = userRoles.some((ur) => ur.role_id === params[0]);
          return { rows: inUse ? [{ '?column?': 1 }] : [], rowCount: inUse ? 1 : 0 };
        }

        if (trimmed.startsWith('DELETE FROM roles WHERE id = $1')) {
          const before = roles.length;
          const filtered = roles.filter((r) => r.id !== params[0]);
          const removed = before - filtered.length;
          roles.length = 0;
          roles.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        return { rows: [], rowCount: 0 };
      });

      return { query, users, roles, userRoles, sessions };
    }

    it('deletes only owned users, grants, and sessions, preserving unrelated data', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: expectedDbName,
        status: 'active',
        maintainer: {
          id: '10000000-0000-4000-8000-000000000001',
          username: `${testBaseUsername}_maintainer`,
          role: 'SYSTEM_MAINTAINER',
        },
        standard: {
          id: '20000000-0000-4000-8000-000000000002',
          username: `${testBaseUsername}_standard`,
          role: null,
        },
        createdUserIds: [
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
        ],
        createdRoleIds: ['SYSTEM_MAINTAINER'],
        createdGrants: [
          {
            userId: '10000000-0000-4000-8000-000000000001',
            roleId: 'SYSTEM_MAINTAINER',
          },
        ],
        createdSessionIds: ['sess_maintainer'],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), 'utf-8');

      const mockDb = createMockDbWithFixture(state);

      const result = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(result.cleaned).toBe(true);
      expect(result.usersRemoved).toBe(2);
      expect(result.grantsRemoved).toBe(1);
      expect(result.sessionsRemoved).toBe(1);
      expect(result.rolesRemoved).toBe(1); // SYSTEM_MAINTAINER was unused after grant deletion

      // Unrelated user and session preserved
      expect(mockDb.users.length).toBe(1);
      expect(mockDb.users[0].username).toBe('unrelated_user');
      expect(mockDb.sessions.length).toBe(1);
      expect(mockDb.sessions[0].id).toBe('sess_unrelated');

      // State file removed
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
    });

    it('preserves created role if it is in use by another user', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: expectedDbName,
        status: 'active',
        maintainer: {
          id: '10000000-0000-4000-8000-000000000001',
          username: `${testBaseUsername}_maintainer`,
          role: 'SYSTEM_MAINTAINER',
        },
        standard: {
          id: '20000000-0000-4000-8000-000000000002',
          username: `${testBaseUsername}_standard`,
          role: null,
        },
        createdUserIds: [
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000002',
        ],
        createdRoleIds: ['SYSTEM_MAINTAINER'],
        createdGrants: [
          {
            userId: '10000000-0000-4000-8000-000000000001',
            roleId: 'SYSTEM_MAINTAINER',
          },
        ],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), 'utf-8');

      const mockDb = createMockDbWithFixture(state);
      // Give unrelated user the SYSTEM_MAINTAINER role
      mockDb.userRoles.push({
        user_id: '99999999-9999-4000-8000-999999999999',
        role_id: 'SYSTEM_MAINTAINER',
      });

      const result = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(result.cleaned).toBe(true);
      expect(result.rolesRemoved).toBe(0); // Role was preserved because unrelated user has it!
      expect(mockDb.roles.some((r) => r.id === 'SYSTEM_MAINTAINER')).toBe(true);
    });

    it('is safe on repeated cleanup (idempotent no-op when state file already deleted)', async () => {
      // tempStateFile does not exist
      expect(fsSync.existsSync(tempStateFile)).toBe(false);

      const mockDb = createMockDb();
      const result = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(result.cleaned).toBe(false);
      expect(result.reason).toBe('NO_STATE_FILE');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('fails closed when state file run ID mismatches', async () => {
      const state: TestIdentityState = {
        runId: 'other_run_999',
        database: expectedDbName,
        status: 'active',
        maintainer: { id: 'u1', username: 'm', role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2', username: 's', role: null },
        createdUserIds: ['u1', 'u2'],
        createdRoleIds: [],
        createdGrants: [],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), 'utf-8');

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId, // does not match other_run_999
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/State file run ID mismatch/);

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('fails closed when state file database mismatches', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: 's2_foundation_different_db',
        status: 'active',
        maintainer: { id: 'u1', username: 'm', role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2', username: 's', role: null },
        createdUserIds: ['u1', 'u2'],
        createdRoleIds: [],
        createdGrants: [],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), 'utf-8');

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/State file database mismatch/);

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('fails closed on corrupted state file JSON', async () => {
      await fs.writeFile(tempStateFile, 'NOT_VALID_JSON{{{', 'utf-8');

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Corrupted fixture state file/);

      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('5. Partial-Failure Cleanup & Error Retention', () => {
    it('writes partial state on intermediate failure and cleanup successfully removes partial resources', async () => {
      // Mock db that fails when creating standard user (the 2nd user)
      const users: any[] = [];
      const roles: any[] = [];
      const userRoles: any[] = [];

      let userInsertCount = 0;
      const failingDb = {
        query: vi.fn(async (sql: string, params: any[] = []) => {
          const trimmed = sql.trim();

          if (trimmed.startsWith('SELECT id, username FROM users')) {
            return { rows: [], rowCount: 0 };
          }
          if (trimmed.startsWith('SELECT id FROM roles WHERE id = $1')) {
            return { rows: [], rowCount: 0 };
          }
          if (trimmed.startsWith('INSERT INTO roles')) {
            roles.push({ id: params[0], description: params[1] });
            return { rows: [], rowCount: 1 };
          }
          if (trimmed.startsWith('INSERT INTO users')) {
            userInsertCount++;
            if (userInsertCount === 2) {
              throw new Error('Simulated database failure during standard user creation');
            }
            const row = {
              id: params[0],
              username: params[1],
              password_hash: params[2],
              is_active: params[3],
              created_at: new Date(),
              updated_at: new Date(),
            };
            users.push(row);
            return { rows: [row], rowCount: 1 };
          }
          if (trimmed.startsWith('INSERT INTO user_roles')) {
            userRoles.push({ user_id: params[0], role_id: params[1] });
            return { rows: [], rowCount: 1 };
          }
          if (trimmed.startsWith('DELETE FROM users WHERE id = ANY($1)')) {
            const ids: string[] = params[0] || [];
            const before = users.length;
            const filtered = users.filter((u) => !ids.includes(u.id));
            users.length = 0;
            users.push(...filtered);
            return { rows: [], rowCount: before - filtered.length };
          }
          if (trimmed.startsWith('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2')) {
            const before = userRoles.length;
            const filtered = userRoles.filter(
              (ur) => !(ur.user_id === params[0] && ur.role_id === params[1])
            );
            userRoles.length = 0;
            userRoles.push(...filtered);
            return { rows: [], rowCount: before - filtered.length };
          }
          if (trimmed.startsWith('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1')) {
            const inUse = userRoles.some((ur) => ur.role_id === params[0]);
            return { rows: inUse ? [{ '?column?': 1 }] : [], rowCount: inUse ? 1 : 0 };
          }
          if (trimmed.startsWith('DELETE FROM roles WHERE id = $1')) {
            const before = roles.length;
            const filtered = roles.filter((r) => r.id !== params[0]);
            roles.length = 0;
            roles.push(...filtered);
            return { rows: [], rowCount: before - filtered.length };
          }
          if (trimmed.startsWith('DELETE FROM sessions')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        }),
      };

      // Setup must fail with the original error
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: failingDb,
        })
      ).rejects.toThrow('Simulated database failure during standard user creation');

      // State file exists with partial status
      expect(fsSync.existsSync(tempStateFile)).toBe(true);
      const partialState = JSON.parse(await fs.readFile(tempStateFile, 'utf-8'));
      expect(partialState.status).toBe('partial');
      expect(partialState.createdUserIds.length).toBe(1); // maintainer was created
      expect(partialState.createdRoleIds).toEqual(['SYSTEM_MAINTAINER']);
      expect(partialState.createdGrants.length).toBe(1);

      // Verify database contains the partial rows
      expect(users.length).toBe(1);
      expect(roles.length).toBe(1);
      expect(userRoles.length).toBe(1);

      // Now run cleanup on the partial state
      const cleanupRes = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        runId: testRunId,
        stateFile: tempStateFile,
        db: failingDb,
      });

      expect(cleanupRes.cleaned).toBe(true);
      expect(cleanupRes.usersRemoved).toBe(1);
      expect(cleanupRes.grantsRemoved).toBe(1);
      expect(cleanupRes.rolesRemoved).toBe(1);

      // Database is clean
      expect(users.length).toBe(0);
      expect(roles.length).toBe(0);
      expect(userRoles.length).toBe(0);

      // State file removed
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
    });
  });

  describe('6. Environment File Loader', () => {
    it('loads key-value assignments from env file into process.env without leaking', async () => {
      const envPath = path.join(tempDir, 'test.env');
      await fs.writeFile(
        envPath,
        [
          '# Comment line',
          'EXPORT_KEY_1="value_1"',
          "export EXPORT_KEY_2='value_2'",
          'PLAIN_KEY=plain_value',
          '',
        ].join('\n'),
        'utf-8'
      );

      delete process.env.EXPORT_KEY_1;
      delete process.env.EXPORT_KEY_2;
      delete process.env.PLAIN_KEY;

      loadEnvFile(envPath);

      expect(process.env.EXPORT_KEY_1).toBe('value_1');
      expect(process.env.EXPORT_KEY_2).toBe('value_2');
      expect(process.env.PLAIN_KEY).toBe('plain_value');
    });
  });
});
