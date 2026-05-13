// Deterministic project scaffolding.
//
// Produces every wrapper/auxiliary file a generated prototype needs to
// actually run (`npm install && npm run dev`). These files are pure
// templates driven by the stack registry and the architect's contract;
// no LLM is involved. Keeping them out of the LLM packager removes the
// biggest source of broken alpha generations:
//
//   - missing `client/index.html` and `client/vite.config.js`
//   - root `package.json` with the wrong/stale deps
//   - mixed-stack files (stack-b output ending up with FastAPI's
//     `requirements.txt`, or stack-a with `better-sqlite3`)
//   - no Vite `/api` proxy, so frontend `fetch('/api/...')` calls hit
//     the dev server instead of the backend
//   - SQLAlchemy-style `DATABASE_URL` passed into `better-sqlite3`
//
// The scaffold writes its files AFTER the LLM packager runs, so any
// wrapper files the LLM may have produced are overwritten by canonical
// versions. The LLM packager keeps responsibility for prose-heavy files
// (README.md, DISCLAIMER.md).
//
// Public API:
//   scaffoldProject({ sessionId, projectName, stack, contract }) → string[]

import { getStack } from '../agents/stacks.js';
import { writeOutputFile } from '../sessions/sessionStore.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pinned package versions
// ─────────────────────────────────────────────────────────────────────────────
//
// Pinned here so generated projects don't drift with whatever the
// npm registry served on the day they were generated. Bump in lockstep
// with DemoKit itself when its own client/server packages are upgraded.

const CLIENT_DEPS = Object.freeze({
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  'react-router-dom': '^6.30.0',
});

const CLIENT_DEV_DEPS = Object.freeze({
  vite: '^5.4.0',
  '@vitejs/plugin-react': '^4.3.4',
  tailwindcss: '^4.1.0',
  '@tailwindcss/vite': '^4.1.0',
});

const STACK_B_SERVER_DEPS = Object.freeze({
  express: '^5.0.0',
  'better-sqlite3': '^11.0.0',
  cors: '^2.8.5',
});

const ROOT_DEV_DEPS = Object.freeze({
  concurrently: '^9.1.0',
});

