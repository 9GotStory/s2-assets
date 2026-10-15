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
  loadConfigFile,
  findRepoRoot,
  validateOutsideCheckout,
  writeStateFileAtomic,
  readAndValidateStateFile,
  parseTimeoutMs,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
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
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Isolate from ambient database variables
    originalEnv = { ...process.env };
    delete process.env.POSTGRES_DB;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.FOUNDATION_TEST_DATABASE_URL;
    delete process.env.FOUNDATION_ENV_FILE;
    delete process.env.FOUNDATION_FIXTURE_ENV_FILE;
    delete process.env.FOUNDATION_FIXTURE_CONFIG_FILE;
    delete process.env.FOUNDATION_FIXTURE_STATE_FILE;
    delete process.env.FOUNDATION_TEST_RUN_ID;
    delete process.env.FOUNDATION_TEST_USERNAME;
    delete process.env.FOUNDATION_TEST_PASSWORD;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-test-'));
    await fs.chmod(tempDir, 0o700);
    tempStateFile = path.join(tempDir, `fixture-state-${testRunId}.json`);
  });

  afterEach(async () => {
    process.env = originalEnv;
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

    const mockDb: any = {
      users,
      roles,
      userRoles,
      sessions,
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const trimmed = sql.trim();

        // Transaction management and locking
        if (
          trimmed.startsWith('BEGIN') ||
          trimmed.startsWith('COMMIT') ||
          trimmed.startsWith('ROLLBACK') ||
          trimmed.startsWith('LOCK TABLE') ||
          trimmed.includes('pg_advisory_xact_lock')
        ) {
          return { rows: [], rowCount: 0 };
        }

        if (trimmed.includes('set_config')) {
          return { rows: [{ set_config: params[1] }], rowCount: 1 };
        }

        if (trimmed.startsWith('SHOW lock_timeout')) {
          return { rows: [{ lock_timeout: '5s' }], rowCount: 1 };
        }

        if (trimmed.startsWith('SHOW statement_timeout')) {
          return { rows: [{ statement_timeout: '10s' }], rowCount: 1 };
        }

        if (trimmed.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }

        if (trimmed.includes('pg_advisory_unlock')) {
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }

        // Check ownership against users table
        if (trimmed.startsWith('SELECT id, username FROM users WHERE id = ANY($1')) {
          const ids: string[] = params[0] || [];
          const matched = users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, username: u.username }));
          return { rows: matched, rowCount: matched.length };
        }

        // Check ownership against sessions table
        if (trimmed.startsWith('SELECT id, user_id FROM sessions WHERE id = ANY($1')) {
          const ids: string[] = params[0] || [];
          const matched = sessions.filter((s) => ids.includes(s.id)).map((s) => ({ id: s.id, user_id: s.user_id }));
          return { rows: matched, rowCount: matched.length };
        }

        // 1. Conflict check: SELECT id, username FROM users WHERE username = $1 OR username = $2
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
        if (trimmed.startsWith('DELETE FROM sessions WHERE id = ANY($1')) {
          const ids: string[] = params[0] || [];
          const userIds: string[] | undefined = params[1];
          const before = sessions.length;
          const filtered = sessions.filter((s) => {
            if (userIds) {
              return !(ids.includes(s.id) && userIds.includes(s.user_id));
            }
            return !ids.includes(s.id);
          });
          const removed = before - filtered.length;
          sessions.length = 0;
          sessions.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        if (trimmed.startsWith('DELETE FROM sessions WHERE user_id = ANY($1')) {
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

        if (trimmed.startsWith('DELETE FROM users WHERE id = ANY($1')) {
          const ids: string[] = params[0] || [];
          const before = users.length;
          const filtered = users.filter((u) => !ids.includes(u.id));
          const removed = before - filtered.length;
          users.length = 0;
          users.push(...filtered);
          return { rows: [], rowCount: removed };
        }

        // NOT EXISTS role deletion check
        if (trimmed.startsWith('DELETE FROM roles WHERE id = $1 AND NOT EXISTS')) {
          const inUse = userRoles.some((ur) => ur.role_id === params[0]);
          if (inUse) {
            return { rows: [], rowCount: 0 };
          }
          const before = roles.length;
          const filtered = roles.filter((r) => r.id !== params[0]);
          const removed = before - filtered.length;
          roles.length = 0;
          roles.push(...filtered);
          return { rows: [], rowCount: removed };
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
      }),
      connect: vi.fn(async () => mockDb),
      release: vi.fn(),
      end: vi.fn(async () => {}),
    };

    return mockDb;
  }

  function createMockDbWithFixture(state: TestIdentityState) {
    const mockDb = createMockDb();

    mockDb.users.push(
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
      }
    );

    mockDb.roles.push(
      { id: 'SYSTEM_MAINTAINER', description: 'System maintainer' },
      { id: 'ADMINISTRATOR', description: 'Administrator' }
    );

    mockDb.userRoles.push({
      user_id: state.maintainer.id,
      role_id: 'SYSTEM_MAINTAINER',
    });

    mockDb.sessions.push(
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
      }
    );

    return mockDb;
  }

  describe('1. Target Database & URL Validation', () => {
    it('accepts valid database URL matching expectedDb exactly', () => {
      const { dbName, targetEndpoint } = validateTargetDatabase(validDbUrl, expectedDbName);
      expect(dbName).toBe(expectedDbName);
      expect(targetEndpoint).toBe(`127.0.0.1:5432/${expectedDbName}`);
    });

    it('rejects missing expectedDb parameter', () => {
      expect(() => validateTargetDatabase(validDbUrl, undefined)).toThrow(
        /Expected database name is required/
      );
    });

    it('rejects missing or empty database URL', () => {
      expect(() => validateTargetDatabase('', expectedDbName)).toThrow(
        /Database URL is required and must be a non-empty string/
      );
      expect(() => validateTargetDatabase(undefined, expectedDbName)).toThrow(
        /Database URL is required and must be a non-empty string/
      );
    });

    it('rejects malformed database URL', () => {
      expect(() => validateTargetDatabase('not-a-valid-url', expectedDbName)).toThrow(
        /Invalid database URL format/
      );
    });

    it('rejects non-PostgreSQL protocols', () => {
      expect(() =>
        validateTargetDatabase('mysql://user:pw@127.0.0.1:3306/s2_foundation_test', 's2_foundation_test')
      ).toThrow(/Invalid database protocol: expected postgresql:/);
      expect(() =>
        validateTargetDatabase('http://user:pw@127.0.0.1:5432/s2_foundation_test', 's2_foundation_test')
      ).toThrow(/Invalid database protocol: expected postgresql:/);
    });

    it('rejects production database hostnames in URL host', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@db-prod.internal:5432/s2_foundation_test', 's2_foundation_test')
      ).toThrow(/Production database target is prohibited/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@my-production.aws.rds.com:5432/s2_foundation_test', 's2_foundation_test')
      ).toThrow(/Production database target is prohibited/);
    });

    it('rejects production database host in ?host= query parameter override', () => {
      expect(() =>
        validateTargetDatabase(
          'postgresql://u:p@localhost:5432/s2_foundation_test?host=s2.internal',
          's2_foundation_test'
        )
      ).toThrow(/Production database target is prohibited/);
      expect(() =>
        validateTargetDatabase(
          'postgresql://u:p@dummyhost:5432/s2_foundation_test?host=prod-db.rds.amazonaws.com',
          's2_foundation_test'
        )
      ).toThrow(/Production database target is prohibited/);
    });

    it('rejects database names not starting with s2_foundation_', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/s2_assets', 's2_assets')
      ).toThrow(/Database target must begin with "s2_foundation_"/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/my_unmarked_db', 'my_unmarked_db')
      ).toThrow(/Database target must begin with "s2_foundation_"/);
    });

    it('rejects default or shared database names', () => {
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/s2_foundation_s2_assets', 's2_foundation_s2_assets')
      ).toThrow(/Database target cannot be default or shared database/);
      expect(() =>
        validateTargetDatabase('postgresql://u:p@127.0.0.1:5432/postgres', 'postgres')
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
        validateTargetDatabase(secretUrl, 'invalid_name');
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
          expectedDb: expectedDbName,
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
          expectedDb: expectedDbName,
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
          expectedDb: expectedDbName,
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
          expectedDb: expectedDbName,
          runId: 'invalid run with spaces',
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_RUN_ID is required and must be alphanumeric/);
    });

    it('rejects missing or invalid FOUNDATION_TEST_USERNAME', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: '',
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_USERNAME is required/);

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: 'bad username!',
          password: testPassword,
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_USERNAME is required and must be alphanumeric/);
    });

    it('rejects short or trivial passwords', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: 'short',
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_PASSWORD must contain at least 8 non-whitespace characters/);

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: 'password',
          stateFile: tempStateFile,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_PASSWORD cannot use default or trivial passwords/);
    });

    it('rejects missing stateFile', async () => {
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: undefined,
        })
      ).rejects.toThrow(/FOUNDATION_FIXTURE_STATE_FILE is required/);
    });
  });

  describe('3. Fixture Setup & Authentication Invariants', () => {
    it('creates maintainer and standard test identities with proper roles and capabilities', async () => {
      const mockDb = createMockDb();

      const state = await setupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
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
      mockDb.roles.push({
        id: 'SYSTEM_MAINTAINER',
        description: 'Preexisting system maintainer',
      });

      const state = await setupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
        runId: testRunId,
        baseUsername: testBaseUsername,
        password: testPassword,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(state.createdRoleIds).toEqual([]);
      expect(mockDb.roles.length).toBe(1);
    });

    it('rejects conflicting preexisting identities without mutating any database rows', async () => {
      const mockDb = createMockDb();
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
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Conflicting preexisting test identities found/);

      expect(mockDb.users.length).toBe(1);
      expect(mockDb.userRoles.length).toBe(0);
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
    });

    // Finding 2 regression: Repeated setup rejects overwrite
    it('rejects repeated setup when an ownership state file already exists', async () => {
      const mockDb = createMockDb();
      // Write an existing state file
      await fs.writeFile(tempStateFile, JSON.stringify({ runId: 'prior_run' }), 'utf-8');

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: 'different_user',
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Existing fixture state record found.*Cannot overwrite/);

      expect(mockDb.query).not.toHaveBeenCalled();
    });

    // Finding 3 regression: EISDIR on stateFile path fails immediately before DB mutation
    it('fails immediately when stateFile path is a directory (EISDIR) without touching database', async () => {
      const dirAsStatePath = path.join(tempDir, 'state-is-a-dir');
      await fs.mkdir(dirAsStatePath, { mode: 0o700 });

      const mockDb = createMockDb();
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: dirAsStatePath,
          db: mockDb,
        })
      ).rejects.toThrow(/EISDIR/);

      expect(mockDb.query).not.toHaveBeenCalled();
      expect(mockDb.users.length).toBe(0);
    });

    // Finding 3 regression: Mutation failure rolls back transaction and cleans up reservation file
    it('rolls back database transaction and cleans reservation file on intermediate failure', async () => {
      const mockDb = createMockDb();
      // Cause standard user insertion to throw
      let insertCount = 0;
      const originalQuery = mockDb.query;
      mockDb.query = vi.fn(async (sql: string, params: any[]) => {
        if (sql.trim().startsWith('INSERT INTO users')) {
          insertCount++;
          if (insertCount === 2) {
            throw new Error('Simulated database error on second user insertion');
          }
        }
        return originalQuery(sql, params);
      });

      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow('Simulated database error on second user insertion');

      // State file must be cleaned up
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
      // ROLLBACK was issued
      expect(mockDb.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('4. Fixture Cleanup Invariants', () => {
    it('deletes only owned users, grants, and sessions, preserving unrelated data', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: expectedDbName,
        targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
        status: 'active',
        maintainer: { id: 'u1111111-1111-4000-8000-111111111111', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2222222-2222-4000-8000-222222222222', username: `${testBaseUsername}_standard`, role: null },
        createdUserIds: [
          'u1111111-1111-4000-8000-111111111111',
          'u2222222-2222-4000-8000-222222222222',
        ],
        createdRoleIds: ['SYSTEM_MAINTAINER'],
        createdGrants: [
          {
            userId: 'u1111111-1111-4000-8000-111111111111',
            roleId: 'SYSTEM_MAINTAINER',
          },
        ],
        createdSessionIds: ['sess_maintainer'],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
        encoding: 'utf-8',
      });
      const mockDb = createMockDbWithFixture(state);

      const cleanupRes = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
        runId: testRunId,
        baseUsername: testBaseUsername,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(cleanupRes.cleaned).toBe(true);
      expect(cleanupRes.usersRemoved).toBe(2);
      expect(cleanupRes.grantsRemoved).toBe(1);
      expect(cleanupRes.rolesRemoved).toBe(1);
      expect(cleanupRes.sessionsRemoved).toBe(1);

      // Unrelated user and session preserved
      expect(mockDb.users.some((u: any) => u.username === 'unrelated_user')).toBe(true);
      expect(mockDb.sessions.some((s: any) => s.id === 'sess_unrelated')).toBe(true);
      expect(mockDb.roles.some((r: any) => r.id === 'ADMINISTRATOR')).toBe(true);

      // State file removed
      expect(fsSync.existsSync(tempStateFile)).toBe(false);
    });

    // Finding 1 regression: Safe unused role check preserves role if unrelated grant references it
    it('preserves role if another grant references it and locks user_roles table', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: expectedDbName,
        targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
        status: 'active',
        maintainer: { id: 'u1111111-1111-4000-8000-111111111111', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2222222-2222-4000-8000-222222222222', username: `${testBaseUsername}_standard`, role: null },
        createdUserIds: ['u1111111-1111-4000-8000-111111111111', 'u2222222-2222-4000-8000-222222222222'],
        createdRoleIds: ['SYSTEM_MAINTAINER'],
        createdGrants: [{ userId: 'u1111111-1111-4000-8000-111111111111', roleId: 'SYSTEM_MAINTAINER' }],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
        encoding: 'utf-8',
      });
      const mockDb = createMockDbWithFixture(state);

      // Unrelated user ALSO holds SYSTEM_MAINTAINER grant
      mockDb.userRoles.push({
        user_id: '99999999-9999-4000-8000-999999999999',
        role_id: 'SYSTEM_MAINTAINER',
      });

      const cleanupRes = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
        runId: testRunId,
        baseUsername: testBaseUsername,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(cleanupRes.cleaned).toBe(true);
      expect(cleanupRes.rolesRemoved).toBe(0); // Role was NOT deleted
      expect(mockDb.roles.some((r: any) => r.id === 'SYSTEM_MAINTAINER')).toBe(true);
      // Unrelated grant preserved
      expect(
        mockDb.userRoles.some(
          (ur: any) =>
            ur.user_id === '99999999-9999-4000-8000-999999999999' &&
            ur.role_id === 'SYSTEM_MAINTAINER'
        )
      ).toBe(true);
      // LOCK TABLE was called
      expect(mockDb.query).toHaveBeenCalledWith('LOCK TABLE user_roles IN SHARE ROW EXCLUSIVE MODE');
    });

    it('is safe on repeated cleanup (idempotent no-op when state file already deleted)', async () => {
      const mockDb = createMockDb();

      const result = await cleanupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
        runId: testRunId,
        baseUsername: testBaseUsername,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(result.cleaned).toBe(false);
      expect(result.reason).toBe('NO_STATE_FILE');
    });

    // Finding 4 regression: Cleanup rejects missing runId
    it('rejects cleanup without a valid run ID', async () => {
      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: '',
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/FOUNDATION_TEST_RUN_ID is required/);
    });

    // Finding 4 regression: Cleanup validates target database before checking state file
    it('rejects cleanup on invalid database URL even if state file is absent', async () => {
      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: 'postgresql://u:p@db-prod.internal:5432/s2_foundation_test',
          expectedDb: 's2_foundation_test',
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Production database target is prohibited/);
    });

    it('fails closed when state file run ID mismatches', async () => {
      const state: TestIdentityState = {
        runId: 'other_run_999',
        database: expectedDbName,
        targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
        status: 'active',
        maintainer: { id: 'u1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2', username: `${testBaseUsername}_standard`, role: null },
        createdUserIds: ['u1', 'u2'],
        createdRoleIds: [],
        createdGrants: [],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
        encoding: 'utf-8',
      });

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/State file run ID mismatch/);
    });

    it('fails closed when state file database mismatches', async () => {
      const state: TestIdentityState = {
        runId: testRunId,
        database: 's2_foundation_different_db',
        targetEndpoint: '127.0.0.1:5432/s2_foundation_different_db',
        status: 'active',
        maintainer: { id: 'u1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
        standard: { id: 'u2', username: `${testBaseUsername}_standard`, role: null },
        createdUserIds: ['u1', 'u2'],
        createdRoleIds: [],
        createdGrants: [],
        createdSessionIds: [],
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
        mode: 0o600,
        encoding: 'utf-8',
      });

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/State file database mismatch/);
    });

    it('fails closed on corrupted state file JSON', async () => {
      await fs.writeFile(tempStateFile, 'NOT_VALID_JSON{{{', {
        mode: 0o600,
        encoding: 'utf-8',
      });

      const mockDb = createMockDb();
      await expect(
        cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Corrupted fixture state file/);
    });
  });

  describe('5. Lossless Password Transport & Special Characters (Finding 5)', () => {
    it('preserves quotes, trailing spaces, backslashes and dollar signs losslessly', async () => {
      const complexPassword = '"quoted_pass"\\with\\$dollars and spaces   ';
      const configPath = path.join(tempDir, 'runner-config.json');

      await fs.writeFile(
        configPath,
        JSON.stringify({
          NODE_ENV: 'test',
          FOUNDATION_TEST_RUN_ID: testRunId,
          FOUNDATION_TEST_USERNAME: testBaseUsername,
          FOUNDATION_TEST_PASSWORD: complexPassword,
          FOUNDATION_TEST_DATABASE_URL: validDbUrl,
          POSTGRES_DB: expectedDbName,
          FOUNDATION_FIXTURE_STATE_FILE: tempStateFile,
        }),
        'utf-8'
      );

      loadConfigFile(configPath);
      expect(process.env.FOUNDATION_TEST_PASSWORD).toBe(complexPassword);

      const mockDb = createMockDb();
      const state = await setupTestIdentities({
        nodeEnv: 'test',
        databaseUrl: validDbUrl,
        expectedDb: expectedDbName,
        runId: testRunId,
        baseUsername: testBaseUsername,
        password: complexPassword,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(state.status).toBe('active');

      // Verify that authentication against Argon2id works with the EXACT complex password
      const userService = new UserService({ db: mockDb });
      const auth = await userService.verifyCredentials(
        `${testBaseUsername}_maintainer`,
        complexPassword
      );
      expect(auth.valid).toBe(true);

      // Verify that trimmed or quote-stripped variants FAIL authentication
      const authTrimmed = await userService.verifyCredentials(
        `${testBaseUsername}_maintainer`,
        complexPassword.trim()
      );
      expect(authTrimmed.valid).toBe(false);
    });
  });

  describe('6. Ambient Database Variable Sensitivity (Finding 6)', () => {
    it('succeeds when ambient POSTGRES_DB matches target URL', async () => {
      process.env.POSTGRES_DB = expectedDbName;
      process.env.FOUNDATION_TEST_DATABASE_URL = validDbUrl;

      const mockDb = createMockDb();
      const state = await setupTestIdentities({
        nodeEnv: 'test',
        runId: testRunId,
        baseUsername: testBaseUsername,
        password: testPassword,
        stateFile: tempStateFile,
        db: mockDb,
      });

      expect(state.status).toBe('active');
    });

    it('rejects with target mismatch when ambient POSTGRES_DB does not match target URL', async () => {
      process.env.POSTGRES_DB = 's2_foundation_lead_mismatched_db';
      process.env.FOUNDATION_TEST_DATABASE_URL = validDbUrl;

      const mockDb = createMockDb();
      await expect(
        setupTestIdentities({
          nodeEnv: 'test',
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        })
      ).rejects.toThrow(/Database target mismatch/);
    });
  });

  describe('7. Environment File Loader', () => {
    it('loads key-value assignments from env file into process.env without stripping internal quotes', async () => {
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

  describe('8. Round 2 Regressions & Robustness Invariants', () => {
    describe('8.1 Effective Endpoint & Driver Parsing (Finding 3)', () => {
      it('rejects duplicate ?host= override when any parameter names a production host', () => {
        const url = 'postgresql://u:p@localhost:5432/s2_foundation_test?host=postgres&host=production.invalid';
        expect(() => validateTargetDatabase(url, 's2_foundation_test')).toThrow(
          /Production database target is prohibited/
        );
      });

      it('rejects URL-encoded production host in ?host= query parameter', () => {
        const url = 'postgresql://u:p@localhost:5432/s2_foundation_test?host=prod%2Einternal';
        expect(() => validateTargetDatabase(url, 's2_foundation_test')).toThrow(
          /Production database target is prohibited/
        );
      });

      it('binds exact effective port from ?port= override matching pg driver semantics', () => {
        const url = 'postgresql://u:p@localhost:5432/s2_foundation_test?port=15432';
        const res = validateTargetDatabase(url, 's2_foundation_test');
        expect(res.targetEndpoint).toBe('localhost:15432/s2_foundation_test');
      });

      it('takes last port parameter when duplicate ?port= overrides are present', () => {
        const url = 'postgresql://u:p@localhost:5432/s2_foundation_test?port=1111&port=2222';
        const res = validateTargetDatabase(url, 's2_foundation_test');
        expect(res.targetEndpoint).toBe('localhost:2222/s2_foundation_test');
      });
    });

    describe('8.2 Ownership State Permissions & Integrity (Finding 5)', () => {
      it('rejects cleanup when state file has insecure mode 0644', async () => {
        const state: TestIdentityState = {
          runId: testRunId,
          database: expectedDbName,
          targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
          status: 'active',
          maintainer: { id: 'u1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
          standard: { id: 'u2', username: `${testBaseUsername}_standard`, role: null },
          createdUserIds: ['u1', 'u2'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };

        await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
          mode: 0o644,
          encoding: 'utf-8',
        });
        await fs.chmod(tempStateFile, 0o644);

        const mockDb = createMockDb();
        await expect(
          cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/Insecure permissions on state file/);
      });

      it('rejects cleanup when targetEndpoint is missing from state record', async () => {
        const state: any = {
          runId: testRunId,
          database: expectedDbName,
          status: 'active',
          maintainer: { id: 'u1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
          standard: { id: 'u2', username: `${testBaseUsername}_standard`, role: null },
          createdUserIds: ['u1', 'u2'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };

        await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
          mode: 0o600,
          encoding: 'utf-8',
        });

        const mockDb = createMockDb();
        await expect(
          cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/missing targetEndpoint/);
      });

      it('rejects cleanup when targetEndpoint mismatches expected connection endpoint', async () => {
        const state: TestIdentityState = {
          runId: testRunId,
          database: expectedDbName,
          targetEndpoint: `otherhost:9999/${expectedDbName}`,
          status: 'active',
          maintainer: { id: 'u1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
          standard: { id: 'u2', username: `${testBaseUsername}_standard`, role: null },
          createdUserIds: ['u1', 'u2'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };

        await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), {
          mode: 0o600,
          encoding: 'utf-8',
        });

        const mockDb = createMockDb();
        await expect(
          cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/State file target mismatch/);
      });
    });

    describe('8.3 Advisory Lock Serialization (Finding 1)', () => {
      it('acquires session advisory lock keyed by run ID during setup and cleanup', async () => {
        const mockDb = createMockDb();
        const state = await setupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          password: testPassword,
          stateFile: tempStateFile,
          db: mockDb,
        });

        expect(state.status).toBe('active');
        expect(mockDb.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_try_advisory_lock'),
          [testRunId]
        );
        expect(mockDb.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_advisory_unlock'),
          [testRunId]
        );

        await cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        });

        expect(mockDb.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_try_advisory_lock'),
          [testRunId]
        );
        expect(mockDb.query).toHaveBeenCalledWith(
          expect.stringContaining('pg_advisory_unlock'),
          [testRunId]
        );
      });
    });

    describe('8.4 Uncertain Commit Outcome & Recovery (Finding 2)', () => {
      it('preserves state file with status uncertain on commit failure and permits recovery via cleanup', async () => {
        const mockDb = createMockDb();
        const originalQuery = mockDb.query;
        // Intercept COMMIT and raise a simulated network error
        mockDb.query = vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.trim().startsWith('COMMIT')) {
            throw new Error('Simulated lost-acknowledgement network drop at COMMIT');
          }
          return originalQuery(sql, params);
        });

        await expect(
          setupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            password: testPassword,
            stateFile: tempStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/Simulated lost-acknowledgement network drop at COMMIT/);

        // State file is preserved with status 'uncertain'
        expect(fsSync.existsSync(tempStateFile)).toBe(true);
        const raw = await fs.readFile(tempStateFile, 'utf-8');
        const uncertainState = JSON.parse(raw);
        expect(uncertainState.status).toBe('uncertain');
        expect(uncertainState.createdUserIds.length).toBe(2);

        // Subsequent cleanup recovers and deletes the uncertain state
        mockDb.query = originalQuery;
        const cleanupRes = await cleanupTestIdentities({
          nodeEnv: 'test',
          databaseUrl: validDbUrl,
          expectedDb: expectedDbName,
          runId: testRunId,
          baseUsername: testBaseUsername,
          stateFile: tempStateFile,
          db: mockDb,
        });

        expect(cleanupRes.cleaned).toBe(true);
        expect(cleanupRes.usersRemoved).toBe(2);
        expect(fsSync.existsSync(tempStateFile)).toBe(false);
      });
    });

    describe('8.5 Outside Checkout Boundary Enforcement (Finding 4)', () => {
      it('rejects setup when stateFile resides inside repository checkout', async () => {
        const repoRoot = findRepoRoot();
        const insideCheckoutStateFile = path.join(repoRoot, 'apps/api/test-fixture-state.json');
        const mockDb = createMockDb();

        await expect(
          setupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            password: testPassword,
            stateFile: insideCheckoutStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/must reside outside repository checkout/);
      });

      it('rejects cleanup when stateFile resides inside repository checkout', async () => {
        const repoRoot = findRepoRoot();
        const insideCheckoutStateFile = path.join(repoRoot, 'apps/api/test-fixture-state.json');
        const mockDb = createMockDb();

        await expect(
          cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: insideCheckoutStateFile,
            db: mockDb,
          })
        ).rejects.toThrow(/must reside outside repository checkout/);
      });
    });

    describe('8.6 Atomic State Replacement & Durability (Finding 3)', () => {
      it('atomically updates state file without truncating existing content on write failure', async () => {
        const initialState: TestIdentityState = {
          runId: testRunId,
          database: expectedDbName,
          targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
          status: 'initializing',
          maintainer: { id: 'm1', username: 'm_user', role: 'SYSTEM_MAINTAINER' },
          standard: { id: 's1', username: 's_user', role: null },
          createdUserIds: ['m1', 's1'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };

        await writeStateFileAtomic(tempStateFile, initialState);
        const contentBefore = await fs.readFile(tempStateFile, 'utf-8');
        expect(JSON.parse(contentBefore).status).toBe('initializing');

        const updatedState: TestIdentityState = {
          ...initialState,
          status: 'active',
        };
        await writeStateFileAtomic(tempStateFile, updatedState);
        const contentAfter = await fs.readFile(tempStateFile, 'utf-8');
        expect(JSON.parse(contentAfter).status).toBe('active');
        expect(JSON.parse(contentAfter).createdUserIds).toEqual(['m1', 's1']);
      });
    });

    describe('8.7 State Revalidation Under Lock (Finding 2)', () => {
      it('fails closed when state file contains corrupted JSON', async () => {
        await fs.writeFile(tempStateFile, '{ not valid json ...', { mode: 0o600 });
        await expect(
          readAndValidateStateFile(
            tempStateFile,
            testRunId,
            expectedDbName,
            `127.0.0.1:5432/${expectedDbName}`
          )
        ).rejects.toThrow(/JSON parse failed/);
      });

      it('fails closed when state file run ID mismatches expected run ID', async () => {
        const mismatchState: TestIdentityState = {
          runId: 'unrelated_run_id',
          database: expectedDbName,
          targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
          status: 'active',
          maintainer: { id: 'm1', username: 'm_user', role: 'SYSTEM_MAINTAINER' },
          standard: { id: 's1', username: 's_user', role: null },
          createdUserIds: ['m1', 's1'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };
        await writeStateFileAtomic(tempStateFile, mismatchState);

        await expect(
          readAndValidateStateFile(
            tempStateFile,
            testRunId,
            expectedDbName,
            `127.0.0.1:5432/${expectedDbName}`
          )
        ).rejects.toThrow(/State file run ID mismatch/);
      });

      it('fails closed when state file has insecure permissions (0644)', async () => {
        const state: TestIdentityState = {
          runId: testRunId,
          database: expectedDbName,
          targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
          status: 'active',
          maintainer: { id: 'm1', username: 'm_user', role: 'SYSTEM_MAINTAINER' },
          standard: { id: 's1', username: 's_user', role: null },
          createdUserIds: ['m1', 's1'],
          createdRoleIds: [],
          createdGrants: [],
          createdSessionIds: [],
          createdAt: new Date().toISOString(),
        };
        await writeStateFileAtomic(tempStateFile, state);
        await fs.chmod(tempStateFile, 0o644);

        await expect(
          readAndValidateStateFile(
            tempStateFile,
            testRunId,
            expectedDbName,
            `127.0.0.1:5432/${expectedDbName}`
          )
        ).rejects.toThrow(/Insecure permissions on state file/);
      });
    });

    describe('9. Round 4 Regressions & Robustness Invariants (P1 & P2)', () => {
      describe('9.1 Ownership-Safe Cleanup & Invariant Consistency (P1)', () => {
        it('rejects state file when a grant belongs to an unowned user ID', async () => {
          const badState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: 'm_user', role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: 's_user', role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [{ userId: 'unrelated_outsider_id', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, badState);

          await expect(
            readAndValidateStateFile(
              tempStateFile,
              testRunId,
              expectedDbName,
              `127.0.0.1:5432/${expectedDbName}`
            )
          ).rejects.toThrow(/grant user "unrelated_outsider_id" does not belong to run-owned identities/);
        });

        it('rejects state file when createdUserIds contains an unowned ID not matching maintainer or standard', async () => {
          const badState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: 'm_user', role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: 's_user', role: null },
            createdUserIds: ['m1', 's1', 'unrelated_extra_user'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, badState);

          await expect(
            readAndValidateStateFile(
              tempStateFile,
              testRunId,
              expectedDbName,
              `127.0.0.1:5432/${expectedDbName}`
            )
          ).rejects.toThrow(/createdUserIds contains unowned user ID "unrelated_extra_user"/);
        });

        it('fails cleanup and rolls back if an existing session in DB belongs to an unowned identity', async () => {
          const mockDb = createMockDb();
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [{ userId: 'm1', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: ['outsider_session_1'],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          // Add users to mockDb
          mockDb.users.push(
            { id: 'm1', username: `${testBaseUsername}_maintainer`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 'outsider_id', username: 'outsider', password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );
          // Outsider has a session
          mockDb.sessions.push({
            id: 'outsider_session_1',
            user_id: 'outsider_id',
            expires_at: new Date(Date.now() + 3600000),
            created_at: new Date(),
          });

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/Inconsistent session ownership: session "outsider_session_1" belongs to user "outsider_id"/);

          // Outsider's session and user must remain completely intact
          expect(mockDb.sessions.length).toBe(1);
          expect(mockDb.sessions[0].id).toBe('outsider_session_1');
          expect(mockDb.users.length).toBe(3);
        });

        it('fails cleanup and rolls back if database user username does not match recorded fixture identity', async () => {
          const mockDb = createMockDb();
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          // Mock DB has a user with id m1, but DIFFERENT username (e.g. hijacked ID)
          mockDb.users.push(
            { id: 'm1', username: 'different_user_name', password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(new RegExp(`Database ownership mismatch: user "m1" has username "different_user_name", expected "${testBaseUsername}_maintainer"`));

          // Verify no users were deleted
          expect(mockDb.users.length).toBe(2);
        });
      });

      describe('9.2 Bounded Lock and Statement Timeouts (P2)', () => {
        it('configures lock_timeout and statement_timeout on cleanup transaction', async () => {
          const mockDb = createMockDb();
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          mockDb.users.push(
            { id: 'm1', username: `${testBaseUsername}_maintainer`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );

          await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
            lockTimeoutMs: 3000,
            statementTimeoutMs: 6000,
          });

          // Verify set_config was called for lock_timeout and statement_timeout
          const setConfigCalls = mockDb.query.mock.calls.filter((c: any) =>
            typeof c[0] === 'string' && c[0].includes('set_config')
          );
          expect(setConfigCalls.length).toBeGreaterThanOrEqual(2);
          expect(setConfigCalls.some((c: any) => c[1]?.[0] === '3000ms')).toBe(true);
          expect(setConfigCalls.some((c: any) => c[1]?.[0] === '6000ms')).toBe(true);
        });

        it('fails closed and preserves state file when LOCK TABLE times out', async () => {
          const mockDb = createMockDb();
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['SYSTEM_MAINTAINER'],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          mockDb.users.push(
            { id: 'm1', username: `${testBaseUsername}_maintainer`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );
          mockDb.roles.push({ id: 'SYSTEM_MAINTAINER', description: 'desc' });

          // Override mockDb.query to simulate lock timeout on LOCK TABLE
          const originalQuery = mockDb.query;
          mockDb.query = vi.fn(async (sql: string, params: any[]) => {
            if (sql.includes('LOCK TABLE')) {
              const err = new Error('canceling statement due to lock timeout');
              (err as any).code = '55P03';
              throw err;
            }
            return originalQuery(sql, params);
          });

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/canceling statement due to lock timeout/);

          // State file must be preserved intact for safe recovery
          const stateExists = await fs.stat(tempStateFile).then(() => true, () => false);
          expect(stateExists).toBe(true);
          const raw = await fs.readFile(tempStateFile, 'utf-8');
          expect(JSON.parse(raw).runId).toBe(testRunId);

          // Rollback occurred
          const rollbackCalls = mockDb.query.mock.calls.filter((c: any) =>
            typeof c[0] === 'string' && c[0].includes('ROLLBACK')
          );
          expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
        });
      });
    });

    describe('10. Round 5 Acceptance Cases (O1–O10 & T1–T7)', () => {
      describe('10.1 P1 Acceptance Cases (O1–O10)', () => {
        it('O1: rejects unprovable ownership when descriptors are removed and createdUserIds targets outsider U', async () => {
          const mockDb = createMockDb();
          const outsiderId = '99999999-9999-4000-8000-999999999999';
          mockDb.users.push({
            id: outsiderId,
            username: 'outsider_user',
            password_hash: 'hash',
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          });
          mockDb.roles.push({ id: 'UNRELATED_ROLE', description: 'unrelated role' });
          mockDb.userRoles.push({ user_id: outsiderId, role_id: 'UNRELATED_ROLE' });
          mockDb.sessions.push({
            id: 'outsider_sess',
            user_id: outsiderId,
            expires_at: new Date(Date.now() + 3600000),
            created_at: new Date(),
          });

          // State record with descriptors removed and createdUserIds set to outsider U
          const bypassState: any = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            createdUserIds: [outsiderId],
            createdRoleIds: ['UNRELATED_ROLE'],
            createdGrants: [{ userId: outsiderId, roleId: 'UNRELATED_ROLE' }],
            createdSessionIds: ['outsider_sess'],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(bypassState, null, 2), { mode: 0o600 });

          // readAndValidateStateFile rejects
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`, testBaseUsername)
          ).rejects.toThrow(/missing or invalid maintainer descriptor/);

          // cleanupTestIdentities rejects before issuing any DELETE
          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/missing or invalid maintainer descriptor/);

          // Verify no DELETE query was executed
          const deleteCalls = mockDb.query.mock.calls.filter((c: any) =>
            typeof c[0] === 'string' && c[0].trim().startsWith('DELETE')
          );
          expect(deleteCalls.length).toBe(0);

          // U, its grant, session and role survive unchanged
          expect(mockDb.users.some((u: any) => u.id === outsiderId)).toBe(true);
          expect(mockDb.userRoles.some((ur: any) => ur.user_id === outsiderId)).toBe(true);
          expect(mockDb.sessions.some((s: any) => s.id === 'outsider_sess')).toBe(true);
          expect(mockDb.roles.some((r: any) => r.id === 'UNRELATED_ROLE')).toBe(true);
        });

        it('O2: rejects when maintainer or standard descriptor is missing, null, non-object, or incomplete', async () => {
          const baseState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };

          // 1. Missing maintainer
          const noMaintainer = { ...baseState };
          delete (noMaintainer as any).maintainer;
          await fs.writeFile(tempStateFile, JSON.stringify(noMaintainer, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/missing or invalid maintainer descriptor/);

          // 2. Missing standard
          const noStandard = { ...baseState };
          delete (noStandard as any).standard;
          await fs.writeFile(tempStateFile, JSON.stringify(noStandard, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/missing or invalid standard descriptor/);

          // 3. Null descriptor
          const nullMaintainer = { ...baseState, maintainer: null };
          await fs.writeFile(tempStateFile, JSON.stringify(nullMaintainer, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/missing or invalid maintainer descriptor/);

          // 4. Non-object descriptor
          const nonObjStandard = { ...baseState, standard: 'not_an_object' };
          await fs.writeFile(tempStateFile, JSON.stringify(nonObjStandard, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/missing or invalid standard descriptor/);

          // 5. Missing required fields (empty username)
          const emptyUser = { ...baseState, maintainer: { id: 'm1', username: '', role: 'SYSTEM_MAINTAINER' } };
          await fs.writeFile(tempStateFile, JSON.stringify(emptyUser, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/missing maintainer username/);
        });

        it('O3: rejects extra created-user ID, duplicate IDs, descriptor ID absent from createdUserIds, or outsider grant', async () => {
          const baseState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };

          // 1. Extra created-user ID
          const extraUser = { ...baseState, createdUserIds: ['m1', 's1', 'extra_user'] };
          await fs.writeFile(tempStateFile, JSON.stringify(extraUser, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/createdUserIds contains unowned user ID "extra_user"/);

          // 2. Duplicate user IDs
          const duplicateUser = { ...baseState, createdUserIds: ['m1', 's1', 'm1'] };
          await fs.writeFile(tempStateFile, JSON.stringify(duplicateUser, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/duplicate user ID "m1" in createdUserIds/);

          // 3. Descriptor ID absent from createdUserIds
          const absentId = { ...baseState, createdUserIds: ['s1'] };
          await fs.writeFile(tempStateFile, JSON.stringify(absentId, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/maintainer ID "m1" not found in createdUserIds/);

          // 4. Grant user outside createdUserIds
          const outsiderGrant = {
            ...baseState,
            createdGrants: [{ userId: 'outsider_id', roleId: 'SYSTEM_MAINTAINER' }],
          };
          await fs.writeFile(tempStateFile, JSON.stringify(outsiderGrant, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/grant user "outsider_id" does not belong to run-owned identities/);
        });

        it('O4: rejects missing/mismatched configured baseUsername or altered descriptor username', async () => {
          const state: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: 'tampered_maintainer', role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

          // readAndValidateStateFile rejects tampered descriptor username against expectedBaseUsername
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`, testBaseUsername)
          ).rejects.toThrow(/State maintainer username mismatch/);

          // cleanupTestIdentities rejects missing baseUsername
          const mockDb = createMockDb();
          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/FOUNDATION_TEST_USERNAME or baseUsername is required/);
        });

        it('O5: rejects when DB username differs from expected name, but allows already-deleted rows for recovery', async () => {
          const state: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

          // 1. Database row has unexpected username: MUST reject and preserve DB
          const mockDbMismatch = createMockDb();
          mockDbMismatch.users.push(
            { id: 'm1', username: 'hijacked_name', password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );
          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDbMismatch,
            })
          ).rejects.toThrow(/Database ownership mismatch/);
          expect(mockDbMismatch.users.length).toBe(2);

          // 2. Already-deleted row: missing row from DB is safely accepted for idempotent recovery
          const mockDbPartial = createMockDb();
          mockDbPartial.users.push(
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );
          const partialRes = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDbPartial,
          });
          expect(partialRes.cleaned).toBe(true);
          expect(partialRes.usersRemoved).toBe(1);
        });

        it('O6: rejects injected outsider session before deletion and restricts SQL predicates to owned identities', async () => {
          const outsiderId = '99999999-9999-4000-8000-999999999999';
          const state: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [{ userId: 'm1', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: ['outsider_session_only'],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });

          const mockDb = createMockDb();
          mockDb.users.push(
            { id: 'm1', username: `${testBaseUsername}_maintainer`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: 's1', username: `${testBaseUsername}_standard`, password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() },
            { id: outsiderId, username: 'outsider', password_hash: 'h', is_active: true, created_at: new Date(), updated_at: new Date() }
          );
          mockDb.sessions.push({
            id: 'outsider_session_only',
            user_id: outsiderId,
            expires_at: new Date(Date.now() + 3600000),
            created_at: new Date(),
          });

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/Inconsistent session ownership/);

          expect(mockDb.sessions.length).toBe(1);
          expect(mockDb.users.length).toBe(3);
        });

        it('O7: rejects unauthorized role claim in createdRoleIds, and preserves preexisting SYSTEM_MAINTAINER', async () => {
          // 1. Injected unrelated role R
          const badRoleState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['UNRELATED_ROLE'],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(badRoleState, null, 2), { mode: 0o600 });
          await expect(
            readAndValidateStateFile(tempStateFile, testRunId, expectedDbName, `127.0.0.1:5432/${expectedDbName}`)
          ).rejects.toThrow(/createdRoleIds contains unprovable or unauthorized role "UNRELATED_ROLE"/);

          // 2. Preexisting SYSTEM_MAINTAINER: createdRoleIds is empty
          const preexistingRoleState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: [],
            createdGrants: [{ userId: 'm1', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(preexistingRoleState, null, 2), { mode: 0o600 });

          const mockDb = createMockDbWithFixture(preexistingRoleState);
          const res = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          });

          expect(res.cleaned).toBe(true);
          expect(res.rolesRemoved).toBe(0); // Did NOT delete preexisting role
          expect(mockDb.roles.some((r: any) => r.id === 'SYSTEM_MAINTAINER')).toBe(true);
        });

        it('O8: removes only proven fixture resources, preserves outsider resources, and repeats safely', async () => {
          const state: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['SYSTEM_MAINTAINER'],
            createdGrants: [{ userId: 'm1', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: ['sess_maintainer'],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
          const mockDb = createMockDbWithFixture(state);

          // 1. Initial cleanup
          const res1 = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          });
          expect(res1.cleaned).toBe(true);
          expect(res1.usersRemoved).toBe(2);
          expect(res1.grantsRemoved).toBe(1);
          expect(res1.rolesRemoved).toBe(1);
          expect(res1.sessionsRemoved).toBe(1);
          expect(fsSync.existsSync(tempStateFile)).toBe(false);

          // Unrelated user, role, and session survived
          expect(mockDb.users.some((u: any) => u.username === 'unrelated_user')).toBe(true);
          expect(mockDb.roles.some((r: any) => r.id === 'ADMINISTRATOR')).toBe(true);
          expect(mockDb.sessions.some((s: any) => s.id === 'sess_unrelated')).toBe(true);

          // 2. Repeated cleanup
          const res2 = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          });
          expect(res2.cleaned).toBe(false);
          expect(res2.reason).toBe('NO_STATE_FILE');
        });

        it('O9: recovers partial state safely and handles empty initializing records', async () => {
          // 1. Empty initializing record
          const initRecord: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'initializing',
            maintainer: { id: '', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: '', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: [],
            createdRoleIds: [],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await fs.writeFile(tempStateFile, JSON.stringify(initRecord, null, 2), { mode: 0o600 });
          const mockDb = createMockDb();

          const initRes = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          });
          expect(initRes.cleaned).toBe(false);
          expect(initRes.reason).toBe('EMPTY_INITIALIZING_RECORD');
          expect(fsSync.existsSync(tempStateFile)).toBe(false);
        });

        it('O10: recovers committed owned rows from an uncertain record', async () => {
          const uncertainState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'uncertain',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['SYSTEM_MAINTAINER'],
            createdGrants: [{ userId: 'm1', roleId: 'SYSTEM_MAINTAINER' }],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
            error: 'Simulated ACK loss',
          };
          await fs.writeFile(tempStateFile, JSON.stringify(uncertainState, null, 2), { mode: 0o600 });
          const mockDb = createMockDbWithFixture(uncertainState);

          const res = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDb,
          });

          expect(res.cleaned).toBe(true);
          expect(res.usersRemoved).toBe(2);
          expect(fsSync.existsSync(tempStateFile)).toBe(false);
        });
      });

      describe('10.2 P2 Acceptance Cases (T1–T7)', () => {
        it('T1: applies 5,000ms lock timeout and 10,000ms statement timeout when overrides are absent', () => {
          expect(parseTimeoutMs(undefined, undefined, DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeout')).toBe(5000);
          expect(parseTimeoutMs(undefined, undefined, DEFAULT_STATEMENT_TIMEOUT_MS, 'statementTimeout')).toBe(10000);
        });

        it('T2: accepts valid numeric options and environment strings at boundaries (1, 1000, 60000)', () => {
          for (const val of [1, 1000, 60000]) {
            expect(parseTimeoutMs(val, undefined, 5000, 'lockTimeout')).toBe(val);
            expect(parseTimeoutMs(undefined, String(val), 5000, 'lockTimeout')).toBe(val);
          }
        });

        it('T3: rejects invalid numeric options (0, -1, 1.5, NaN, Inf, 60001, overflow, null, booleans, objects, strings)', () => {
          const invalidNumbers = [0, -1, 1.5, NaN, Infinity, -Infinity, 60001, 2147483648, Number.MAX_SAFE_INTEGER];
          for (const num of invalidNumbers) {
            expect(() => parseTimeoutMs(num, undefined, 5000, 'lockTimeout')).toThrow();
          }
          const invalidTypes = [null, true, false, {}, '1000'];
          for (const t of invalidTypes) {
            expect(() => parseTimeoutMs(t, undefined, 5000, 'lockTimeout')).toThrow();
          }
        });

        it('T4: rejects invalid environment strings without permissive parsing or coercion', () => {
          const invalidEnv = [
            '0', '-1', '1.5', 'NaN', 'Infinity', '60001', '2147483648',
            '', '   ', '1000junk', '1000ms', '1e3', '0x10', '+1000', ' 1000 ',
          ];
          for (const envVal of invalidEnv) {
            expect(() => parseTimeoutMs(undefined, envVal, 5000, 'lockTimeout')).toThrow();
          }
        });

        it('T5: rejects environment variables set to 0 immediately without calling DB or issuing DELETE', async () => {
          const mockDb = createMockDb();
          process.env.FOUNDATION_LOCK_TIMEOUT_MS = '0';
          process.env.FOUNDATION_STATEMENT_TIMEOUT_MS = '0';

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
            })
          ).rejects.toThrow(/Invalid lockTimeout environment value "0"/);

          expect(mockDb.query).not.toHaveBeenCalled();
          delete process.env.FOUNDATION_LOCK_TIMEOUT_MS;
          delete process.env.FOUNDATION_STATEMENT_TIMEOUT_MS;
        });

        it('T6: handles lock contention timeout (55P03) by rolling back and preserving state file', async () => {
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['SYSTEM_MAINTAINER'],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          const mockDb = createMockDbWithFixture(validState);
          const origQuery = mockDb.query;
          mockDb.query = vi.fn(async (sql: string, params: any[]) => {
            if (sql.includes('LOCK TABLE')) {
              const err = new Error('canceling statement due to lock timeout');
              (err as any).code = '55P03';
              throw err;
            }
            return origQuery(sql, params);
          });

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDb,
              lockTimeoutMs: 1000,
              statementTimeoutMs: 2500,
            })
          ).rejects.toThrow(/canceling statement due to lock timeout/);

          expect(fsSync.existsSync(tempStateFile)).toBe(true);
          const rollbackCalls = mockDb.query.mock.calls.filter((c: any) =>
            typeof c[0] === 'string' && c[0].includes('ROLLBACK')
          );
          expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
        });

        it('T7: handles statement timeout (57014) by rolling back, preserving state, and subsequent retry succeeds', async () => {
          const validState: TestIdentityState = {
            runId: testRunId,
            database: expectedDbName,
            targetEndpoint: `127.0.0.1:5432/${expectedDbName}`,
            status: 'active',
            maintainer: { id: 'm1', username: `${testBaseUsername}_maintainer`, role: 'SYSTEM_MAINTAINER' },
            standard: { id: 's1', username: `${testBaseUsername}_standard`, role: null },
            createdUserIds: ['m1', 's1'],
            createdRoleIds: ['SYSTEM_MAINTAINER'],
            createdGrants: [],
            createdSessionIds: [],
            createdAt: new Date().toISOString(),
          };
          await writeStateFileAtomic(tempStateFile, validState);

          const mockDbWithFixture = createMockDbWithFixture(validState);

          // Simulate statement timeout on SELECT id, username FROM users
          let failWithTimeout = true;
          const origQuery = mockDbWithFixture.query;
          mockDbWithFixture.query = vi.fn(async (sql: string, params: any[]) => {
            if (failWithTimeout && sql.includes('SELECT id, username FROM users')) {
              const err = new Error('canceling statement due to statement timeout');
              (err as any).code = '57014';
              throw err;
            }
            return origQuery(sql, params);
          });

          await expect(
            cleanupTestIdentities({
              nodeEnv: 'test',
              databaseUrl: validDbUrl,
              expectedDb: expectedDbName,
              runId: testRunId,
              baseUsername: testBaseUsername,
              stateFile: tempStateFile,
              db: mockDbWithFixture,
              statementTimeoutMs: 1000,
            })
          ).rejects.toThrow(/canceling statement due to statement timeout/);

          // State preserved after timeout failure
          expect(fsSync.existsSync(tempStateFile)).toBe(true);

          // Retry after transient condition resolves: succeeds
          failWithTimeout = false;
          const retryRes = await cleanupTestIdentities({
            nodeEnv: 'test',
            databaseUrl: validDbUrl,
            expectedDb: expectedDbName,
            runId: testRunId,
            baseUsername: testBaseUsername,
            stateFile: tempStateFile,
            db: mockDbWithFixture,
          });

          expect(retryRes.cleaned).toBe(true);
          expect(fsSync.existsSync(tempStateFile)).toBe(false);
        });
      });
    });
  });
});
