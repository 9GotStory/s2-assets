import { defineConfig, type ProxyOptions } from 'vite';

export const repositoryProxyConfig: Record<string, ProxyOptions> = {
  '/auth': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  '/system': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  '/assets': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  '/acquisitions': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  '/evidence': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  '/loans': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F005-T1 (#99): Repair Records; a Repair Record page is the SPA route /repairs/:id.
  '/repairs': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F006-T1 (#126): Verification Rounds; the Round list and a Round page are the SPA routes /verification-rounds and /verification-rounds/:id.
  '/verification-rounds': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // T4 (#25): reference lists; the maintenance page is the SPA route /admin/references.
  '/references': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
};

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['web'],
    proxy: repositoryProxyConfig,
  },
});
