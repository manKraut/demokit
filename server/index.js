// Express bootstrap.
//
// Exports `createApp()` so tests can boot the server on an ephemeral
// port without side effects. Running this file directly starts the
// server on PORT (default 8787) for local development.

import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';

import { createApiRouter } from './routes/api.js';

const DEFAULT_PORT = Number(process.env.PORT) || 8787;

/**
 * Build a fully wired Express app. No side effects (no listen() call).
 *
 * @returns {express.Express}
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // CORS: DemoKit is a local dev tool. The Vite dev server runs on
  // 5173 by default; allow any localhost origin so other devs running
  // on alternate ports don't have to fiddle with config.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // curl / same-origin
        try {
          const { hostname } = new URL(origin);
          if (hostname === 'localhost' || hostname === '127.0.0.1') return cb(null, true);
        } catch {
          // fall through to deny
        }
        cb(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: false,
    })
  );

  app.use(express.json({ limit: '2mb' }));

  app.use('/api', createApiRouter());

  // Default 404
  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // Final error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[api error]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}

/**
 * Start an HTTP server on the given port. Returns { server, port }.
 * Pass port=0 to bind to an ephemeral port (useful for tests).
 */
export function startServer(port = DEFAULT_PORT) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' ? addr.port : port });
    });
    server.on('error', reject);
  });
}

// Run directly: `node server/index.js`
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer(DEFAULT_PORT)
    .then(({ port }) => {
      // eslint-disable-next-line no-console
      console.log(`DemoKit server listening on http://localhost:${port}`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
