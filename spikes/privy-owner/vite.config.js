import { defineConfig } from 'vite';

// The page runs on localhost:5174 (the Privy allowed origin). /api goes to the
// local step server, which holds the throwaway keys. Only VITE_ variables from
// .env.spike reach the browser bundle.
export default defineConfig({
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5175' },
  },
});
