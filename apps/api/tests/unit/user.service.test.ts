import { describe, it, expect, vi } from 'vitest';
import * as argon2 from 'argon2';
import {
  UserService,
  hashPassword,
  verifyPassword,
  isArgon2idHash,
  sanitizeUser,
  toSafeUser,
  ARGON2ID_HASH_REGEX,
  type User,
} from '../../src/services/user.service.ts';

describe('UserService Unit Tests (T018)', () => {
  describe('Argon2id Hashing', () => {
    it('successfully hashes password using Argon2id format', async () => {
      const password = 'CorrectPassword123!';
      const hash = await hashPassword(password);

      // Verify string starts with $argon2id$
      expect(hash.startsWith('$argon2id$')).toBe(true);
      // Verify matches full Argon2id PHC regex
      expect(ARGON2ID_HASH_REGEX.test(hash)).toBe(true);
      expect(isArgon2idHash(hash)).toBe(true);

      // Plaintext password must never be stored as the hash or leaked inside the hash
      expect(hash).not.toBe(password);
      expect(hash.includes(password)).toBe(false);
    });

    it('generates distinct salts and distinct hashes for repeated hashing of the same password', async () => {
      const password = 'SamePassword456!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
      expect(isArgon2idHash(hash1)).toBe(true);
      expect(isArgon2idHash(hash2)).toBe(true);
    });

    it('explicitly uses argon2.argon2id type and produces $argon2id$ header', async () => {
      const password = 'ExplicitArgon2idPassword!';
      const hash = await hashPassword(password);

      // Verify that argon2.argon2id (2) is configured and output starts with $argon2id$
      expect(argon2.argon2id).toBe(2);
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(hash.startsWith('$argon2i$')).toBe(false);
      expect(hash.startsWith('$argon2d$')).toBe(false);
    });

    it('rejects empty password with an error and does not produce dummy hash', async () => {
      await expect(hashPassword('')).rejects.toThrow('Password must be a non-empty string');
      // @ts-expect-error testing invalid type
      await expect(hashPassword(null)).rejects.toThrow('Password must be a non-empty string');
      // @ts-expect-error testing invalid type
      await expect(hashPassword(undefined)).rejects.toThrow('Password must be a non-empty string');
    });

    it('works identically via UserService instance and static methods', async () => {
      const service = new UserService();
      const password = 'InstancePassword789!';
      const instanceHash = await service.hashPassword(password);
      const staticHash = await UserService.hashPassword(password);

      expect(service.isArgon2idHash(instanceHash)).toBe(true);
      expect(UserService.isArgon2idHash(staticHash)).toBe(true);
      expect(await service.verifyPassword(instanceHash, password)).toBe(true);
      expect(await UserService.verifyPassword(staticHash, password)).toBe(true);
    });
  });

  describe('Password Verification', () => {
    it('returns true when verifying correct password against valid Argon2id hash', async () => {
      const password = 'SecretPassword999!';
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(hash, password);
      expect(isValid).toBe(true);
    });

    it('returns false when verifying invalid password against valid Argon2id hash', async () => {
      const hash = await hashPassword('ActualPassword123!');

      const isValid = await verifyPassword(hash, 'WrongPassword456!');
      expect(isValid).toBe(false);
    });

    it('returns false when verifying with empty or non-string password', async () => {
      const hash = await hashPassword('ValidPassword123!');

      expect(await verifyPassword(hash, '')).toBe(false);
      // @ts-expect-error testing invalid input
      expect(await verifyPassword(hash, null)).toBe(false);
      // @ts-expect-error testing invalid input
      expect(await verifyPassword(hash, undefined)).toBe(false);
    });

    it('returns false when verifying with empty or non-string hash', async () => {
      expect(await verifyPassword('', 'Password123!')).toBe(false);
      // @ts-expect-error testing invalid input
      expect(await verifyPassword(null, 'Password123!')).toBe(false);
      // @ts-expect-error testing invalid input
      expect(await verifyPassword(undefined, 'Password123!')).toBe(false);
    });
  });

  describe('Malformed Password Hashes & Insecure Fallback Prevention', () => {
    it('returns false safely without throwing unhandled exceptions for non-hash strings', async () => {
      const badHashes = [
        'plaintext-password',
        'not-a-hash-at-all',
        '12345678',
        'admin:password',
      ];

      for (const bad of badHashes) {
        const result = await verifyPassword(bad, 'secret');
        expect(result).toBe(false);
      }
    });

    it('returns false safely without throwing for corrupted Argon2id hashes', async () => {
      const corruptedHashes = [
        '$argon2id$invalid',
        '$argon2id$v=19$bad',
        '$argon2id$v=19$m=65536,t=3,p=4$corrupted_salt_and_hash',
        '$argon2id$v=19$m=0,t=0,p=0$$',
      ];

      for (const bad of corruptedHashes) {
        const result = await verifyPassword(bad, 'secret');
        expect(result).toBe(false);
      }
    });

    it('rejects non-Argon2id algorithms to prevent insecure fallback attacks', async () => {
      const nonArgon2idHashes = [
        '$2a$12$e8n...bcrypt_hash...',
        '$2b$12$e8n...bcrypt_hash...',
        '$1$md5salt$md5hash',
        '$argon2i$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No',
        '$argon2d$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgqlfreuzphiOZoHzAcTXbgFixda/50No',
      ];

      for (const hash of nonArgon2idHashes) {
        const result = await verifyPassword(hash, 'secret');
        expect(result).toBe(false);
      }
    });
  });

  describe('User Sanitization and Security Invariants', () => {
    it('sanitizes user record by stripping password_hash', () => {
      const user: User = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        username: 'alice',
        password_hash: '$argon2id$v=19$m=65536,p=4,t=3$salt$hash',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const safeUser = sanitizeUser(user);
      expect((safeUser as any).password_hash).toBeUndefined();
      expect(safeUser.id).toBe(user.id);
      expect(safeUser.username).toBe('alice');
      expect(safeUser.is_active).toBe(true);

      const safeUserAlias = toSafeUser(user);
      expect((safeUserAlias as any).password_hash).toBeUndefined();
    });

    it('does not leak credentials in error messages', async () => {
      try {
        await hashPassword('');
      } catch (err: any) {
        expect(err.message).not.toContain('password_hash');
        expect(err.message).toBe('Password must be a non-empty string');
      }
    });
  });

  describe('Database Operations Compatibility (T020–T022 Integration)', () => {
    it('finds user by username using configured database client', async () => {
      const mockUser: User = {
        id: 'user-1',
        username: 'charlie',
        password_hash: await hashPassword('Secret123!'),
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [mockUser] }),
      };

      const service = new UserService({ db: mockDb });
      const user = await service.findByUsername('charlie');

      expect(user).toEqual(mockUser);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE username = $1'),
        ['charlie']
      );
    });

    it('returns null when user is not found by username', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const service = new UserService({ db: mockDb });
      const user = await service.findByUsername('nonexistent');

      expect(user).toBeNull();
    });

    it('finds user by id using configured database client', async () => {
      const mockUser: User = {
        id: 'user-42',
        username: 'david',
        password_hash: await hashPassword('Secret456!'),
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [mockUser] }),
      };

      const service = new UserService({ db: mockDb });
      const user = await service.findById('user-42');

      expect(user).toEqual(mockUser);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        ['user-42']
      );
    });

    it('creates user with Argon2id hashed password and returns SafeUser without password_hash', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          const [_id, username, passwordHash, isActive] = params;
          // Verify Argon2id was used for the inserted password_hash
          expect(isArgon2idHash(passwordHash)).toBe(true);
          return {
            rows: [
              {
                id: _id,
                username,
                is_active: isActive,
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
          };
        }),
      };

      const service = new UserService({ db: mockDb });
      const safeUser = await service.createUser({
        username: 'new_user',
        password: 'NewUserPassword789!',
      });

      expect(safeUser.username).toBe('new_user');
      expect(safeUser.is_active).toBe(true);
      expect((safeUser as any).password_hash).toBeUndefined();
    });

    it('successfully verifies credentials for active user with correct password', async () => {
      const password = 'MyPassword123!';
      const hash = await hashPassword(password);

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'user-10',
              username: 'active_user',
              password_hash: hash,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }),
      };

      const service = new UserService({ db: mockDb });
      const result = await service.verifyCredentials('active_user', password);

      expect(result.valid).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user?.username).toBe('active_user');
      expect((result.user as any)?.password_hash).toBeUndefined();
    });

    it('rejects credentials for disabled user with USER_DISABLED reason', async () => {
      const password = 'MyPassword123!';
      const hash = await hashPassword(password);

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'user-11',
              username: 'disabled_user',
              password_hash: hash,
              is_active: false,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }),
      };

      const service = new UserService({ db: mockDb });
      const result = await service.verifyCredentials('disabled_user', password);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('USER_DISABLED');
      expect(result.user).toBeUndefined();
    });

    it('rejects credentials for nonexistent user with INVALID_CREDENTIALS reason', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const service = new UserService({ db: mockDb });
      const result = await service.verifyCredentials('ghost_user', 'any-pass');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_CREDENTIALS');
    });

    it('rejects credentials for wrong password with INVALID_CREDENTIALS reason', async () => {
      const hash = await hashPassword('RightPass!');

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'user-12',
              username: 'bob',
              password_hash: hash,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }),
      };

      const service = new UserService({ db: mockDb });
      const result = await service.verifyCredentials('bob', 'WrongPass!');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('INVALID_CREDENTIALS');
    });

    it('authenticates and returns SafeUser or null', async () => {
      const password = 'AuthPass123!';
      const hash = await hashPassword(password);

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: 'user-13',
              username: 'alice',
              password_hash: hash,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        }),
      };

      const service = new UserService({ db: mockDb });
      const user = await service.authenticate('alice', password);
      expect(user).not.toBeNull();
      expect(user?.username).toBe('alice');

      const failed = await service.authenticate('alice', 'wrong');
      expect(failed).toBeNull();
    });
  });
});
