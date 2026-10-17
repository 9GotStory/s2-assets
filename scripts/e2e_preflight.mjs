import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Enforce output-silent invariant at the runtime boundary
console.log = () => {};
console.error = () => {};
console.warn = () => {};
console.info = () => {};
console.debug = () => {};

const PROTOCOL_VERSION = 's2_e2e_preflight_v1';
const ALLOWED_CHECKS = new Set([
  'node_version',
  'pnpm_version',
  'playwright_declared',
  'playwright_installed',
  'web_test_script',
  'playwright_config',
  'chromium_available',
  'web_connectivity',
  'auth_spec_absent',
]);

const EXPECTED_CONFIG_SHA256 =
  'ac4512bd908d6e4b4204624d2208a0f59076d5f3101b12225aaa8d61e7bc4930';
const EXPECTED_CONFIG_BYTES = 979;

const workspaceRoot = process.env.WORKSPACE_ROOT || '/workspace';
const trustedRoot = process.env.TRUSTED_ROOT || '/trusted';
const invocationId = process.env.E2E_INVOCATION_ID || '';
const controlFilePath =
  process.env.E2E_CONTROL_FILE ||
  path.join(workspaceRoot, '.control', 'preflight.json');
const baseURL = process.env.E2E_BASE_URL || 'http://web:5173';

