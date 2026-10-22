import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['web'],
    proxy: {
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
    },
  },
});
