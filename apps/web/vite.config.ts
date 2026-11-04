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