async function readBoundedBody(res, maxBytes = 4096) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          throw new Error('oversized_http_response');
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore reader cancellation errors
    }
  }
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (const c of chunks) {
    out += decoder.decode(c, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function writeControlFile(data) {
  try {
    const dir = path.dirname(controlFilePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify(data);
    fs.writeFileSync(controlFilePath, payload, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  } catch {
    // Fail silently without writing raw exceptions or unverified data
  }
}

function findChromiumPath() {
  const browserDir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  if (fs.existsSync(browserDir)) {
    try {
      const entries = fs.readdirSync(browserDir);
      for (const entry of entries) {
        if (entry.startsWith('chromium-')) {
          const candidate = path.join(browserDir, entry, 'chrome-linux64', 'chrome');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch {
      // Ignore errors reading browser directory
    }
  }
  const fallback = '/ms-playwright/chromium-1243/chrome-linux64/chrome';
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

async function runPreflight() {
  let currentCheck = 'node_version';
  try {
    // 1. Exact Node version check
    currentCheck = 'node_version';
    if (process.version !== 'v24.21.0') {
      throw new Error('node_version');
    }

    // 2. Exact pnpm version check
    currentCheck = 'pnpm_version';
    const pnpmRaw = execFileSync('pnpm', ['-v'], {
      encoding: 'utf8',
      maxBuffer: 1024,
      timeout: 10000,
    });
    if (pnpmRaw.trim() !== '12.9.1') {
      throw new Error('pnpm_version');
    }

    // 3. Web package declarations and installed pin
    currentCheck = 'playwright_declared';
    const pkgPath = path.join(workspaceRoot, 'apps/web/package.json');
    const pkgStat = fs.statSync(pkgPath);
    if (pkgStat.size > 65536) {
      throw new Error('playwright_declared');
    }
    const webPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (webPkg.devDependencies?.['@playwright/test'] !== '1.63.0') {
      throw new Error('playwright_declared');
    }

    currentCheck = 'playwright_installed';
    const candidateInstalledPaths = [
      path.join(workspaceRoot, 'apps/web/node_modules/@playwright/test/package.json'),
      path.join(workspaceRoot, 'node_modules/@playwright/test/package.json'),
    ];
    let installedPkg = null;
    for (const p of candidateInstalledPaths) {
      if (fs.existsSync(p)) {
        try {
          installedPkg = JSON.parse(fs.readFileSync(p, 'utf8'));
          break;
        } catch {
          // ignore read error
        }
      }
    }
    if (!installedPkg || installedPkg.version !== '1.63.0') {
      throw new Error('playwright_installed');
    }

    // 4. Web test:e2e command discovery
    currentCheck = 'web_test_script';
    if (webPkg.scripts?.['test:e2e'] !== 'playwright test') {
      throw new Error('web_test_script');
    }

    // 5. Playwright configuration validation (pure-data fingerprint verification, no evaluation)
    currentCheck = 'playwright_config';
    if (baseURL !== 'http://web:5173') {
      throw new Error('playwright_config');
    }

    let configPath = path.join(trustedRoot, 'playwright.config.ts');
    if (!fs.existsSync(configPath)) {
      configPath = path.join(workspaceRoot, 'apps/web/playwright.config.ts');
    }
    if (!fs.existsSync(configPath)) {
      throw new Error('playwright_config');
    }

    const configStat = fs.statSync(configPath);
    if (configStat.size !== EXPECTED_CONFIG_BYTES) {
      throw new Error('playwright_config');
    }

    const configBytes = fs.readFileSync(configPath);
    const computedHash = crypto.createHash('sha256').update(configBytes).digest('hex');
    if (computedHash !== EXPECTED_CONFIG_SHA256) {
      throw new Error('playwright_config');
    }

    // 6. Chromium executable availability (resolved directly from immutable image)
    currentCheck = 'chromium_available';
    const chromePath = findChromiumPath();
    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new Error('chromium_available');
    }
    const chromeVersion = execFileSync(chromePath, ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024,
      timeout: 10000,
    }).trim().toLowerCase();
    if (!chromeVersion.includes('chrome') && !chromeVersion.includes('chromium')) {
      throw new Error('chromium_available');
    }

    // 7. Runner-to-Web HTTP connectivity
    currentCheck = 'web_connectivity';
    const rootRes = await fetch(baseURL, {
      signal: AbortSignal.timeout(5000),
    });
    try {
      await rootRes.body?.cancel();
    } catch {}
    if (!rootRes.ok) {
      throw new Error('web_connectivity');
    }

    const loginURL = `${baseURL}/login`;
    const loginRes = await fetch(loginURL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!loginRes.ok) {
      throw new Error('web_connectivity');
    }
    const loginBody = await readBoundedBody(loginRes, 4096);
    if (!loginBody.includes('<html') && !loginBody.includes('<!DOCTYPE')) {
      throw new Error('web_connectivity');
    }

    // 8. Verify browser test execution boundary (auth.spec.ts must not exist)
    currentCheck = 'auth_spec_absent';
    const authSpecPath = path.join(
      workspaceRoot,
      'apps/web/tests/e2e/auth.spec.ts'
    );
    if (fs.existsSync(authSpecPath)) {
      throw new Error('auth_spec_absent');
    }

    // All assertions verified: commit finite exact-schema pass result
    const passResult = {
      protocol: PROTOCOL_VERSION,
      invocation_id: invocationId,
      status: 'pass',
      checks: {
        node_version: 'v24.21.0',
        pnpm_version: '12.9.1',
        playwright_declared: '1.63.0',
        playwright_installed: '1.63.0',
        web_test_script: 'playwright test',
        playwright_config: {
          test_dir: './tests/e2e',
          workers: 1,
          timeout: 30000,
          expect_timeout: 5000,
          output_dir: './test-results',
          base_url: 'http://web:5173',
          project_chromium: true,
        },
        chromium_available: true,
        web_connectivity: true,
        auth_spec_absent: true,
      },
    };
    writeControlFile(passResult);
    process.exit(0);
  } catch {
    const verifiedFailedCheck = ALLOWED_CHECKS.has(currentCheck)
      ? currentCheck
      : 'unknown';
    const failResult = {
      protocol: PROTOCOL_VERSION,
      invocation_id: invocationId,
      status: 'fail',
      failed_check: verifiedFailedCheck,
    };
    writeControlFile(failResult);
    process.exit(1);
  }
}

runPreflight();
