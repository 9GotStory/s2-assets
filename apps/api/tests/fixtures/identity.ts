import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';
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
  targetEndpoint: string;
  status: 'active' | 'initializing' | 'uncertain';
  maintainer: TestIdentityUser;
  standard: TestIdentityUser;
  createdUserIds: string[];
  createdRoleIds: string[];
  createdGrants: TestIdentityGrant[];
  createdSessionIds: string[];
  createdAt: string;
  error?: string;
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
  baseUsername?: string;
  stateFile?: string;
  nodeEnv?: string;
  expectedDb?: string;
  db?: any;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
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

export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 60000;
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 10000;

/**
 * Validates and resolves lock or statement timeout bounds strictly (1–60,000ms inclusive).
 * Rejects zero, negative, floating-point, NaN, non-numeric, or permissive-coerced strings.
 */
export function parseTimeoutMs(
  optionValue: unknown,
  envValue: string | undefined,
  defaultValue: number,
  name: string
): number {
  if (optionValue !== undefined) {
    if (typeof optionValue !== 'number' || !Number.isInteger(optionValue)) {
      throw new Error(
        `Invalid ${name}: must be an integer millisecond value between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got ${typeof optionValue === 'string' ? `"${optionValue}"` : String(optionValue)}). Failing closed.`
      );
    }
    if (optionValue < MIN_TIMEOUT_MS || optionValue > MAX_TIMEOUT_MS) {
      throw new Error(
        `Invalid ${name}: value ${optionValue}ms is out of supported range [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]ms. Failing closed.`
      );
    }
    return optionValue;
  }

  if (envValue !== undefined) {
    if (!/^[1-9][0-9]*$/.test(envValue)) {
      throw new Error(
        `Invalid ${name} environment value "${envValue}": must be a positive integer millisecond string between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}. Failing closed.`
      );
    }
    const parsed = Number(envValue);
    if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
      throw new Error(
        `Invalid ${name} environment value "${envValue}": value ${parsed}ms is out of supported range [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]ms. Failing closed.`
      );
    }
    return parsed;
  }

  return defaultValue;
}

/**
 * Locates the repository checkout root.
 */
export function findRepoRoot(): string {
  try {
    let cur = path.dirname(fileURLToPath(import.meta.url));
    while (cur !== path.dirname(cur)) {
      if (
        fsSync.existsSync(path.join(cur, '.git')) ||
        (fsSync.existsSync(path.join(cur, 'package.json')) &&
          fsSync.existsSync(path.join(cur, 'pnpm-workspace.yaml')))
      ) {
        return path.resolve(cur);
      }
      cur = path.dirname(cur);
    }
  } catch {
    // Fall back to relative navigation from apps/api/tests/fixtures
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/**
 * Validates that a path resides strictly outside the repository checkout.
 * Resolves both lexical path and canonical symlink path.
 */
export function validateOutsideCheckout(targetPath: string, description = 'Path'): void {
  const repoRoot = findRepoRoot();
  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = fsSync.realpathSync(repoRoot);
  } catch {
    canonicalRepoRoot = path.resolve(repoRoot);
  }

  const absTarget = path.resolve(targetPath);
  if (
    absTarget === repoRoot ||
    absTarget.startsWith(repoRoot + path.sep) ||
    absTarget === canonicalRepoRoot ||
    absTarget.startsWith(canonicalRepoRoot + path.sep)
  ) {
    throw new Error(
      `${description} must reside outside repository checkout (path "${targetPath}" is inside "${canonicalRepoRoot}")`
    );
  }

  // Resolve canonical path if target or parent directory exists
  let checkDir = fsSync.existsSync(absTarget) ? absTarget : path.dirname(absTarget);
  while (!fsSync.existsSync(checkDir) && checkDir !== path.dirname(checkDir)) {
    checkDir = path.dirname(checkDir);
  }

  let canonicalTarget: string;
  try {
    const canonicalDir = fsSync.realpathSync(checkDir);
    const relRest = path.relative(checkDir, absTarget);
    canonicalTarget = path.resolve(canonicalDir, relRest);
  } catch {
    canonicalTarget = absTarget;
  }

  if (
    canonicalTarget === repoRoot ||
    canonicalTarget.startsWith(repoRoot + path.sep) ||
    canonicalTarget === canonicalRepoRoot ||
    canonicalTarget.startsWith(canonicalRepoRoot + path.sep)
  ) {
    throw new Error(
      `${description} must reside outside repository checkout (resolved "${canonicalTarget}" is inside "${canonicalRepoRoot}")`
    );
  }
}

/**
 * Loads environment variables from an env file without altering raw values.
 */
export function loadEnvFile(filePath: string): void {
  validateOutsideCheckout(filePath, 'Environment file');
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
  } catch (err: any) {
    if (err.message.includes('outside repository checkout')) {
      throw err;
    }
    // Silently ignore file read errors; validation will catch missing keys
  }
}