const STACK_A_REQUIREMENTS = [
  'fastapi>=0.110,<1.0',
  'uvicorn[standard]>=0.27,<1.0',
  'sqlalchemy>=2.0,<3.0',
  'pydantic>=2.0,<3.0',
  '',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// File templates
// ─────────────────────────────────────────────────────────────────────────────

function indexHtml(projectName) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${escapeHtml(projectName)}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.jsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function viteConfig(backendPort) {
  return [
    "import { defineConfig } from 'vite';",
    "import react from '@vitejs/plugin-react';",
    "import tailwindcss from '@tailwindcss/vite';",
    '',
    '// Vite dev server proxies /api to the backend so the frontend can',
    "// call `fetch('/api/...')` literally — no VITE_API_URL juggling, no",
    '// CORS preflights. Production deployments would replace this with a',
    '// reverse-proxy or by serving the built client from the backend.',
    'export default defineConfig({',
    '  plugins: [react(), tailwindcss()],',
    '  server: {',
    '    proxy: {',
    "      '/api': {",
    `        target: 'http://localhost:${backendPort}',`,
    '        changeOrigin: true,',
    '      },',
    '    },',
    '  },',
    '});',
    '',
  ].join('\n');
}

function clientPackageJson(projectName) {
  return (
    JSON.stringify(
      {
        name: `${projectName}-client`,
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: {
          dev: 'vite',
          build: 'vite build',
          preview: 'vite preview',
        },
        dependencies: { ...CLIENT_DEPS },
        devDependencies: { ...CLIENT_DEV_DEPS },
      },
      null,
      2
    ) + '\n'
  );
}

function stackBServerPackageJson(projectName) {
  return (
    JSON.stringify(
      {
        name: `${projectName}-server`,
        private: true,
        version: '0.0.1',
        type: 'module',
        main: 'index.js',
        scripts: {
          start: 'node index.js',
          dev: 'node --watch index.js',
        },
        dependencies: { ...STACK_B_SERVER_DEPS },
      },
      null,
      2
    ) + '\n'
  );
}

function rootPackageJsonStackB(projectName) {
  return (
    JSON.stringify(
      {
        name: projectName,
        private: true,
        version: '0.0.1',
        scripts: {
          // Root install is required to bring in `concurrently` (declared
          // as a root devDependency). Without it `npm run dev` fails with
          // `concurrently: command not found` even after `install:all`.
          'install:all':
            'npm install && npm --prefix client install && npm --prefix server install',
          dev: 'concurrently -k -n server,client -c cyan,magenta "npm:dev:server" "npm:dev:client"',
          'dev:client': 'npm --prefix client run dev',
          'dev:server': 'npm --prefix server run dev',
          build: 'npm --prefix client run build',
          start: 'npm --prefix server run start',
        },
        devDependencies: { ...ROOT_DEV_DEPS },
      },
      null,
      2
    ) + '\n'
  );
}

function rootPackageJsonStackA(projectName) {
  return (
    JSON.stringify(
      {
        name: projectName,
        private: true,
        version: '0.0.1',
        scripts: {
          'install:client': 'npm --prefix client install',
          'dev:client': 'npm --prefix client run dev',
          build: 'npm --prefix client run build',
        },
      },
      null,
      2
    ) + '\n'
  );
}

function envExample(contract) {
  const lines = [];
  const fe = (contract && contract.frontendEnv) || {};
  const be = (contract && contract.backendEnv) || {};

  if (Object.keys(fe).length > 0) {
    lines.push('# Frontend (Vite).');
    lines.push('# In dev the Vite proxy handles /api routing — these only');
    lines.push('# matter for production builds.');
    for (const [k, v] of Object.entries(fe)) {
      lines.push(`${k}=${v}`);
    }
    lines.push('');
  }

  if (Object.keys(be).length > 0) {
    lines.push('# Backend');
    for (const [k, v] of Object.entries(be)) {
      lines.push(`${k}=${v}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function gitignore() {
  return [
    'node_modules/',
    'dist/',
    '.env',
    '.env.local',
    '.venv/',
    '__pycache__/',
    '*.pyc',
    '*.sqlite',
    '*.sqlite3',
    '*.db',
    '.DS_Store',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deriveBackendPort(contract, stackId) {
  const stack = getStack(stackId);
  const fromContract = contract?.backendEnv?.PORT;
  const asNum = Number(fromContract);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const fromStack = Number(stack.defaultBackendEnv?.PORT);
  return Number.isFinite(fromStack) && fromStack > 0 ? fromStack : 8000;
}

function safeProjectName(projectName) {
  const slug = String(projectName || 'prototype')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'prototype';
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write every deterministic wrapper file for a finished project.
 *
 * @param {{
 *   sessionId: string,
 *   projectName: string,
 *   stack: 'stack-a' | 'stack-b',
 *   contract: object,
 * }} args
 * @returns {Promise<string[]>} relative paths written, in write order
 */
export async function scaffoldProject({
  sessionId,
  projectName,
  stack,
  contract,
}) {
  if (!sessionId) throw new TypeError('scaffoldProject: sessionId is required');
  if (!stack) throw new TypeError('scaffoldProject: stack is required');

  // Validate stack early — getStack throws on unknown ids, which gives
  // a clearer error than failing inside a write below.
  getStack(stack);

  const name = safeProjectName(projectName);
  const backendPort = deriveBackendPort(contract, stack);
  const written = [];

  async function write(relPath, content) {
    await writeOutputFile(sessionId, relPath, content);
    written.push(relPath);
  }

  await write('client/index.html', indexHtml(name));
  await write('client/vite.config.js', viteConfig(backendPort));
  await write('client/package.json', clientPackageJson(name));

  if (stack === 'stack-b') {
    await write('server/package.json', stackBServerPackageJson(name));
    await write('package.json', rootPackageJsonStackB(name));
  } else {
    await write('server/requirements.txt', STACK_A_REQUIREMENTS);
    await write('package.json', rootPackageJsonStackA(name));
  }

  await write('.env.example', envExample(contract));
  await write('.gitignore', gitignore());

  return written;
}

// Exposed for unit tests / future reuse.
export const _internals = Object.freeze({
  indexHtml,
  viteConfig,
  clientPackageJson,
  stackBServerPackageJson,
  rootPackageJsonStackB,
  rootPackageJsonStackA,
  envExample,
  gitignore,
  deriveBackendPort,
  safeProjectName,
});
