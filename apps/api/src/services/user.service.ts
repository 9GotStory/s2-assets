import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';

const { Pool } = pg;

export interface User {
  id: string;
  username: string;
  password_hash: string;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export type SafeUser = Omit<User, 'password_hash'>;

export interface DatabaseClient {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface UserServiceOptions {
  db?: DatabaseClient | any;
  databaseUrl?: string;
}

/**
 * Standard Argon2id PHC string format pattern:
 * $argon2id$v=<version>$m=<memory>,(t=<iterations>,p=<parallelism>|p=<parallelism>,t=<iterations>)$<salt>$<hash>
 */
export const ARGON2ID_HASH_REGEX =
  /^\$argon2id\$v=\d+\$m=\d+,(?:t=\d+,p=\d+|p=\d+,t=\d+)\$[A-Za-z0-9+/=_-]+\$[A-Za-z0-9+/=_-]+$/;

/**
 * Check if the given value is a valid Argon2id hash string.
 */
export function isArgon2idHash(hash: unknown): boolean {
  if (typeof hash !== 'string' || hash.length === 0) {
    return false;
  }
  return ARGON2ID_HASH_REGEX.test(hash);
}

/**
 * Strip password_hash from user object, ensuring credentials never leak.
 */
export function sanitizeUser<T extends { password_hash?: unknown }>(
  user: T
): Omit<T, 'password_hash'> {
  const { password_hash: _hash, ...safeUser } = user;
  return safeUser;
}

export const toSafeUser = sanitizeUser;

/**
 * Hash a plaintext password explicitly using Argon2id.
 */
export async function hashPassword(
  password: string,
  options?: Omit<argon2.HashOptions, 'type'>
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }

  // Explicitly enforce Argon2id
  const hash = await argon2.hash(password, {
    ...options,
    type: argon2.argon2id,
  });

  if (!isArgon2idHash(hash)) {
    throw new Error('Generated hash does not match required Argon2id format');
  }

  return hash;
}

/**
 * Verify a plaintext password against an Argon2id hash.
 * Returns false safely if the password or hash is invalid, malformed, or not Argon2id.
 */
export async function verifyPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  if (typeof passwordHash !== 'string' || typeof password !== 'string') {
    return false;
  }
  if (passwordHash.length === 0 || password.length === 0) {
    return false;
  }

  // Reject non-Argon2id hashes and insecure fallback algorithms immediately
  if (!passwordHash.startsWith('$argon2id$')) {
    return false;
  }

  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    // Treat any argon2 verification error (malformed parameters, corrupted salt/hash, etc.)
    // as a failed verification without exposing details or leaking hash contents.
    return false;
  }
}

/**
 * Service managing user identity, Argon2id credentials, and authentication verification.
 */
export class UserService {
  private db?: any;
  private pool?: pg.Pool;

  constructor(options?: UserServiceOptions | DatabaseClient | string) {
    if (typeof options === 'string') {
      this.pool = new Pool({ connectionString: options });
    } else if (options && typeof options === 'object') {
      if ('query' in options || 'selectFrom' in options) {
        this.db = options;
      } else {
        if (options.db) {
          this.db = options.db;
        }
        if (options.databaseUrl) {
          this.pool = new Pool({ connectionString: options.databaseUrl });
        }
      }
    }
  }

  static hashPassword = hashPassword;
  static verifyPassword = verifyPassword;
  static isArgon2idHash = isArgon2idHash;
  static sanitizeUser = sanitizeUser;
  static toSafeUser = sanitizeUser;

  async hashPassword(
    password: string,
    options?: Omit<argon2.HashOptions, 'type'>
  ): Promise<string> {
    return hashPassword(password, options);
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    return verifyPassword(passwordHash, password);
  }

  isArgon2idHash(hash: unknown): boolean {
    return isArgon2idHash(hash);
  }

  sanitizeUser<T extends { password_hash?: unknown }>(user: T): Omit<T, 'password_hash'> {
    return sanitizeUser(user);
  }

  toSafeUser<T extends { password_hash?: unknown }>(user: T): Omit<T, 'password_hash'> {
    return sanitizeUser(user);
  }

  async findByUsername(username: string): Promise<User | null> {
    if (!username || typeof username !== 'string') {
      return null;
    }

    const client = this.db ?? this.pool;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    if (typeof client.selectFrom === 'function') {
      const row = await client
        .selectFrom('users')
        .selectAll()
        .where('username', '=', username)
        .executeTakeFirst();
      return row ?? null;
    }

    if (typeof client.query === 'function') {
      const result = await client.query(
        'SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = $1 LIMIT 1',
        [username]
      );
      return result.rows[0] ?? null;
    }

    throw new Error('Unsupported database client interface');
  }

  async findById(id: string): Promise<User | null> {
    if (!id || typeof id !== 'string') {
      return null;
    }

    const client = this.db ?? this.pool;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    if (typeof client.selectFrom === 'function') {
      const row = await client
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ?? null;
    }

    if (typeof client.query === 'function') {
      const result = await client.query(
        'SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE id = $1 LIMIT 1',
        [id]
      );
      return result.rows[0] ?? null;
    }

    throw new Error('Unsupported database client interface');
  }

  async createUser(params: {
    id?: string;
    username: string;
    password: string;
    isActive?: boolean;
  }): Promise<SafeUser> {
    const { username, password, isActive = true } = params;
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      throw new Error('Username must be a non-empty string');
    }
    if (!password || typeof password !== 'string' || password.length === 0) {
      throw new Error('Password must be a non-empty string');
    }

    const passwordHash = await this.hashPassword(password);
    const id = params.id || crypto.randomUUID();

    const client = this.db ?? this.pool;
    if (!client) {
      throw new Error('Database client is not configured');
    }

    if (typeof client.insertInto === 'function') {
      const row = await client
        .insertInto('users')
        .values({
          id,
          username,
          password_hash: passwordHash,
          is_active: isActive,
        })
        .returning(['id', 'username', 'is_active', 'created_at', 'updated_at'])
        .executeTakeFirstOrThrow();
      return row;
    }

    if (typeof client.query === 'function') {
      const result = await client.query(
        `INSERT INTO users (id, username, password_hash, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, username, is_active, created_at, updated_at`,
        [id, username, passwordHash, isActive]
      );
      return result.rows[0];
    }

    throw new Error('Unsupported database client interface');
  }

  async verifyCredentials(
    username: string,
    password: string
  ): Promise<{
    valid: boolean;
    user?: SafeUser;
    reason?: 'INVALID_CREDENTIALS' | 'USER_DISABLED';
  }> {
    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return { valid: false, reason: 'INVALID_CREDENTIALS' };
    }

    const user = await this.findByUsername(username);
    if (!user) {
      return { valid: false, reason: 'INVALID_CREDENTIALS' };
    }

    if (!user.is_active) {
      return { valid: false, reason: 'USER_DISABLED' };
    }

    const isPasswordValid = await this.verifyPassword(user.password_hash, password);
    if (!isPasswordValid) {
      return { valid: false, reason: 'INVALID_CREDENTIALS' };
    }

    return {
      valid: true,
      user: this.sanitizeUser(user),
    };
  }

  async authenticate(username: string, password: string): Promise<SafeUser | null> {
    const result = await this.verifyCredentials(username, password);
    return result.valid && result.user ? result.user : null;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

export default UserService;
