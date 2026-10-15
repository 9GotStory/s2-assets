import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { UserService } from '../../src/services/user.service.ts';
import { CapabilityService } from '../../src/services/capability.service.ts';

const { Pool } = pg;

export interface TestIdentityUser {
  id: string;
  username: string;
  role: string | null;
}

export interface TestIdentityGrant {
  userId: string;
  roleId: string;
}

export interface TestIdentityState {
  runId: string;
  database: string;
  targetEndpoint?: string;
  status: 'active' | 'partial' | 'initializing';
  maintainer: TestIdentityUser;
  standard: TestIdentityUser;
  createdUserIds: string[];
  createdRoleIds: string[];
  createdGrants: TestIdentityGrant[];
  createdSessionIds: string[];
  createdAt: string;
}

export interface IdentitySetupOptions {
  databaseUrl?: string;
  runId?: string;
  baseUsername?: string;
  password?: string;
  stateFile?: string;
  nodeEnv?: string;
  expectedDb?: string;
  db?: any;
}

export interface IdentityCleanupOptions {
  databaseUrl?: string;
  runId?: string;
  stateFile?: string;
  nodeEnv?: string;
  expectedDb?: string;
  db?: any;
}

export interface IdentityCleanupResult {
  cleaned: boolean;
  runId?: string;
  database?: string;
  usersRemoved: number;
  grantsRemoved: number;
  rolesRemoved: number;
  sessionsRemoved: number;
  reason?: string;
}

/**
 * Loads environment variables from an env file without altering raw values.
 */
export function loadEnvFile(filePath: string): void {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const content = fsSync.readFileSync(filePath, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.trim().startsWith('#')) continue;
      const cleanLine = line.startsWith('export ') ? line.slice(7) : line;
      const eqIdx = cleanLine.indexOf('=');
      if (eqIdx === -1) continue;
      const key = cleanLine.slice(0, eqIdx).trim();
      let val = cleanLine.slice(eqIdx + 1);
      if (
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Silently ignore file read errors; validation will catch missing keys
  }
}

/**
 * Loads configuration from either a JSON configuration file (lossless) or an env file.
 */
export function loadConfigFile(filePath: string): void {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const content = fsSync.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.json')) {
      const data = JSON.parse(content);
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'string' && val.length > 0) {
          process.env[key] = val;
        }
      }
    } else {
      loadEnvFile(filePath);
    }
  } catch {
    // Silently ignore read errors
  }
}

// Auto-load private runner config or foundation env file if provided
if (process.env.FOUNDATION_FIXTURE_CONFIG_FILE) {
  loadConfigFile(process.env.FOUNDATION_FIXTURE_CONFIG_FILE);
} else if (process.env.FOUNDATION_FIXTURE_ENV_FILE) {
  loadConfigFile(process.env.FOUNDATION_FIXTURE_ENV_FILE);
} else if (process.env.FOUNDATION_ENV_FILE) {
  loadConfigFile(process.env.FOUNDATION_ENV_FILE);
}

/**
 * Validates the database target without leaking any connection credentials.
 */