/**
 * Loads configuration from either a JSON configuration file (lossless) or an env file.
 */
export function loadConfigFile(filePath: string): void {
  validateOutsideCheckout(filePath, 'Configuration file');
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
  } catch (err: any) {
    if (err.message.includes('outside repository checkout')) {
      throw err;
    }
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

  const isProdHost = (host: string): boolean => {
    const h = decodeURIComponent(host || '').toLowerCase();
    return (
      h.includes('prod') ||
      h.includes('production') ||
      h.includes('s2.internal') ||
      h.includes('aws') ||
      h.includes('rds') ||
      h.includes('azure') ||
      h.includes('cloudsql')
    );
  };

  // Inspect all host candidates in URL and query parameters (raw and decoded)
  const hostCandidates = [
    parsedUrl.hostname,
    ...parsedUrl.searchParams.getAll('host'),
  ].filter(Boolean);

  for (const candidate of hostCandidates) {
    if (isProdHost(candidate)) {
      throw new Error(`Production database target is prohibited (host: ${candidate})`);
    }
  }

  let effectiveHost: string;
  let effectivePort: string;
  let dbName: string;

  try {
    const dummyClient: any = new pg.Client({ connectionString: databaseUrl });
    effectiveHost = String(dummyClient.connectionParameters?.host || '').toLowerCase();
    effectivePort = String(dummyClient.connectionParameters?.port || '5432');
    dbName = String(dummyClient.connectionParameters?.database || '');
  } catch {
    throw new Error('Failed to parse database connection parameters using pg driver');
  }

  if (!effectiveHost || effectiveHost.trim().length === 0) {
    throw new Error('Database URL host is required');
  }

  if (isProdHost(effectiveHost)) {
    throw new Error(`Production database target is prohibited (host: ${effectiveHost})`);
  }

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
 * Atomically writes state data using a unique temporary file and rename.
 * Ensures that existing valid state is never truncated or left in an invalid state.
 */
export async function writeStateFileAtomic(filePath: string, data: TestIdentityState): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.tmp_${path.basename(filePath)}_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`
  );
  const content = JSON.stringify(data, null, 2);

  const handle = await fs.open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, { encoding: 'utf-8' });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fs.rename(tmpPath, filePath);
  } catch (renameErr) {
    await fs.unlink(tmpPath).catch(() => {});
    throw renameErr;
  }
}

/**
 * Acquires a session-level advisory lock for the given run ID with a bounded timeout.
 */
export async function acquireAdvisoryLock(client: any, runId: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('s2_foundation_fixture:' || $1)) AS locked",
      [runId]
    );
    if (res.rows?.[0]?.locked === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting to acquire fixture advisory lock for run "${runId}" after ${timeoutMs}ms. Failing closed.`
  );
}

/**
 * Releases the session-level advisory lock for the given run ID.
 */
export async function releaseAdvisoryLock(client: any, runId: string): Promise<void> {
  try {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('s2_foundation_fixture:' || $1))",
      [runId]
    );
  } catch {
    // Silently ignore unlock errors; connection close will release advisory lock automatically
  }
}

/**
 * Reads and validates a fixture state record under lock, enforcing ownership invariants,
 * secure file permissions (0600 or 0400), valid structure, and fail-closed semantics.
 */
