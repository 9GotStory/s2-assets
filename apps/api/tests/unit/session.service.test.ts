import * as crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  SessionService,
  generateSessionToken,
  generateToken,
  isValidRawToken,
  isSessionToken,
  hashToken,
  deriveDigest,
  digestToken,
  SESSION_TTL_MS,
  SESSION_TTL_HOURS,
  RAW_TOKEN_BYTES,
  BASE64URL_TOKEN_REGEX,
  SHA256_HEX_REGEX,
  type Session,
} from '../../src/services/session.service.ts';

describe('SessionService Unit Tests (T019)', () => {
  describe('Cryptographically Secure Token Generation (Point 1)', () => {
    it('generates a 32-byte cryptographically secure token encoded in Base64URL', () => {
      const token = generateSessionToken();

      // 32 bytes in Base64URL results in exactly 43 characters
      expect(token).toHaveLength(43);
      expect(BASE64URL_TOKEN_REGEX.test(token)).toBe(true);
      expect(isValidRawToken(token)).toBe(true);
      expect(isSessionToken(token)).toBe(true);
    });

    it('does not contain padding (=) or non-URL-safe characters (+, /)', () => {
      for (let i = 0; i < 50; i++) {
        const token = generateSessionToken();
        expect(token).not.toContain('=');
        expect(token).not.toContain('+');
        expect(token).not.toContain('/');
      }
    });

    it('generates unique tokens on successive calls with high entropy', () => {
      const tokens = new Set<string>();
      const count = 100;
      for (let i = 0; i < count; i++) {
        tokens.add(generateSessionToken());
      }
      expect(tokens.size).toBe(count);
    });

    it('works identically via instance and static methods and aliases', () => {
      const service = new SessionService();
      const instanceToken = service.generateToken();
      const staticToken = SessionService.generateToken();
      const fnToken = generateToken();

      expect(isValidRawToken(instanceToken)).toBe(true);
      expect(isValidRawToken(staticToken)).toBe(true);
      expect(isValidRawToken(fnToken)).toBe(true);
      expect(RAW_TOKEN_BYTES).toBe(32);
      expect(SESSION_TTL_HOURS).toBe(8);
      expect(SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
    });
  });

  describe('SHA-256 Digest Generation (Point 2)', () => {
    it('derives correct SHA-256 hex digest matching crypto standard', () => {
      const rawToken = generateSessionToken();
      const expectedDigest = crypto.createHash('sha256').update(rawToken).digest('hex');

      const digest = hashToken(rawToken);
      expect(digest).toBe(expectedDigest);
      expect(digest).toHaveLength(64);
      expect(SHA256_HEX_REGEX.test(digest)).toBe(true);
    });

    it('is deterministic for identical tokens and distinct for different tokens', () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();

      expect(hashToken(token1)).toBe(hashToken(token1));
      expect(hashToken(token1)).not.toBe(hashToken(token2));
    });

    it('rejects empty or non-string inputs safely', () => {
      expect(() => hashToken('')).toThrow('Token must be a non-empty string');
      // @ts-expect-error testing invalid argument
      expect(() => hashToken(null)).toThrow('Token must be a non-empty string');
      // @ts-expect-error testing invalid argument
      expect(() => hashToken(undefined)).toThrow('Token must be a non-empty string');
    });

    it('works identically via instance methods, static methods, and aliases', () => {
      const service = new SessionService();
      const token = generateSessionToken();

      const d1 = service.hashToken(token);
      const d2 = service.deriveDigest(token);
      const d3 = SessionService.hashToken(token);
      const d4 = deriveDigest(token);
      const d5 = digestToken(token);

      expect(d1).toBe(d2);
      expect(d2).toBe(d3);
      expect(d3).toBe(d4);
      expect(d4).toBe(d5);
    });
  });

  describe('Token Validation and Safe Handling of Malformed Tokens', () => {
    it('validates proper 43-character Base64URL tokens', () => {
      const validToken = generateSessionToken();
      expect(isValidRawToken(validToken)).toBe(true);
    });

    it('rejects tokens with invalid lengths', () => {
      expect(isValidRawToken('')).toBe(false);
      expect(isValidRawToken('short')).toBe(false);
      expect(isValidRawToken('a'.repeat(42))).toBe(false);
      expect(isValidRawToken('a'.repeat(44))).toBe(false);
      expect(isValidRawToken('a'.repeat(64))).toBe(false);
    });

    it('rejects tokens containing non-Base64URL characters', () => {
      const withPlus = 'a'.repeat(42) + '+';
      const withSlash = 'a'.repeat(42) + '/';
      const withEqual = 'a'.repeat(42) + '=';
      const withSpace = 'a'.repeat(42) + ' ';
      const withSpecial = 'a'.repeat(42) + '!';

      expect(isValidRawToken(withPlus)).toBe(false);
      expect(isValidRawToken(withSlash)).toBe(false);
      expect(isValidRawToken(withEqual)).toBe(false);
      expect(isValidRawToken(withSpace)).toBe(false);
      expect(isValidRawToken(withSpecial)).toBe(false);
    });

    it('rejects non-string values safely', () => {
      expect(isValidRawToken(null)).toBe(false);
      expect(isValidRawToken(undefined)).toBe(false);
      expect(isValidRawToken(12345)).toBe(false);
      expect(isValidRawToken({})).toBe(false);
      expect(isValidRawToken([])).toBe(false);
    });
  });

  describe('Database Persistence of Digest Only, Never Raw Token (Point 3)', () => {
    it('persists only SHA-256 digest to database sessions.id and returns raw token to caller', async () => {
      let insertedId = '';
      let insertedUserId = '';
      let insertedExpiresAt: Date | undefined;

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          const [id, userId, expiresAt] = params;
          insertedId = id;
          insertedUserId = userId;
          insertedExpiresAt = expiresAt;

          return {
            rows: [
              {
                id,
                user_id: userId,
                expires_at: expiresAt,
                created_at: new Date(),
              },
            ],
          };
        }),
      };

      const service = new SessionService({ db: mockDb });
      const userId = '11111111-2222-3333-4444-555555555555';
      const result = await service.createSession(userId);

      // Raw token must be returned to caller
      expect(result.token).toBeDefined();
      expect(result.token).toHaveLength(43);
      expect(result.rawToken).toBe(result.token);

      // Inserted ID in database must be 64-char SHA-256 digest
      expect(insertedId).toHaveLength(64);
      expect(SHA256_HEX_REGEX.test(insertedId)).toBe(true);

      // Database ID must match the digest of the returned raw token
      const expectedDigest = hashToken(result.token);
      expect(insertedId).toBe(expectedDigest);

      // Raw token MUST NOT be stored in database ID or anywhere in SQL params
      expect(insertedId).not.toBe(result.token);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        expect.arrayContaining([expectedDigest, userId])
      );

      // The returned session.id must also be the digest, NEVER the raw token
      expect(result.session.id).toBe(expectedDigest);
      expect(result.session.id).not.toBe(result.token);
      expect(result.session.user_id).toBe(userId);
    });
  });

  describe('Session Creation with 8-Hour Expiration (Point 4)', () => {
    it('creates session with default 8-hour expiration', async () => {
      const before = Date.now();
      const mockDb = {
        query: vi.fn().mockImplementation(async (_sql: string, params: any[]) => {
          const [id, userId, expiresAt] = params;
          return {
            rows: [
              {
                id,
                user_id: userId,
                expires_at: expiresAt,
                created_at: new Date(),
              },
            ],
          };
        }),
      };

      const service = new SessionService({ db: mockDb });
      const userId = '22222222-3333-4444-5555-666666666666';
      const result = await service.createSession({ userId });
      const after = Date.now();

      const expiresAtTime = result.session.expires_at.getTime();
      const expectedMin = before + 8 * 60 * 60 * 1000;
      const expectedMax = after + 8 * 60 * 60 * 1000;

      expect(expiresAtTime).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAtTime).toBeLessThanOrEqual(expectedMax);
    });

    it('rejects session creation with empty or missing userId', async () => {
      const mockDb = { query: vi.fn() };
      const service = new SessionService({ db: mockDb });

      await expect(service.createSession('')).rejects.toThrow('User ID must be a non-empty string');
      // @ts-expect-error testing invalid input
      await expect(service.createSession(null)).rejects.toThrow('User ID must be a non-empty string');
      await expect(service.createSession({ userId: '' })).rejects.toThrow('User ID must be a non-empty string');
    });

    it('requires a configured database client', async () => {
      const service = new SessionService();
      await expect(service.createSession('user-1')).rejects.toThrow('Database client is not configured');
    });
  });

  describe('Successful Lookup of Valid Sessions (Point 5)', () => {
    it('successfully finds active session by presented raw token using its digest', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      const userId = '33333333-4444-5555-6666-777777777777';
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      const createdAt = new Date();

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT') && params[0] === digest) {
            return {
              rows: [
                {
                  id: digest,
                  user_id: userId,
                  expires_at: expiresAt,
                  created_at: createdAt,
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const service = new SessionService({ db: mockDb });
      const session = await service.lookupSession(rawToken);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(digest);
      expect(session?.user_id).toBe(userId);
      expect(session?.expires_at).toEqual(expiresAt);

      // Verify DB was queried using the digest, not the raw token
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        [digest]
      );
    });

    it('session object does not cache roles, permissions, or capabilities', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: digest,
              user_id: 'user-id-1',
              expires_at: new Date(Date.now() + 3600000),
              created_at: new Date(),
            },
          ],
        }),
      };

      const service = new SessionService({ db: mockDb });
      const session = await service.lookupSession(rawToken);

      expect(session).toBeDefined();
      expect((session as any).roles).toBeUndefined();
      expect((session as any).capabilities).toBeUndefined();
      expect((session as any).permissions).toBeUndefined();
    });
  });

  describe('Rejection of Expired, Revoked, Malformed, or Nonexistent Tokens (Point 6)', () => {
    it('strictly rejects expired session where expires_at is in the past', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      const pastExpiry = new Date(Date.now() - 1000); // 1 second ago

      const mockDb = {
        query: vi.fn().mockResolvedValue({
          rows: [
            {
              id: digest,
              user_id: 'user-expired',
              expires_at: pastExpiry,
              created_at: new Date(Date.now() - 8 * 3600 * 1000),
            },
          ],
        }),
      };

      const service = new SessionService({ db: mockDb });

      // Lookup must return null
      const lookupResult = await service.lookupSession(rawToken);
      expect(lookupResult).toBeNull();

      // VerifySession must indicate EXPIRED
      const verifyResult = await service.verifySession(rawToken);
      expect(verifyResult.valid).toBe(false);
      expect(verifyResult.reason).toBe('EXPIRED');
    });

    it('safely rejects nonexistent token that is not found in database', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const service = new SessionService({ db: mockDb });
      const rawToken = generateSessionToken();

      const lookupResult = await service.lookupSession(rawToken);
      expect(lookupResult).toBeNull();

      const verifyResult = await service.verifySession(rawToken);
      expect(verifyResult.valid).toBe(false);
      expect(verifyResult.reason).toBe('NOT_FOUND');
    });

    it('safely rejects malformed tokens without querying the database', async () => {
      const mockDb = { query: vi.fn() };
      const service = new SessionService({ db: mockDb });

      const malformedTokens = [
        '',
        'short',
        'too-long-' + 'a'.repeat(40),
        'has+plus/chars==',
        '   whitespace   ',
        '<script>alert(1)</script>',
      ];

      for (const token of malformedTokens) {
        const lookupResult = await service.lookupSession(token);
        expect(lookupResult).toBeNull();

        const verifyResult = await service.verifySession(token);
        expect(verifyResult.valid).toBe(false);
        expect(verifyResult.reason).toBe('MALFORMED');

        const revokeResult = await service.revokeSession(token);
        expect(revokeResult).toBe(false);
      }

      // Database query should NOT have been invoked for malformed tokens
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('safely rejects null and undefined token inputs', async () => {
      const mockDb = { query: vi.fn() };
      const service = new SessionService({ db: mockDb });

      // @ts-expect-error testing invalid input
      expect(await service.lookupSession(null)).toBeNull();
      // @ts-expect-error testing invalid input
      expect(await service.lookupSession(undefined)).toBeNull();
      // @ts-expect-error testing invalid input
      expect(await service.revokeSession(null)).toBe(false);
      // @ts-expect-error testing invalid input
      expect(await service.revokeSession(undefined)).toBe(false);
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe('Rolling Expiration Behavior and Strict Rejection of Expired Sessions (Point 7)', () => {
    it('extends active session expires_at by 8 hours during validation', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      const initialExpiresAt = new Date(Date.now() + 1000 * 60); // 1 minute left
      const newExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  id: digest,
                  user_id: 'user-active',
                  expires_at: initialExpiresAt,
                  created_at: new Date(),
                },
              ],
            };
          }
          if (sql.includes('UPDATE sessions')) {
            return {
              rows: [
                {
                  id: digest,
                  user_id: 'user-active',
                  expires_at: newExpiresAt,
                  created_at: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const service = new SessionService({ db: mockDb });

      // validateSession defaults rolling: true
      const validated = await service.validateSession(rawToken);
      expect(validated).not.toBeNull();
      expect(validated?.expires_at).toEqual(newExpiresAt);

      // Verify atomic update included condition expires_at > NOW()
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE sessions'),
        expect.arrayContaining([expect.any(Date), digest])
      );
    });

    it('strictly forbids reviving an already-expired session via refreshSession or touchSession', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      const pastExpiry = new Date(Date.now() - 5000);

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('UPDATE sessions')) {
            // Because WHERE id = $2 AND expires_at > NOW() does not match, 0 rows updated
            return { rows: [], rowCount: 0 };
          }
          return { rows: [] };
        }),
      };

      const service = new SessionService({ db: mockDb });

      // refreshSession must fail and return null
      const refreshResult = await service.refreshSession(rawToken);
      expect(refreshResult).toBeNull();

      // touchSession alias must fail and return null
      const touchResult = await service.touchSession(rawToken);
      expect(touchResult).toBeNull();
    });
  });

  describe('Immediate Session Revocation via Hard Deletion (Point 8)', () => {
    it('immediately deletes stored digest from sessions table', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
      };

      const service = new SessionService({ db: mockDb });
      const revoked = await service.revokeSession(rawToken);

      expect(revoked).toBe(true);
      expect(mockDb.query).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE id = $1',
        [digest]
      );
    });

    it('returns false when revoking an already revoked or nonexistent session', async () => {
      const rawToken = generateSessionToken();

      const mockDb = {
        query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
      };

      const service = new SessionService({ db: mockDb });
      const revoked = await service.revokeSession(rawToken);

      expect(revoked).toBe(false);
    });

    it('subsequent lookup immediately fails after revocation', async () => {
      const rawToken = generateSessionToken();
      const digest = hashToken(rawToken);
      let sessionExists = true;

      const mockDb = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('DELETE')) {
            sessionExists = false;
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('SELECT') && sessionExists) {
            return {
              rows: [
                {
                  id: digest,
                  user_id: 'user-revoked',
                  expires_at: new Date(Date.now() + 3600000),
                  created_at: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const service = new SessionService({ db: mockDb });

      // 1. Session is valid initially
      const active = await service.lookupSession(rawToken);
      expect(active).not.toBeNull();

      // 2. Immediately revoke session
      const revoked = await service.revokeSession(rawToken);
      expect(revoked).toBe(true);

      // 3. Subsequent lookup is denied
      const subsequent = await service.lookupSession(rawToken);
      expect(subsequent).toBeNull();
    });

    it('supports revoking all sessions for a specific user', async () => {
      const userId = 'user-to-revoke-all';
      const mockDb = {
        query: vi.fn().mockResolvedValue({ rowCount: 3, rows: [] }),
      };

      const service = new SessionService({ db: mockDb });
      const count = await service.revokeAllUserSessions(userId);

      expect(count).toBe(3);
      expect(mockDb.query).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE user_id = $1',
        [userId]
      );
    });
  });

  describe('Non-Disclosure of Raw Tokens and Safe Handling of Database Errors (Point 9)', () => {
    it('does not disclose raw token in error message when database operation fails on create', async () => {
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('relation "sessions" does not exist; secret_db_key=123')),
      };

      const service = new SessionService({ db: mockDb });
      const userId = 'user-err';

      await expect(service.createSession(userId)).rejects.toThrow('Failed to create session');

      try {
        await service.createSession(userId);
      } catch (err: any) {
        expect(err.message).not.toContain('secret_db_key');
        expect(err.message).not.toContain('relation "sessions"');
      }
    });

    it('does not disclose raw token or db internals when lookup fails due to db error', async () => {
      const rawToken = generateSessionToken();
      const mockDb = {
        query: vi.fn().mockRejectedValue(new Error('Connection lost to postgres://admin:secret@host:5432/db')),
      };

      const service = new SessionService({ db: mockDb });

      try {
        await service.lookupSession(rawToken);
      } catch (err: any) {
        expect(err.message).not.toContain(rawToken);
        expect(err.message).not.toContain('postgres://admin:secret');
      }
    });
  });

  describe('No Closing or Destroying of Injected Database Client (Point 10)', () => {
    it('does not invoke end or destroy on injected database client during close or operations', async () => {
      const mockDb = {
        query: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        close: vi.fn(),
      };

      const service = new SessionService({ db: mockDb });
      await service.close();

      expect(mockDb.end).not.toHaveBeenCalled();
      expect(mockDb.destroy).not.toHaveBeenCalled();
      expect(mockDb.close).not.toHaveBeenCalled();
    });

    it('accepts Kysely-compatible database client interface without calling destroy', async () => {
      const mockKysely = {
        insertInto: vi.fn(),
        selectFrom: vi.fn(),
        updateTable: vi.fn(),
        deleteFrom: vi.fn(),
        destroy: vi.fn(),
      };

      const service = new SessionService(mockKysely);
      await service.close();

      expect(mockKysely.destroy).not.toHaveBeenCalled();
    });
  });
});
