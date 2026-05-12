import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// DemoKit dev setup:
//   - Vite dev server on 5173
//   - API + SSE proxied to the Express server on 8787
//
// The proxy keeps same-origin fetch/EventSource, which is the simplest
// thing that works for SSE — no CORS preflights, no custom headers
// needed from EventSource.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Vite's proxy uses http-proxy under the hood. For SSE we
        // explicitly disable response buffering by keeping ws off and
        // not setting selfHandleResponse — defaults are fine.
      },
    },
  },
});