export async function readAndValidateStateFile(
  filePath: string,
  expectedRunId: string,
  expectedDb: string,
  expectedEndpoint: string,
  expectedBaseUsername?: string
): Promise<TestIdentityState> {
  validateOutsideCheckout(filePath, 'State file');

  const st = await fs.stat(filePath);
  if (!st.isFile()) {
    throw new Error(`State file is not a regular file: "${filePath}". Failing closed.`);
  }

  const mode = (st.mode & 0o777).toString(8);
  const tail = mode.slice(-2);
  if (tail !== '00') {
    throw new Error(
      `Insecure permissions on state file "${filePath}": mode must be 600 or 400 (got ${mode}). Failing closed.`
    );
  }

  const stateDir = path.dirname(filePath);
  validatePrivateDirectory(stateDir);
  validateOutsideCheckout(stateDir, 'State directory');

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read fixture state file "${filePath}": ${err.message}. Failing closed.`);
  }

  let state: TestIdentityState;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error('Corrupted fixture state file: JSON parse failed. Failing closed.');
  }

  if (typeof state !== 'object' || state === null) {
    throw new Error('Corrupted fixture state file: not a JSON object. Failing closed.');
  }

  if (state.runId !== expectedRunId) {
    throw new Error(
      `State file run ID mismatch: expected "${expectedRunId}", got "${state.runId}". Failing closed.`
    );
  }

  if (state.database !== expectedDb) {
    throw new Error(
      `State file database mismatch: expected "${expectedDb}", got "${state.database}". Failing closed.`
    );
  }

  if (!state.targetEndpoint || typeof state.targetEndpoint !== 'string' || state.targetEndpoint.trim().length === 0) {
    throw new Error('Corrupted or incomplete fixture state file: missing targetEndpoint. Failing closed.');
  }

  if (state.targetEndpoint !== expectedEndpoint) {
    throw new Error(
      `State file target mismatch: expected "${expectedEndpoint}", got "${state.targetEndpoint}". Failing closed.`
    );
  }

  if (!['active', 'initializing', 'uncertain'].includes(state.status)) {
    throw new Error(`Invalid fixture state status: "${state.status}". Failing closed.`);
  }

  if (
    !Array.isArray(state.createdUserIds) ||
    !Array.isArray(state.createdGrants) ||
    !Array.isArray(state.createdRoleIds)
  ) {
    throw new Error('Corrupted fixture state file: missing ownership arrays. Failing closed.');
  }

  const userIdsSet = new Set<string>();
  for (const uid of state.createdUserIds) {
    if (typeof uid !== 'string' || uid.trim().length === 0) {
      throw new Error('Corrupted fixture state file: invalid user ID in createdUserIds. Failing closed.');
    }
    if (userIdsSet.has(uid)) {
      throw new Error(`Corrupted fixture state file: duplicate user ID "${uid}" in createdUserIds. Failing closed.`);
    }
    userIdsSet.add(uid);
  }

  // P1: Both maintainer and standard identity descriptors are MANDATORY and must be valid objects (O1, O2)
  if (!state.maintainer || typeof state.maintainer !== 'object') {
    throw new Error('Corrupted fixture state file: missing or invalid maintainer descriptor. Failing closed.');
  }
  if (typeof state.maintainer.username !== 'string' || state.maintainer.username.trim().length === 0) {
    throw new Error('Corrupted fixture state file: missing maintainer username. Failing closed.');
  }
  if (typeof state.maintainer.id !== 'string') {
    throw new Error('Corrupted fixture state file: invalid maintainer id. Failing closed.');
  }
  if (state.maintainer.role !== 'SYSTEM_MAINTAINER') {
    throw new Error('Corrupted fixture state file: maintainer role must be "SYSTEM_MAINTAINER". Failing closed.');
  }

  if (!state.standard || typeof state.standard !== 'object') {
    throw new Error('Corrupted fixture state file: missing or invalid standard descriptor. Failing closed.');
  }
  if (typeof state.standard.username !== 'string' || state.standard.username.trim().length === 0) {
    throw new Error('Corrupted fixture state file: missing standard username. Failing closed.');
  }
  if (typeof state.standard.id !== 'string') {
    throw new Error('Corrupted fixture state file: invalid standard id. Failing closed.');
  }
  if (state.standard.role !== null) {
    throw new Error('Corrupted fixture state file: standard role must be null. Failing closed.');
  }

  // Descriptors must represent distinct users if populated
  if (state.maintainer.id.length > 0 && state.maintainer.id === state.standard.id) {
    throw new Error('Inconsistent ownership state: maintainer and standard cannot share the same user ID. Failing closed.');
  }

  // Expected base username validation (O4)
  if (expectedBaseUsername !== undefined) {
    const expectedMaintainerUsername = `${expectedBaseUsername}_maintainer`;
    const expectedStandardUsername = `${expectedBaseUsername}_standard`;
    if (state.maintainer.username !== expectedMaintainerUsername) {
      throw new Error(
        `State maintainer username mismatch: expected "${expectedMaintainerUsername}", got "${state.maintainer.username}". Failing closed.`
      );
    }
    if (state.standard.username !== expectedStandardUsername) {
      throw new Error(
        `State standard username mismatch: expected "${expectedStandardUsername}", got "${state.standard.username}". Failing closed.`
      );
    }
  }

  // Status-specific descriptor ID invariants (O9)
  if (state.status === 'active') {
    if (state.maintainer.id.length === 0) {
      throw new Error('Inconsistent ownership state: active state requires non-empty maintainer ID. Failing closed.');
    }
    if (state.standard.id.length === 0) {
      throw new Error('Inconsistent ownership state: active state requires non-empty standard ID. Failing closed.');
    }
  }

  // Descriptor IDs (when non-empty) must be present in createdUserIds
  if (state.maintainer.id.length > 0 && !userIdsSet.has(state.maintainer.id)) {
    throw new Error(
      `Inconsistent ownership state: maintainer ID "${state.maintainer.id}" not found in createdUserIds. Failing closed.`
    );
  }
  if (state.standard.id.length > 0 && !userIdsSet.has(state.standard.id)) {
    throw new Error(
      `Inconsistent ownership state: standard ID "${state.standard.id}" not found in createdUserIds. Failing closed.`
    );
  }

  // Both descriptors must explain every claimed created identity (O3)
  for (const uid of state.createdUserIds) {
    const isMaintainer = state.maintainer.id.length > 0 && state.maintainer.id === uid;
    const isStandard = state.standard.id.length > 0 && state.standard.id === uid;
    if (!isMaintainer && !isStandard) {
      throw new Error(
        `Inconsistent ownership state: createdUserIds contains unowned user ID "${uid}". Failing closed.`
      );
    }
  }

  // Grants consistency (O3, O6): only maintainer grant to SYSTEM_MAINTAINER is authorized
  const grantKeys = new Set<string>();
  for (const g of state.createdGrants) {
    if (typeof g !== 'object' || g === null) {
      throw new Error('Corrupted fixture state file: invalid grant entry. Failing closed.');
    }
    if (typeof g.userId !== 'string' || g.userId.trim().length === 0) {
      throw new Error('Corrupted fixture state file: invalid userId in grant. Failing closed.');
    }
    if (typeof g.roleId !== 'string' || g.roleId.trim().length === 0) {
      throw new Error('Corrupted fixture state file: invalid roleId in grant. Failing closed.');
    }
    if (!userIdsSet.has(g.userId)) {
      throw new Error(
        `Inconsistent ownership state: grant user "${g.userId}" does not belong to run-owned identities. Failing closed.`
      );
    }
    if (state.maintainer.id.length === 0 || g.userId !== state.maintainer.id || g.roleId !== 'SYSTEM_MAINTAINER') {
      throw new Error(
        `Inconsistent grant ownership: grant for user "${g.userId}" with role "${g.roleId}" is not authorized for this fixture. Failing closed.`
      );
    }
    const key = `${g.userId}:${g.roleId}`;
    if (grantKeys.has(key)) {
      throw new Error(`Corrupted fixture state file: duplicate grant "${key}". Failing closed.`);
    }
    grantKeys.add(key);
  }

  // Role consistency (O7): fixed-purpose fixture only ever creates SYSTEM_MAINTAINER
  const roleIdsSet = new Set<string>();
  for (const rid of state.createdRoleIds) {
    if (typeof rid !== 'string' || rid.trim().length === 0) {
      throw new Error('Corrupted fixture state file: invalid role ID in createdRoleIds. Failing closed.');
    }
    if (rid !== 'SYSTEM_MAINTAINER') {
      throw new Error(
        `Inconsistent role ownership: createdRoleIds contains unprovable or unauthorized role "${rid}". Failing closed.`
      );
    }
    if (roleIdsSet.has(rid)) {
      throw new Error(`Corrupted fixture state file: duplicate role ID "${rid}" in createdRoleIds. Failing closed.`);
    }
    roleIdsSet.add(rid);
  }
  if (state.createdRoleIds.length > 1) {
    throw new Error('Inconsistent role ownership: fixture cannot create more than one role. Failing closed.');
  }

  // Validate tracked sessions if present (O6)
  if (state.createdSessionIds !== undefined) {
    if (!Array.isArray(state.createdSessionIds)) {
      throw new Error('Corrupted fixture state file: createdSessionIds must be an array. Failing closed.');
    }
    const sessionIdsSet = new Set<string>();
    for (const sid of state.createdSessionIds) {
      if (typeof sid !== 'string' || sid.trim().length === 0) {
        throw new Error('Corrupted fixture state file: invalid session ID in createdSessionIds. Failing closed.');
      }
      if (sessionIdsSet.has(sid)) {
        throw new Error(`Corrupted fixture state file: duplicate session ID "${sid}" in createdSessionIds. Failing closed.`);
      }
      sessionIdsSet.add(sid);
    }
  }

  return state;
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

  validateOutsideCheckout(stateFile, 'State file');
  const stateDir = path.dirname(stateFile);
  validateOutsideCheckout(stateDir, 'State directory');
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

  const pool = options.db ?? new Pool({ connectionString: databaseUrl });
  let client: any;
  if ((pool as any)._connected || (pool as any)._connecting) {
    client = pool;
  } else if (typeof pool.connect === 'function') {
    client = await pool.connect();
  } else {
    client = pool;
  }

  let advisoryLockAcquired = false;
  let inTransaction = false;
  let commitAttempted = false;
  let committed = false;
  let reservationCreated = false;
  let maintainer: any = null;
  let standard: any = null;
  const createdUserIds: string[] = [];
  const createdRoleIds: string[] = [];
  const createdGrants: TestIdentityGrant[] = [];
  const createdSessionIds: string[] = [];

  try {
    // Acquire session-level advisory lock BEFORE creating reservation file or mutating DB
    await acquireAdvisoryLock(client, runId, 15000);
    advisoryLockAcquired = true;

    // Re-check state file under the lock
    if (fsSync.existsSync(stateFile)) {
      throw new Error(
        `Existing fixture state record found at "${stateFile}". Cannot overwrite active or partial ownership record. Run cleanup first.`
      );
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

    // Reserve state file atomically with 'wx' and mode 0600
    const reservationHandle = await fs.open(stateFile, 'wx', 0o600);
    try {
      await reservationHandle.writeFile(JSON.stringify(initialReservation, null, 2), {
        encoding: 'utf-8',
      });
      await reservationHandle.sync();
    } finally {
      await reservationHandle.close();
    }
    reservationCreated = true;

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
    maintainer = await userService.createUser({
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
    standard = await userService.createUser({
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

    // 7. Write pre-commit state with tracked IDs while status remains initializing
    const preCommitState: TestIdentityState = {
      runId,
      database: dbName,
      targetEndpoint,
      status: 'initializing',
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

    await writeStateFileAtomic(stateFile, preCommitState);

    // 8. Commit database transaction
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    inTransaction = false;

    // 9. Update state record to active only after commit succeeds
    const activeState: TestIdentityState = {
      ...preCommitState,
      status: 'active',
    };

    await writeStateFileAtomic(stateFile, activeState);

    return activeState;
  } catch (err: any) {
    const primaryError = err;
    let rollbackSucceeded = false;
    if (inTransaction && !committed) {
      try {
        await client.query('ROLLBACK');
        rollbackSucceeded = true;
      } catch {
        rollbackSucceeded = false;
      }
    }

    if (!commitAttempted && rollbackSucceeded) {
      // Definite rollback: commit was never attempted and rollback succeeded cleanly.
      if (reservationCreated) {
        try {
          await fs.unlink(stateFile);
        } catch {}
      }
    } else {
      // Uncertain outcome: commit was attempted or rollback failed.
      // Rows may exist in the database! Preserve state file with status "uncertain"
      // using atomic durable replacement so the pre-commit state with tracked IDs is NOT corrupted.
      if (reservationCreated) {
        try {
          const uncertainState: TestIdentityState = {
            runId,
            database: dbName,
            targetEndpoint,
            status: 'uncertain',
            maintainer: {
              id: maintainer?.id || '',
              username: maintainerUsername,
              role: 'SYSTEM_MAINTAINER',
            },
            standard: {
              id: standard?.id || '',
              username: standardUsername,
              role: null,
            },
            createdUserIds: [...createdUserIds],
            createdRoleIds: [...createdRoleIds],
            createdGrants: [...createdGrants],
            createdSessionIds: [...createdSessionIds],
            createdAt: new Date().toISOString(),
            error: primaryError?.message || 'Uncertain commit/rollback outcome',
          };
          await writeStateFileAtomic(stateFile, uncertainState);
        } catch {}
      }
    }
    throw primaryError;
  } finally {
    if (advisoryLockAcquired) {
      await releaseAdvisoryLock(client, runId);
    }
    if (typeof client.release === 'function' && client !== options.db) {
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

  const baseUsername = options.baseUsername ?? process.env.FOUNDATION_TEST_USERNAME;
  if (!baseUsername || typeof baseUsername !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(baseUsername)) {
    throw new Error(
      'FOUNDATION_TEST_USERNAME or baseUsername is required and must be alphanumeric with hyphens or underscores'
    );
  }

  // P2: Validate timeouts strictly before acquiring lock or opening connection
  const lockTimeoutMs = parseTimeoutMs(
    options.lockTimeoutMs,
    process.env.FOUNDATION_LOCK_TIMEOUT_MS,
    DEFAULT_LOCK_TIMEOUT_MS,
    'lockTimeout'
  );
  const statementTimeoutMs = parseTimeoutMs(
    options.statementTimeoutMs,
    process.env.FOUNDATION_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    'statementTimeout'
  );

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

  validateOutsideCheckout(stateFile, 'State file');
  const stateDir = path.dirname(stateFile);
  validateOutsideCheckout(stateDir, 'State directory');
  validatePrivateDirectory(stateDir);

  const pool = options.db ?? new Pool({ connectionString: databaseUrl });
  let client: any;
  if ((pool as any)._connected || (pool as any)._connecting) {
    client = pool;
  } else if (typeof pool.connect === 'function') {
    client = await pool.connect();
  } else {
    client = pool;
  }

  let advisoryLockAcquired = false;
  let inTransaction = false;

  try {
    // Acquire session-level advisory lock across the complete run lifecycle
    await acquireAdvisoryLock(client, runId, 15000);
    advisoryLockAcquired = true;

    // Check state file UNDER THE LOCK
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

    // Thoroughly validate locked state file with expected base username (P1 / O4)
    const state = await readAndValidateStateFile(
      stateFile,
      runId,
      dbName,
      targetEndpoint,
      baseUsername
    );

    // If empty initializing record without any created entities:
    if (
      state.createdUserIds.length === 0 &&
      state.createdGrants.length === 0 &&
      state.createdRoleIds.length === 0
    ) {
      await fs.unlink(stateFile);
      return {
        cleaned: false,
        runId,
        database: dbName,
        usersRemoved: 0,
        grantsRemoved: 0,
        rolesRemoved: 0,
        sessionsRemoved: 0,
        reason: 'EMPTY_INITIALIZING_RECORD',
      };
    }

    let sessionsRemoved = 0;
    let grantsRemoved = 0;
    let usersRemoved = 0;
    let rolesRemoved = 0;

    await client.query('BEGIN');
    inTransaction = true;

    // Apply bounded PostgreSQL lock and statement timeouts within the cleanup transaction (P2)
    await client.query("SELECT set_config('lock_timeout', $1::text, true)", [`${lockTimeoutMs}ms`]);
    await client.query("SELECT set_config('statement_timeout', $1::text, true)", [`${statementTimeoutMs}ms`]);

    // Establish identity ownership against actual selected database independently from mutable JSON (P1 / O4 / O5)
    const expectedMaintainerUsername = `${baseUsername}_maintainer`;
    const expectedStandardUsername = `${baseUsername}_standard`;
    const provenOwnedUserIds: string[] = [];

    if (state.createdUserIds && state.createdUserIds.length > 0) {
      const userRowsRes = await client.query(
        'SELECT id, username FROM users WHERE id = ANY($1::uuid[])',
        [state.createdUserIds]
      );
      const foundUserRows: Array<{ id: string; username: string }> = userRowsRes.rows || [];
      for (const row of foundUserRows) {
        let expectedUsername: string | undefined;
        if (state.maintainer.id === row.id) {
          expectedUsername = expectedMaintainerUsername;
        } else if (state.standard.id === row.id) {
          expectedUsername = expectedStandardUsername;
        }
        if (!expectedUsername || row.username !== expectedUsername) {
          throw new Error(
            `Database ownership mismatch: user "${row.id}" has username "${row.username}", expected "${expectedUsername}". Failing closed.`
          );
        }
        provenOwnedUserIds.push(row.id);
      }
    }

    // Verify that all existing tracked sessions belong exclusively to run-owned identities (P1 / O6)
    if (state.createdSessionIds && state.createdSessionIds.length > 0) {
      const sessionRowsRes = await client.query(
        'SELECT id, user_id FROM sessions WHERE id = ANY($1)',
        [state.createdSessionIds]
      );
      const foundSessions: Array<{ id: string; user_id: string }> = sessionRowsRes.rows || [];
      for (const s of foundSessions) {
        if (!state.createdUserIds.includes(s.user_id)) {
          throw new Error(
            `Inconsistent session ownership: session "${s.id}" belongs to user "${s.user_id}" which is not an owned identity. Failing closed.`
          );
        }
      }
    }

    // 1. Delete sessions for created users or explicitly tracked sessions, with ownership restrictions enforced in query (P1)
    if (
      state.createdSessionIds &&
      state.createdSessionIds.length > 0 &&
      state.createdUserIds &&
      state.createdUserIds.length > 0
    ) {
      const sRes = await client.query(
        'DELETE FROM sessions WHERE id = ANY($1) AND user_id = ANY($2::uuid[])',
        [state.createdSessionIds, state.createdUserIds]
      );
      sessionsRemoved += sRes.rowCount ?? 0;
    }
    if (state.createdUserIds && state.createdUserIds.length > 0) {
      const sRes = await client.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [
        state.createdUserIds,
      ]);
      sessionsRemoved += sRes.rowCount ?? 0;
    }

    // 2. Delete composite grants (strictly restricted to run-owned identities in query) (P1)
    if (
      state.createdGrants &&
      state.createdGrants.length > 0 &&
      state.createdUserIds &&
      state.createdUserIds.length > 0
    ) {
      for (const g of state.createdGrants) {
        if (state.createdUserIds.includes(g.userId)) {
          const gRes = await client.query(
            'DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2 AND user_id = ANY($3::uuid[])',
            [g.userId, g.roleId, state.createdUserIds]
          );
          grantsRemoved += gRes.rowCount ?? 0;
        }
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
        if (roleId === 'SYSTEM_MAINTAINER') {
          const rRes = await client.query(
            'DELETE FROM roles WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM user_roles WHERE user_roles.role_id = roles.id)',
            [roleId]
          );
          rolesRemoved += rRes.rowCount ?? 0;
        }
      }
    }

    await client.query('COMMIT');
    inTransaction = false;

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
    if (advisoryLockAcquired) {
      await releaseAdvisoryLock(client, runId);
    }
    if (typeof client.release === 'function' && client !== options.db) {
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
