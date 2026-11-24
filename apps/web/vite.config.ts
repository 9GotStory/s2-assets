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
  // F007-T5 (#159): Retirement Corrections; no SPA route starts with /retirements.
  '/retirements': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  // F008-T1 (#176): the Stock Material catalog; the list, the form and a Stock Material's page are the SPA routes
  // /stock-materials, /stock-materials/new and /stock-materials/:id.
  '/stock-materials': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F009-T1 (#203): the Requestable Materials; the list, the form and a Requestable Material's page are the SPA routes
  // /requestable-materials, /requestable-materials/new and /requestable-materials/:id.
  '/requestable-materials': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F009-T4 (#206): the Requester's Material Requests; "คำขอของฉัน", "สร้างคำขอเบิก" and a Material Request's page are
  // the SPA routes /my-material-requests, /my-material-requests/new and /material-requests/:id.
  '/my-material-requests': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  '/material-requests': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F010-T2 (#233): the Opening Balances; the list, the Draft form and an Opening Balance's page are the SPA routes
  // /opening-balances, /opening-balances/new, /opening-balances/:id and /opening-balances/:id/edit.
  '/opening-balances': {
    target: 'http://api:3000',
    changeOrigin: true,
    bypass: (req) => {
      if (req.headers.accept?.includes('text/html')) {
        return '/index.html';
      }
    },
  },
  // F009-T4 (#206): the offered Requestable Materials a Requester asks for; no SPA route starts with
  // /offered-requestable-materials.
  '/offered-requestable-materials': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  // F008-T1 (#176): the Unit list of the Stock Material catalog; no SPA route starts with /units.
  '/units': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  // F008-T4 (#179): the Brand and Material Category lists of the Stock Material catalog; no SPA route starts with
  // /brands or /material-categories.
  '/brands': {
    target: 'http://api:3000',
    changeOrigin: true,
  },
  '/material-categories': {
    target: 'http://api:3000',
    changeOrigin: true,
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