export function validateTargetDatabase(
  databaseUrl: string | undefined,
  expectedDb?: string
): { dbName: string; targetEndpoint: string } {
  if (!databaseUrl || typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new Error('Database URL is required and must be a non-empty string');
  }

  if (!expectedDb || typeof expectedDb !== 'string' || expectedDb.trim().length === 0) {
    throw new Error('Expected database name is required for target verification');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid database URL format');
  }

  if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
    throw new Error('Invalid database protocol: expected postgresql:');
  }

  const queryHost = parsedUrl.searchParams.get('host');
  const effectiveHost = (queryHost || parsedUrl.hostname).toLowerCase();
  const urlHostname = parsedUrl.hostname.toLowerCase();

  const isProdHost = (host: string): boolean =>
    host.includes('prod') ||
    host.includes('production') ||
    host.includes('s2.internal') ||
    host.includes('aws') ||
    host.includes('rds') ||
    host.includes('azure') ||
    host.includes('cloudsql');

  if (isProdHost(urlHostname) || isProdHost(effectiveHost)) {
    throw new Error(`Production database target is prohibited (host: ${effectiveHost || urlHostname})`);
  }

  if (!effectiveHost || effectiveHost.trim().length === 0) {
    throw new Error('Database URL host is required');
  }

  const queryPort = parsedUrl.searchParams.get('port');
  const effectivePort = parsedUrl.port || queryPort || '5432';

  const dbName = parsedUrl.pathname.replace(/^\//, '');
  if (!dbName || dbName.trim().length === 0) {
    throw new Error('Database name is required in database URL');
  }

  if (!/^s2_foundation_[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Database target must begin with "s2_foundation_" (got "${dbName}")`);
  }

  if (
    dbName === 's2_assets' ||
    dbName === 's2_foundation_s2_assets' ||
    dbName === 'postgres' ||
    dbName === 'default'
  ) {
    throw new Error(`Database target cannot be default or shared database "${dbName}"`);
  }

  if (dbName !== expectedDb) {
    throw new Error(
      `Database target mismatch: URL database "${dbName}" does not match expected "${expectedDb}"`
    );
  }

  const targetEndpoint = `${effectiveHost}:${effectivePort}/${dbName}`;
  return { dbName, targetEndpoint };
}

/**
 * Validates private directory permissions (must be mode 700 / ending in 00).
 */
function validatePrivateDirectory(dirPath: string): void {
  try {
    const st = fsSync.statSync(dirPath);
    const mode = (st.mode & 0o777).toString(8);
    const tail = mode.slice(-2);
    if (tail !== '00') {
      throw new Error(
        `Insecure permissions on state directory "${dirPath}": mode must be 700 (got ${mode})`
      );
    }
  } catch (err: any) {
    if (err.message.includes('Insecure permissions')) {
      throw err;
    }
    // If stat fails, creation will handle it
  }
}

/**
 * Creates disposable test identities in the target isolated database.
 */
export async function setupTestIdentities(
  options: IdentitySetupOptions = {}
): Promise<TestIdentityState> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv !== 'test') {
    throw new Error(
      `Fixture operations are strictly restricted to NODE_ENV=test (got "${nodeEnv}")`
    );
  }

  const runId = options.runId ?? process.env.FOUNDATION_TEST_RUN_ID;
  if (!runId || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(
      'FOUNDATION_TEST_RUN_ID is required and must be alphanumeric with hyphens or underscores'
    );
  }

  const databaseUrl = options.databaseUrl ?? process.env.FOUNDATION_TEST_DATABASE_URL;
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    throw new Error('FOUNDATION_TEST_DATABASE_URL is required');
  }

  const expectedDb = options.expectedDb ?? process.env.POSTGRES_DB;
  if (!expectedDb || typeof expectedDb !== 'string') {
    throw new Error('POSTGRES_DB or expectedDb is required for target verification');
  }

  const { dbName, targetEndpoint } = validateTargetDatabase(databaseUrl, expectedDb);

  const baseUsername = options.baseUsername ?? process.env.FOUNDATION_TEST_USERNAME;
  if (!baseUsername || typeof baseUsername !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(baseUsername)) {
    throw new Error(
      'FOUNDATION_TEST_USERNAME is required and must be alphanumeric with hyphens or underscores'
    );
  }

  const password = options.password ?? process.env.FOUNDATION_TEST_PASSWORD;
  if (!password || typeof password !== 'string') {
    throw new Error('FOUNDATION_TEST_PASSWORD is required');
  }
  const nonWsPassword = password.replace(/\s/g, '');
  if (nonWsPassword.length < 8) {
    throw new Error('FOUNDATION_TEST_PASSWORD must contain at least 8 non-whitespace characters');
  }
  const trimmedPw = password.trim();
  if (
    trimmedPw === 'password' ||
    trimmedPw === 'test' ||
    trimmedPw === 'admin' ||
    trimmedPw === 's2_password'
  ) {
    throw new Error('FOUNDATION_TEST_PASSWORD cannot use default or trivial passwords');
  }

  let stateFile = options.stateFile ?? process.env.FOUNDATION_FIXTURE_STATE_FILE;
  if (!stateFile && process.env.FOUNDATION_ENV_FILE) {
    stateFile = path.join(
      path.dirname(process.env.FOUNDATION_ENV_FILE),
      `fixture-state-${runId}.json`
    );
  }
  if (!stateFile) {
    throw new Error('FOUNDATION_FIXTURE_STATE_FILE is required for ownership tracking');
  }

  const stateDir = path.dirname(stateFile);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  validatePrivateDirectory(stateDir);

  // Check existing state file: never overwrite existing active or partial record
  if (fsSync.existsSync(stateFile)) {
    const st = fsSync.statSync(stateFile);
    if (st.isDirectory()) {
      throw new Error(`State file path is a directory (EISDIR): "${stateFile}". Failing closed.`);
    }
    throw new Error(
      `Existing fixture state record found at "${stateFile}". Cannot overwrite active or partial ownership record. Run cleanup first.`
    );
  }

  const maintainerUsername = `${baseUsername}_maintainer`;
  const standardUsername = `${baseUsername}_standard`;

  // Reserve state file atomically with 'wx' before initiating any database mutations
  let reservationHandle: fs.FileHandle;
  try {
    reservationHandle = await fs.open(stateFile, 'wx', 0o600);
  } catch (openErr: any) {
    throw new Error(`Failed to reserve fixture state file "${stateFile}": ${openErr.message}`);
  }

  const initialReservation: TestIdentityState = {
    runId,
    database: dbName,
    targetEndpoint,
    status: 'initializing',
    maintainer: {
      id: '',
      username: maintainerUsername,
      role: 'SYSTEM_MAINTAINER',
    },
    standard: {
      id: '',
      username: standardUsername,
      role: null,
    },
    createdUserIds: [],
    createdRoleIds: [],
    createdGrants: [],
    createdSessionIds: [],
    createdAt: new Date().toISOString(),
  };

  await reservationHandle.writeFile(JSON.stringify(initialReservation, null, 2), {
    encoding: 'utf-8',
  });
  await reservationHandle.close();

  const pool = options.db ?? new Pool({ connectionString: databaseUrl });
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;

  const createdUserIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdGrants: TestIdentityGrant[] = [];
  const createdSessionIds: string[] = [];

  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    // 1. Conflict check: verify that target usernames do not already exist
    const existingRes = await client.query(
      'SELECT id, username FROM users WHERE username = $1 OR username = $2',
      [maintainerUsername, standardUsername]
    );
    if (existingRes.rows && existingRes.rows.length > 0) {
      const existingNames = existingRes.rows.map((r: any) => r.username).join(', ');
      throw new Error(
        `Conflicting preexisting test identities found: ${existingNames}. Aborting setup without mutation.`
      );
    }

    // 2. Ensure role 'SYSTEM_MAINTAINER' exists in roles table
    const roleCheck = await client.query('SELECT id FROM roles WHERE id = $1', ['SYSTEM_MAINTAINER']);
    if (!roleCheck.rows || roleCheck.rows.length === 0) {
      await client.query('INSERT INTO roles (id, description) VALUES ($1, $2)', [
        'SYSTEM_MAINTAINER',
        'System maintainer with maintenance capabilities',
      ]);
      createdRoleIds.push('SYSTEM_MAINTAINER');
    }

    // 3. Create maintainer user using UserService (Argon2id)
    const userService = new UserService({ db: client });
    const maintainer = await userService.createUser({
      username: maintainerUsername,
      password,
    });
    createdUserIds.push(maintainer.id);

    // 4. Grant SYSTEM_MAINTAINER role
    await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
      maintainer.id,
      'SYSTEM_MAINTAINER',
    ]);
    createdGrants.push({ userId: maintainer.id, roleId: 'SYSTEM_MAINTAINER' });

    // 5. Create standard user (without system:maintain)
    const standard = await userService.createUser({
      username: standardUsername,
      password,
    });
    createdUserIds.push(standard.id);

    // 6. Verify credentials and capabilities through accepted logic
    const authMaintainer = await userService.verifyCredentials(maintainerUsername, password);
    if (!authMaintainer.valid || !authMaintainer.user) {
      throw new Error('Maintainer credentials verification failed immediately after creation');
    }

    const authStandard = await userService.verifyCredentials(standardUsername, password);
    if (!authStandard.valid || !authStandard.user) {
      throw new Error('Standard credentials verification failed immediately after creation');
    }

    const capService = new CapabilityService({ db: client });
    const maintainerHasCap = await capService.hasCapability(maintainer.id, 'system:maintain');
    if (!maintainerHasCap) {
      throw new Error('Maintainer identity failed capability verification for system:maintain');
    }

    const standardHasCap = await capService.hasCapability(standard.id, 'system:maintain');
    if (standardHasCap) {
      throw new Error('Standard identity unexpectedly possessed system:maintain capability');
    }

    // 7. Write active state record to reserved state file
    const activeState: TestIdentityState = {
      runId,
      database: dbName,
      targetEndpoint,
      status: 'active',
      maintainer: {
        id: maintainer.id,
        username: maintainerUsername,
        role: 'SYSTEM_MAINTAINER',
      },
      standard: {
        id: standard.id,
        username: standardUsername,
        role: null,
      },
      createdUserIds: [...createdUserIds],
      createdRoleIds: [...createdRoleIds],
      createdGrants: [...createdGrants],
      createdSessionIds: [...createdSessionIds],
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(stateFile, JSON.stringify(activeState, null, 2), {
      mode: 0o600,
      encoding: 'utf-8',
    });

    // 8. Commit database transaction only after state is successfully persisted
    await client.query('COMMIT');
    inTransaction = false;

    return activeState;
  } catch (err: any) {
    const primaryError = err;
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback failure preserved
      }
    }
    // Clean up reservation file since transaction was rolled back and no rows exist
    try {
      await fs.unlink(stateFile);
    } catch {
      // Do not mask primary failure
    }
    throw primaryError;
  } finally {
    if (typeof client.release === 'function') {
      client.release();
    }
    if (!options.db) {
      await pool.end().catch(() => {});
    }
  }
}

/**
 * Cleans up run-owned test identities and removes private ownership state.
 */
export async function cleanupTestIdentities(
  options: IdentityCleanupOptions = {}
): Promise<IdentityCleanupResult> {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv !== 'test') {
    throw new Error(
      `Fixture operations are strictly restricted to NODE_ENV=test (got "${nodeEnv}")`
    );
  }

  const runId = options.runId ?? process.env.FOUNDATION_TEST_RUN_ID;
  if (!runId || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(
      'FOUNDATION_TEST_RUN_ID is required and must be alphanumeric with hyphens or underscores'
    );
  }

  const databaseUrl = options.databaseUrl ?? process.env.FOUNDATION_TEST_DATABASE_URL;
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    throw new Error('FOUNDATION_TEST_DATABASE_URL is required');
  }

  const expectedDb = options.expectedDb ?? process.env.POSTGRES_DB;
  if (!expectedDb || typeof expectedDb !== 'string') {
    throw new Error('POSTGRES_DB or expectedDb is required for target verification');
  }

  // Target database validation MUST occur before state-file check
  const { dbName, targetEndpoint } = validateTargetDatabase(databaseUrl, expectedDb);

  let stateFile = options.stateFile ?? process.env.FOUNDATION_FIXTURE_STATE_FILE;
  if (!stateFile && process.env.FOUNDATION_ENV_FILE && runId) {
    stateFile = path.join(
      path.dirname(process.env.FOUNDATION_ENV_FILE),
      `fixture-state-${runId}.json`
    );
  }
  if (!stateFile) {
    throw new Error('FOUNDATION_FIXTURE_STATE_FILE is required for ownership tracking');
  }

  // Safe repeated cleanup: if state file does not exist, return safe no-op
  if (!fsSync.existsSync(stateFile)) {
    return {
      cleaned: false,
      runId,
      database: dbName,
      usersRemoved: 0,
      grantsRemoved: 0,
      rolesRemoved: 0,
      sessionsRemoved: 0,
      reason: 'NO_STATE_FILE',
    };
  }

  const stateDir = path.dirname(stateFile);
  validatePrivateDirectory(stateDir);

  const st = fsSync.statSync(stateFile);
  if (st.isDirectory()) {
    throw new Error(`State file path is a directory (EISDIR): "${stateFile}". Failing closed.`);
  }

  let state: TestIdentityState;
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    state = JSON.parse(raw);
  } catch {
    throw new Error('Corrupted fixture state file: JSON parse failed. Failing closed.');
  }

  // Verify ownership invariants
  if (state.runId !== runId) {
    throw new Error(
      `State file run ID mismatch: expected "${runId}", got "${state.runId}". Failing closed.`
    );
  }

  if (state.database !== dbName) {
    throw new Error(
      `State file database mismatch: expected "${dbName}", got "${state.database}". Failing closed.`
    );
  }

  if (state.targetEndpoint && state.targetEndpoint !== targetEndpoint) {
    throw new Error(
      `State file target mismatch: expected "${targetEndpoint}", got "${state.targetEndpoint}". Failing closed.`
    );
  }

  if (!Array.isArray(state.createdUserIds) || !Array.isArray(state.createdGrants)) {
    throw new Error('Corrupted fixture state file: missing ownership arrays. Failing closed.');
  }

  const pool = options.db ?? new Pool({ connectionString: databaseUrl });
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;

  let sessionsRemoved = 0;
  let grantsRemoved = 0;
  let usersRemoved = 0;
  let rolesRemoved = 0;

  try {
    await client.query('BEGIN');

    // 1. Delete sessions for created users or explicitly tracked sessions
    if (state.createdSessionIds && state.createdSessionIds.length > 0) {
      const sRes = await client.query('DELETE FROM sessions WHERE id = ANY($1)', [
        state.createdSessionIds,
      ]);
      sessionsRemoved += sRes.rowCount ?? 0;
    }
    if (state.createdUserIds && state.createdUserIds.length > 0) {
      const sRes = await client.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [
        state.createdUserIds,
      ]);
      sessionsRemoved += sRes.rowCount ?? 0;
    }

    // 2. Delete composite grants
    if (state.createdGrants && state.createdGrants.length > 0) {
      for (const g of state.createdGrants) {
        const gRes = await client.query(
          'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2',
          [g.userId, g.roleId]
        );
        grantsRemoved += gRes.rowCount ?? 0;
      }
    }

    // 3. Delete users
    if (state.createdUserIds && state.createdUserIds.length > 0) {
      const uRes = await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        state.createdUserIds,
      ]);
      usersRemoved += uRes.rowCount ?? 0;
    }

    // 4. Delete roles created by this run ONLY IF UNUSED by any user.
    // Lock user_roles in SHARE ROW EXCLUSIVE MODE to prevent concurrent grant insertions from being cascade-deleted.
    if (state.createdRoleIds && state.createdRoleIds.length > 0) {
      await client.query('LOCK TABLE user_roles IN SHARE ROW EXCLUSIVE MODE');
      for (const roleId of state.createdRoleIds) {
        const rRes = await client.query(
          'DELETE FROM roles WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM user_roles WHERE user_roles.role_id = roles.id)',
          [roleId]
        );
        rolesRemoved += rRes.rowCount ?? 0;
      }
    }

    await client.query('COMMIT');

    // 5. Remove state file only after successful commit
    try {
      await fs.unlink(stateFile);
    } catch {
      // Ignore unlink failure if already gone
    }

    return {
      cleaned: true,
      runId: state.runId,
      database: state.database,
      usersRemoved,
      grantsRemoved,
      rolesRemoved,
      sessionsRemoved,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve original error
    }
    throw err;
  } finally {
    if (typeof client.release === 'function') {
      client.release();
    }
    if (!options.db) {
      await pool.end().catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || (action !== 'setup' && action !== 'cleanup')) {
    console.error('Usage: node tests/fixtures/identity.ts <setup|cleanup>');
    process.exit(1);
  }

  try {
    if (action === 'setup') {
      const state = await setupTestIdentities();
      console.log(
        `Test identities setup completed successfully for run ${state.runId} on database ${state.database}.`
      );
      console.log(`Maintainer user: ${state.maintainer.username} (${state.maintainer.id})`);
      console.log(`Standard user: ${state.standard.username} (${state.standard.id})`);
      process.exit(0);
    } else {
      const result = await cleanupTestIdentities();
      if (result.cleaned) {
        console.log(
          `Test identities cleanup completed successfully for run ${result.runId} on database ${result.database}.`
        );
        console.log(
          `Removed: ${result.usersRemoved} users, ${result.grantsRemoved} grants, ${result.rolesRemoved} unused roles, ${result.sessionsRemoved} sessions.`
        );
      } else {
        console.log(`Test identities cleanup skipped: ${result.reason}.`);
      }
      process.exit(0);
    }
  } catch (err: any) {
    console.error(`ERROR: Test identity ${action} failed: ${err.message}`);
    process.exit(1);
  }
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main().catch((err) => {
    console.error('Test identity execution failed:', err.message);
    process.exit(1);
  });
}
