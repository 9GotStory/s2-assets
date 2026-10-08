import { describe, it, expect } from 'vitest';
// @ts-expect-error - Expected RED state in T010: apps/api/src/config/env.ts will be implemented in T011
import { loadConfig } from '../../src/config/env.ts';

describe('Configuration Validation (T010)', () => {
  const validBaseEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgresql://s2_user:s2_password@postgres:5432/s2_assets',
  };

  describe('Valid Configuration Baseline', () => {
    it('accepts valid configuration and coerces port to number', () => {
      const config = loadConfig(validBaseEnv);
      expect(config.NODE_ENV).toBe('development');
      expect(config.PORT).toBe(3000);
      expect(config.DATABASE_URL).toBe(validBaseEnv.DATABASE_URL);
    });

    it('applies default PORT and NODE_ENV when optional fields are omitted', () => {
      const config = loadConfig({
        DATABASE_URL: 'postgresql://s2_user:s2_password@postgres:5432/s2_assets',
      });
      expect(config.PORT).toBe(3000);
      expect(config.NODE_ENV).toBe('development');
    });

    it('accepts valid production NODE_ENV', () => {
      const config = loadConfig({
        ...validBaseEnv,
        NODE_ENV: 'production',
      });
      expect(config.NODE_ENV).toBe('production');
    });

    it('accepts valid test NODE_ENV', () => {
      const config = loadConfig({
        ...validBaseEnv,
        NODE_ENV: 'test',
      });
      expect(config.NODE_ENV).toBe('test');
    });
  });

  describe('Missing Required Configuration', () => {
    it('rejects when empty environment object is provided', () => {
      expect(() => loadConfig({})).toThrow();
    });

    it('rejects when DATABASE_URL is missing', () => {
      const { DATABASE_URL: _, ...envWithoutDb } = validBaseEnv;
      expect(() => loadConfig(envWithoutDb)).toThrow();
    });

    it('rejects when DATABASE_URL is an empty string', () => {
      expect(() => loadConfig({ ...validBaseEnv, DATABASE_URL: '' })).toThrow();
    });
  });

  describe('Malformed Required Configuration', () => {
    it('rejects DATABASE_URL with non-postgresql protocol', () => {
      expect(() => loadConfig({ ...validBaseEnv, DATABASE_URL: 'http://localhost:5432/db' })).toThrow();
      expect(() => loadConfig({ ...validBaseEnv, DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow();
    });

    it('rejects unparseable DATABASE_URL string', () => {
      expect(() => loadConfig({ ...validBaseEnv, DATABASE_URL: 'not-a-valid-url' })).toThrow();
    });

    it('rejects non-numeric PORT values', () => {
      expect(() => loadConfig({ ...validBaseEnv, PORT: 'abc' })).toThrow();
      expect(() => loadConfig({ ...validBaseEnv, PORT: '3000bad' })).toThrow();
    });

    it('rejects out-of-range PORT values', () => {
      expect(() => loadConfig({ ...validBaseEnv, PORT: '-1' })).toThrow();
      expect(() => loadConfig({ ...validBaseEnv, PORT: '0' })).toThrow();
      expect(() => loadConfig({ ...validBaseEnv, PORT: '65536' })).toThrow();
    });

    it('rejects non-integer PORT values', () => {
      expect(() => loadConfig({ ...validBaseEnv, PORT: '3000.5' })).toThrow();
    });

    it('rejects unrecognized NODE_ENV values', () => {
      expect(() => loadConfig({ ...validBaseEnv, NODE_ENV: 'staging' })).toThrow();
      expect(() => loadConfig({ ...validBaseEnv, NODE_ENV: 'local' })).toThrow();
    });
  });

  describe('Ready Operational Path Protection', () => {
    it('fails closed immediately and prevents entering operational state when config is invalid', () => {
      let operationalStateEntered = false;

      expect(() => {
        const config = loadConfig({ ...validBaseEnv, DATABASE_URL: 'malformed' });
        if (config) {
          operationalStateEntered = true;
        }
      }).toThrow();

      expect(operationalStateEntered).toBe(false);
    });

    it('does not leak secret credentials in error messages when validation fails', () => {
      const secretPassword = 'SYNTHETIC_SECRET_PASSWORD_DO_NOT_LEAK';
      const malformedDbUrlWithSecret = `postgresql://user:${secretPassword}@invalid-domain:badport/db`;

      // 1. Explicitly assert that the malformed DATABASE_URL is rejected
      expect(() => {
        loadConfig({ ...validBaseEnv, DATABASE_URL: malformedDbUrlWithSecret });
      }).toThrow();

      // 2. Assert that the resulting error message does not expose the synthetic password
      let thrownError: unknown;
      try {
        loadConfig({ ...validBaseEnv, DATABASE_URL: malformedDbUrlWithSecret });
      } catch (error: unknown) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      const errorMessage = thrownError instanceof Error ? thrownError.message : String(thrownError);
      expect(errorMessage).not.toContain(secretPassword);
    });
  });
});
