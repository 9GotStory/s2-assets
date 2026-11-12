import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { runMigrator } from '../../../../packages/db/src/migrator.ts';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.resolve(__dirname, '../../../../packages/db/src/migrations');

const dbRequire = createRequire(migrationFolder);
const { Kysely, PostgresDialect, sql } = dbRequire('kysely');

describe('Native Kysely Transaction Integration Tests (T027 - US3)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let writerPool: pg.Pool;
  let observerPool: pg.Pool;
  let writerDb: any;
  let observerDb: any;

  // Track test-owned identifiers for deterministic, isolated cleanup
  const cleanupUserIds: string[] = [];
  const cleanupRoleIds: string[] = [];

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

    // Apply 0001_foundation migration
    const migrationResult = await runMigrator({
      command: 'latest',
      databaseUrl,
      migrationFolder,
    });
    expect(migrationResult.error).toBeUndefined();

    // Establish writer pool and native Kysely writer instance
    writerPool = new Pool({
      connectionString: databaseUrl,
      max: 10,
    });
    writerDb = new Kysely({
      dialect: new PostgresDialect({
        pool: writerPool,
      }),
    });

    // Establish independent observer pool and Kysely observer instance
    observerPool = new Pool({
      connectionString: databaseUrl,
      max: 5,
    });
    observerDb = new Kysely({
      dialect: new PostgresDialect({
        pool: observerPool,
      }),
    });
  }, 90_000);

  afterAll(async () => {
    if (writerDb) {
      await writerDb.destroy().catch(() => {});
    }
    if (observerDb) {
      await observerDb.destroy().catch(() => {});
    }
    if (writerPool) {
      await writerPool.end().catch(() => {});
    }
    if (observerPool) {
      await observerPool.end().catch(() => {});
    }
    if (container) {
      await container.stop().catch(() => {});
    }
  });

  beforeEach(() => {
    cleanupUserIds.length = 0;
    cleanupRoleIds.length = 0;
  });

  afterEach(async () => {
    // Clean only records explicitly owned by the test; do not truncate unrelated records
    if (cleanupUserIds.length > 0) {
      await observerPool
        .query('DELETE FROM users WHERE id = ANY($1::uuid[])', [cleanupUserIds])
        .catch(() => {});
    }
    if (cleanupRoleIds.length > 0) {
      await observerPool
        .query('DELETE FROM roles WHERE id = ANY($1::varchar[])', [cleanupRoleIds])
        .catch(() => {});
    }
  });

  it('verifies writer and observer use independently established PostgreSQL connections', async () => {
    let writerPid: number | undefined;
    await writerDb.transaction().execute(async (trx: any) => {
      const res = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      writerPid = Number(res.rows[0].pid);
    });

    const observerRes = await observerPool.query('SELECT pg_backend_pid() AS pid');
    const observerPid = Number(observerRes.rows[0].pid);

    expect(writerPid).toBeDefined();
    expect(observerPid).toBeDefined();
    expect(writerPid).not.toBe(observerPid);
  });

  it('Case A: commits multiple valid writes atomically and verifies them via independent observer', async () => {
    const userId = crypto.randomUUID();
    const username = `tx_success_${crypto.randomUUID().slice(0, 8)}`;
    const roleId = `ROLE_SUCCESS_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    cleanupUserIds.push(userId);
    cleanupRoleIds.push(roleId);

    // Execute native Kysely transaction with multiple valid writes
    await writerDb.transaction().execute(async (trx: any) => {
      // Write 1: insert user
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username,
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$validhash',
          is_active: true,
        })
        .execute();

      // Write 2: insert role
      await trx
        .insertInto('roles')
        .values({
          id: roleId,
          description: 'Successfully committed test role',
        })
        .execute();

      // Write 3: insert user_role association
      await trx
        .insertInto('user_roles')
        .values({
          user_id: userId,
          role_id: roleId,
        })
        .execute();
    });

    // Authoritative verification via independent observer connection
    const observerUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    expect(observerUser).toBeDefined();
    expect(observerUser.username).toBe(username);
    expect(observerUser.is_active).toBe(true);

    const observerRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', roleId)
      .executeTakeFirst();

    expect(observerRole).toBeDefined();
    expect(observerRole.description).toBe('Successfully committed test role');

    const observerUserRole = await observerDb
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .where('role_id', '=', roleId)
      .executeTakeFirst();

    expect(observerUserRole).toBeDefined();
    expect(observerUserRole.user_id).toBe(userId);
    expect(observerUserRole.role_id).toBe(roleId);
  });

  it('Case B: rolls back all writes on deliberate error after intermediate writes leaving zero partial state', async () => {
    const userId = crypto.randomUUID();
    const username = `tx_fail_${crypto.randomUUID().slice(0, 8)}`;
    const roleId = `ROLE_FAIL_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    cleanupUserIds.push(userId);
    cleanupRoleIds.push(roleId);

    // Precondition check via independent observer: entities do not exist
    const preUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(preUser).toBeUndefined();

    const preRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', roleId)
      .executeTakeFirst();
    expect(preRole).toBeUndefined();

    // Execute native Kysely transaction that performs multiple valid writes then throws
    const txPromise = writerDb.transaction().execute(async (trx: any) => {
      // Write 1: insert user
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username,
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$failhash',
          is_active: true,
        })
        .execute();

      // Write 2: insert role
      await trx
        .insertInto('roles')
        .values({
          id: roleId,
          description: 'Role written before deliberate failure',
        })
        .execute();

      // Write 3: insert user_role association
      await trx
        .insertInto('user_roles')
        .values({
          user_id: userId,
          role_id: roleId,
        })
        .execute();

      // Deliberately throw after intermediate writes
      throw new Error('DELIBERATE_ABORT_AFTER_INTERMEDIATE_WRITES');
    });

    // Assert that the native transaction rejects with the deliberate error
    await expect(txPromise).rejects.toThrow('DELIBERATE_ABORT_AFTER_INTERMEDIATE_WRITES');

    // Independent observer queries to prove zero partial committed state
    const postUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(postUser).toBeUndefined();

    const postRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', roleId)
      .executeTakeFirst();
    expect(postRole).toBeUndefined();

    const postUserRole = await observerDb
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    expect(postUserRole).toBeUndefined();

    // Raw independent observer pool verification
    const rawUserCheck = await observerPool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(rawUserCheck.rows).toHaveLength(0);

    const rawRoleCheck = await observerPool.query('SELECT * FROM roles WHERE id = $1', [roleId]);
    expect(rawRoleCheck.rows).toHaveLength(0);

    const rawUserRoleCheck = await observerPool.query(
      'SELECT * FROM user_roles WHERE user_id = $1 OR role_id = $2',
      [userId, roleId]
    );
    expect(rawUserRoleCheck.rows).toHaveLength(0);
  });

  it('Case C: proves uncommitted transactional writes remain invisible to independent observer until commit', async () => {
    const userId = crypto.randomUUID();
    const username = `tx_iso_${crypto.randomUUID().slice(0, 8)}`;
    const roleId = `ROLE_ISO_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    cleanupUserIds.push(userId);
    cleanupRoleIds.push(roleId);

    let signalWritesDone: () => void = () => {};
    const writesDonePromise = new Promise<void>((resolve) => {
      signalWritesDone = resolve;
    });

    let signalCommitPermitted: () => void = () => {};
    const commitPermittedPromise = new Promise<void>((resolve) => {
      signalCommitPermitted = resolve;
    });

    // Start native Kysely transaction asynchronously
    const txPromise = writerDb.transaction().execute(async (trx: any) => {
      // Write 1: insert user
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username,
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$isohash',
          is_active: true,
        })
        .execute();

      // Write 2: insert role
      await trx
        .insertInto('roles')
        .values({
          id: roleId,
          description: 'Uncommitted role during isolation check',
        })
        .execute();

      // Signal that intermediate writes have completed inside the active transaction
      signalWritesDone();

      // Wait for observer to perform isolation verification before committing
      await commitPermittedPromise;
    });

    // Wait for the transaction to complete intermediate writes
    await writesDonePromise;

    // Verification 1: While transaction is OPEN and uncommitted, independent observer MUST see 0 rows
    const uncommittedUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(uncommittedUser).toBeUndefined();

    const uncommittedRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', roleId)
      .executeTakeFirst();
    expect(uncommittedRole).toBeUndefined();

    // Raw observer pool query also confirms invisibility
    const uncommittedRawCheck = await observerPool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    expect(uncommittedRawCheck.rows).toHaveLength(0);

    // Permit the transaction to commit
    signalCommitPermitted();
    await txPromise;

    // Verification 2: After commit, independent observer MUST see the committed rows
    const committedUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(committedUser).toBeDefined();
    expect(committedUser.username).toBe(username);

    const committedRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', roleId)
      .executeTakeFirst();
    expect(committedRole).toBeDefined();
    expect(committedRole.description).toBe('Uncommitted role during isolation check');
  });

  it('Case D1: rolls back earlier successful writes when a subsequent write triggers a PostgreSQL foreign key constraint violation', async () => {
    const userId = crypto.randomUUID();
    const username = `tx_fk_${crypto.randomUUID().slice(0, 8)}`;
    const nonExistentRoleId = `NONEXISTENT_ROLE_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

    cleanupUserIds.push(userId);

    // Transaction attempts:
    // Write 1: insert valid user (valid write, succeeds in transaction)
    // Write 2: insert into user_roles with nonExistentRoleId (triggers foreign key violation)
    const txPromise = writerDb.transaction().execute(async (trx: any) => {
      // Write 1: valid insert
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username,
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$fkhash',
          is_active: true,
        })
        .execute();

      // Write 2: invalid foreign key reference (nonExistentRoleId does not exist in roles table)
      await trx
        .insertInto('user_roles')
        .values({
          user_id: userId,
          role_id: nonExistentRoleId,
        })
        .execute();
    });

    // Assert transaction rejects with PostgreSQL foreign key constraint violation (error code 23503)
    await expect(txPromise).rejects.toMatchObject({
      code: '23503',
    });

    // Independent observer verifies that Write 1 (the valid user) was rolled back
    const observerUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(observerUser).toBeUndefined();

    const observerUserRoles = await observerDb
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(observerUserRoles).toHaveLength(0);

    const rawUserCheck = await observerPool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(rawUserCheck.rows).toHaveLength(0);
  });

  it('Case D2: rolls back earlier successful writes when a subsequent write triggers a PostgreSQL unique constraint violation', async () => {
    const existingUserId = crypto.randomUUID();
    const existingUsername = `existing_user_${crypto.randomUUID().slice(0, 8)}`;
    const newRoleId = `ROLE_UNIQUE_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const duplicateUserId = crypto.randomUUID();

    cleanupUserIds.push(existingUserId, duplicateUserId);
    cleanupRoleIds.push(newRoleId);

    // Pre-insert an existing user into the database
    await observerPool.query(
      `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW())`,
      [existingUserId, existingUsername, '$argon2id$v=19$m=65536,t=3,p=4$dummy$existing']
    );

    // Transaction attempts:
    // Write 1: insert valid role (succeeds in transaction)
    // Write 2: insert user with duplicate username (triggers unique constraint violation)
    const txPromise = writerDb.transaction().execute(async (trx: any) => {
      // Write 1: valid role insert
      await trx
        .insertInto('roles')
        .values({
          id: newRoleId,
          description: 'Role inserted before unique constraint violation',
        })
        .execute();

      // Write 2: duplicate username on users table
      await trx
        .insertInto('users')
        .values({
          id: duplicateUserId,
          username: existingUsername, // DUPLICATE username
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$duphash',
          is_active: true,
        })
        .execute();
    });

    // Assert transaction rejects with PostgreSQL unique violation error (code 23505)
    await expect(txPromise).rejects.toMatchObject({
      code: '23505',
    });

    // Independent observer verifies that Write 1 (newRoleId) was rolled back
    const observerRole = await observerDb
      .selectFrom('roles')
      .selectAll()
      .where('id', '=', newRoleId)
      .executeTakeFirst();
    expect(observerRole).toBeUndefined();

    // Existing user remains intact and unaffected
    const existingUserCheck = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', existingUserId)
      .executeTakeFirst();
    expect(existingUserCheck).toBeDefined();
    expect(existingUserCheck.username).toBe(existingUsername);
  });

  it('Case E: verifies multi-table transaction rollback across users and sessions leaving no orphaned records', async () => {
    const userId = crypto.randomUUID();
    const username = `tx_sess_${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = `sess_${crypto.randomUUID().slice(0, 16)}`;

    cleanupUserIds.push(userId);

    const txPromise = writerDb.transaction().execute(async (trx: any) => {
      // Write 1: insert user
      await trx
        .insertInto('users')
        .values({
          id: userId,
          username,
          password_hash: '$argon2id$v=19$m=65536,t=3,p=4$dummy$sesshash',
          is_active: true,
        })
        .execute();

      // Write 2: insert session
      await trx
        .insertInto('sessions')
        .values({
          id: sessionId,
          user_id: userId,
          expires_at: new Date(Date.now() + 86400000),
        })
        .execute();

      throw new Error('ROLLBACK_SESSION_TRANSACTION');
    });

    await expect(txPromise).rejects.toThrow('ROLLBACK_SESSION_TRANSACTION');

    // Independent observer verification
    const observerUser = await observerDb
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(observerUser).toBeUndefined();

    const observerSession = await observerDb
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    expect(observerSession).toBeUndefined();
  });
});
