import { describe, it, expect } from 'vitest';
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

  describe('PUBLIC_APP_ORIGIN Validation (T8)', () => {
    describe('Valid Configurations & Normalization', () => {
      it('allows omitting PUBLIC_APP_ORIGIN and leaves it undefined', () => {
        const config = loadConfig(validBaseEnv);
        expect(config.PUBLIC_APP_ORIGIN).toBeUndefined();
      });

      it('treats empty string as omitted/undefined', () => {
        const config = loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: '' });
        expect(config.PUBLIC_APP_ORIGIN).toBeUndefined();
      });

      it('accepts loopback http in development and test environments', () => {
        const devConfig = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'development',
          PUBLIC_APP_ORIGIN: 'http://localhost:3000',
        });
        expect(devConfig.PUBLIC_APP_ORIGIN).toBe('http://localhost:3000');

        const testConfig = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'test',
          PUBLIC_APP_ORIGIN: 'http://127.0.0.1:8080',
        });
        expect(testConfig.PUBLIC_APP_ORIGIN).toBe('http://127.0.0.1:8080');

        const ipv6Config = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'development',
          PUBLIC_APP_ORIGIN: 'http://[::1]:3000',
        });
        expect(ipv6Config.PUBLIC_APP_ORIGIN).toBe('http://[::1]:3000');
      });

      it('normalizes trailing slash by removing it', () => {
        const config = loadConfig({
          ...validBaseEnv,
          PUBLIC_APP_ORIGIN: 'http://localhost:3000/',
        });
        expect(config.PUBLIC_APP_ORIGIN).toBe('http://localhost:3000');

        const prodConfig = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'production',
          PUBLIC_APP_ORIGIN: 'https://assets.example.com/',
        });
        expect(prodConfig.PUBLIC_APP_ORIGIN).toBe('https://assets.example.com');
      });

      it('accepts https origins in development and production', () => {
        const devConfig = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'development',
          PUBLIC_APP_ORIGIN: 'https://dev-assets.internal.example:8443',
        });
        expect(devConfig.PUBLIC_APP_ORIGIN).toBe('https://dev-assets.internal.example:8443');

        const prodConfig = loadConfig({
          ...validBaseEnv,
          NODE_ENV: 'production',
          PUBLIC_APP_ORIGIN: 'https://assets.example.com',
        });
        expect(prodConfig.PUBLIC_APP_ORIGIN).toBe('https://assets.example.com');
      });
    });

    describe('Invalid Configurations & Safety', () => {
      it('rejects HTTP in production even for loopback', () => {
        expect(() =>
          loadConfig({
            ...validBaseEnv,
            NODE_ENV: 'production',
            PUBLIC_APP_ORIGIN: 'http://assets.example.com',
          })
        ).toThrow();

        expect(() =>
          loadConfig({
            ...validBaseEnv,
            NODE_ENV: 'production',
            PUBLIC_APP_ORIGIN: 'http://localhost:3000',
          })
        ).toThrow();
      });

      it('rejects non-loopback HTTP in non-production', () => {
        expect(() =>
          loadConfig({
            ...validBaseEnv,
            NODE_ENV: 'development',
            PUBLIC_APP_ORIGIN: 'http://assets.internal.example',
          })
        ).toThrow();

        expect(() =>
          loadConfig({
            ...validBaseEnv,
            NODE_ENV: 'test',
            PUBLIC_APP_ORIGIN: 'http://192.168.1.100:3000',
          })
        ).toThrow();
      });

      it('rejects userinfo, query, fragment, and non-root paths', () => {
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://user:pass@example.com' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com/assets' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com?query=1' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com#section' })
        ).toThrow();
      });

      it('rejects wildcard bind hosts', () => {
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'http://0.0.0.0:3000' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'http://[::]:3000' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://*' })
        ).toThrow();
      });

      it('rejects whitespace, control characters, and backslashes', () => {
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'http://localhost:3000 ' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example\x00.com' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com\\path' })
        ).toThrow();
      });

      it('rejects invalid ports and values exceeding 512 bytes', () => {
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com:0' })
        ).toThrow();

        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com:65536' })
        ).toThrow();

        const longDomain = 'https://' + 'a'.repeat(510) + '.com';
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: longDomain })
        ).toThrow();

        // Multibyte string under 512 characters but exceeding 512 UTF-8 bytes (180 Thai chars * 3 bytes + 20 bytes = 560 bytes)
        const multibyteOrigin = 'https://example.com/' + 'ก'.repeat(180);
        expect(multibyteOrigin.length).toBeLessThan(512);
        expect(Buffer.byteLength(multibyteOrigin, 'utf8')).toBeGreaterThan(512);
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: multibyteOrigin })
        ).toThrow();
      });

      it('rejects raw syntax bypasses prior to WHATWG parser normalization', () => {
        // Missing slash after scheme
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https:example.com' })
        ).toThrow();

        // Query string marker
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com?' })
        ).toThrow();

        // Fragment marker
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com#' })
        ).toThrow();

        // Userinfo marker (including empty userinfo)
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://@example.com' })
        ).toThrow();

        // Relative path segments
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com/./' })
        ).toThrow();
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://example.com/../' })
        ).toThrow();

        // Empty authority
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https://' })
        ).toThrow();
        expect(() =>
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: 'https:///example.com' })
        ).toThrow();
      });

      it('does not echo invalid origin input in error messages', () => {
        const sensitiveHost = 'very-secret-internal-host-do-not-echo.corp';
        const invalidOrigin = `http://${sensitiveHost}/forbidden-path`;

        let thrownError: unknown;
        try {
          loadConfig({ ...validBaseEnv, PUBLIC_APP_ORIGIN: invalidOrigin });
        } catch (err) {
          thrownError = err;
        }

        expect(thrownError).toBeDefined();
        const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
        expect(msg).not.toContain(sensitiveHost);
        expect(msg).not.toContain(invalidOrigin);
      });
    });
  });
});
