// Deterministic static checker — replaces the LLM evaluator for all
// contract-conformance checks that can be verified without running the app.
//
// All nine required checks are implemented here as pure functions over
// the same inputs the LLM evaluator received. No network calls, no LLM,
// no side effects. Same output shape as the LLM evaluator:
//
//   { passed, checks, violations, retryHints }
//
// where `checks` is a map of check-name → { passed: bool, detail: string }.

import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Known package sets (used by imports-resolve)
// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_PKGS = new Set([
  'react', 'react-dom', 'react-router-dom',
  'tailwindcss', '@tailwindcss/vite', '@vitejs/plugin-react', 'vite',
]);

const STACK_B_SERVER_PKGS = new Set([
  'express', 'better-sqlite3', 'cors', 'csv-parse', 'csv-parse/sync',
]);

const STACK_A_SERVER_PKGS = new Set([
  'fastapi', 'uvicorn', 'sqlalchemy', 'pydantic', 'starlette',
  'pydantic_settings', 'alembic', 'passlib', 'jose', 'python-jose',
  'email_validator', 'httpx', 'requests',
]);

const NODE_STDLIB = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'repl', 'stream', 'stream/promises',
  'string_decoder', 'timers', 'timers/promises', 'tls', 'tty', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const PYTHON_STDLIB = new Set([
  'os', 'sys', 'json', 're', 'csv', 'pathlib', 'datetime', 'typing',
  'enum', 'abc', 'collections', 'copy', 'functools', 'itertools', 'io',
  'math', 'random', 'string', 'time', 'types', 'uuid', 'hashlib', 'hmac',
  'base64', 'sqlite3', 'decimal', 'struct', 'contextlib', 'dataclasses',
  'inspect', 'warnings', 'logging', 'traceback', 'threading', 'asyncio',
  'http', 'urllib', 'email', 'html', 'xml', 'pprint', 'operator',
  'textwrap', 'unicodedata', 'tempfile', 'shutil', 'glob', 'fnmatch',
  'pickle', '__future__', 'typing_extensions', 'importlib',
]);

// Out-of-scope mock modules (the only names allowed under src/mocks/).
const ALLOWED_MOCK_NAMES = new Set([
  'auth', 'payments', 'notify', 'push', 'uploads', 'realtime', 'ai',
]);

// Backend packages that indicate a direct (non-mocked) out-of-scope concern.
const OUT_OF_SCOPE_BACKEND_LIBS = [
  'passport', 'express-session', 'jsonwebtoken', 'auth0', 'firebase-admin',
  'stripe', 'paypal', 'braintree', 'square',
  'nodemailer', '@sendgrid/mail', 'twilio', 'mailgun-js',
  'socket.io', 'ws',
  'multer', 'aws-sdk', '@aws-sdk/client-s3', 'cloudinary',
];

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all nine deterministic checks and return a combined verdict.
 *
 * @param {{
 *   spec: object,
 *   contract: object,
 *   signatures: Array,
 *   architecture: Array,
 *   bodies: Record<string,string>,
 *   stack: string,
 *   stackDefaults: Record<string,string>,
 * }} inputs
 * @returns {{ passed: boolean, checks: object, violations: Array, retryHints: object }}
 */
export function runStaticChecks({ spec, contract, signatures, architecture, bodies, stack, stackDefaults }) {
  const checks = {};
  const violations = [];
  const retryHints = {};

  const ctx = {
    spec: spec || {},
    contract: contract || {},
    signatures: signatures || [],
    architecture: architecture || [],
    bodies: bodies || {},
    stack: stack || '',
    stackDefaults: stackDefaults || {},
    violations,
    retryHints,
    // Pre-built lookup sets
    fileTreePaths: buildFileTreePaths(architecture),
    contractEndpoints: (contract?.endpoints || []),
    contractEndpointKeys: new Set((contract?.endpoints || []).map(e => `${e.method.toUpperCase()} ${e.path}`)),
    contractTableNames: new Set((contract?.db?.tables || []).map(t => t.name.toLowerCase())),
  };

  checks['frontend-renders-once']               = checkFrontendRendersOnce(ctx);
  checks['stack-defaults-respected']             = checkStackDefaults(ctx);
  checks['seed-data-when-tables-exist']          = checkSeedData(ctx);
  checks['frontend-endpoints-in-contract']       = checkFrontendEndpointsInContract(ctx);
  checks['backend-endpoints-implement-contract'] = checkBackendImplementsContract(ctx);
  checks['env-vars-declared']                    = checkEnvVarsDeclared(ctx);
  checks['imports-resolve']                      = checkImportsResolve(ctx);
  checks['out-of-scope-via-mocks-only']          = checkOutOfScope(ctx);
  checks['tables-in-contract']                   = checkTablesInContract(ctx);

  const passed = Object.values(checks).every(c => c.passed);
  return { passed, checks, violations, retryHints };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 1: frontend-renders-once
// ─────────────────────────────────────────────────────────────────────────────

function checkFrontendRendersOnce({ bodies, violations, retryHints }) {
  const failing = [];

  for (const [filePath, body] of Object.entries(bodies)) {
    if (!filePath.startsWith('client/')) continue;
    if (!filePath.endsWith('.jsx') && !filePath.endsWith('.tsx')) continue;
    if (filePath === 'client/src/main.jsx') continue;

    const routerImport = /import\s*\{[^}]*\b(BrowserRouter|HashRouter|MemoryRouter)\b[^}]*\}\s*from\s*['"]react-router-dom['"]/.test(body);
    const routerJsx = /<(BrowserRouter|HashRouter|MemoryRouter|Router)[\s>\/]/.test(body);

    if (routerImport || routerJsx) {
      failing.push(filePath);
      const hint = `Remove the <BrowserRouter>/<Router> wrapper from ${filePath}. ` +
        `The router is provided by the scaffolded client/src/main.jsx; emit only <Routes> and <Route> children.`;
      violations.push({ file: filePath, type: 'multiple-routers', detail: hint, hint });
      retryHints[filePath] = hint;
    }
  }

  return {
    passed: failing.length === 0,
    detail: failing.length === 0
      ? 'No duplicate React Router wrappers found.'
      : `${failing.length} file(s) wrap a second Router: ${failing.join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 2: stack-defaults-respected
// ─────────────────────────────────────────────────────────────────────────────

function checkStackDefaults({ contract, stackDefaults, violations, retryHints }) {
  if (!stackDefaults || Object.keys(stackDefaults).length === 0) {
    return { passed: true, detail: 'No stack defaults to check.' };
  }

  const backendEnv = contract?.backendEnv || {};
  const issues = [];

  for (const [key, expected] of Object.entries(stackDefaults)) {
    const actual = backendEnv[key];
    if (actual !== expected) {
      issues.push(`${key}: expected "${expected}", got "${actual ?? '(missing)'}"`);
      violations.push({
        file: '(contract)',
        type: 'stack-defaults-mismatch',
        detail: `contract.backendEnv.${key} is "${actual}" but stack default is "${expected}".`,
        hint: `Re-architect with ${key}="${expected}".`,
      });
    }
  }

  if (issues.length > 0) {
    retryHints['(contract)'] = `Fix contract.backendEnv: ${issues.join('; ')}. Re-architect.`;
  }

  return {
    passed: issues.length === 0,
    detail: issues.length === 0
      ? 'contract.backendEnv matches stack defaults.'
      : `Mismatch(es): ${issues.join('; ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 3: seed-data-when-tables-exist
// ─────────────────────────────────────────────────────────────────────────────

function checkSeedData({ contract, bodies, stack, violations, retryHints }) {
  const tables = contract?.db?.tables || [];
  if (tables.length === 0) {
    return { passed: true, detail: 'No tables declared — seed check skipped.' };
  }

  const backendBodies = Object.entries(bodies).filter(([f]) => !f.startsWith('client/'));
  const unseeded = [];

  for (const table of tables) {
    const name = table.name;
    const createRe = new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${escapeRe(name)}["'\`]?`, 'i'
    );

    // Find the file that declares this table's CREATE TABLE
    const dbFile = backendBodies.find(([, b]) => createRe.test(b));
    if (!dbFile) {
      unseeded.push(name);
      continue;
    }

    const [dbFilePath, dbBody] = dbFile;
    const stackBSeed = /INSERT\s+INTO/i.test(dbBody);
    const stackASeed = /session\.add\s*\(|INSERT\s+(?:INTO\s+)?\w/i.test(dbBody);
    const hasSeed = stack === 'stack-a' ? stackASeed : stackBSeed;

    if (!hasSeed) {
      unseeded.push(name);
      const hint = `Add seed rows for table "${name}" in ${dbFilePath} ` +
        `(guarded by COUNT(*) == 0 check so it's idempotent).`;
      violations.push({ file: dbFilePath, type: 'missing-seed', detail: hint, hint });
      retryHints[dbFilePath] = appendHint(retryHints[dbFilePath], hint);
    }
  }

  return {
    passed: unseeded.length === 0,
    detail: unseeded.length === 0
      ? `All ${tables.length} table(s) have seed data.`
      : `Missing seed data for: ${unseeded.join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 4: frontend-endpoints-in-contract
// ─────────────────────────────────────────────────────────────────────────────

function checkFrontendEndpointsInContract({ signatures, contractEndpointKeys, violations, retryHints }) {
  const unknown = [];

  for (const sig of signatures) {
    if (!sig.file.startsWith('client/')) continue;
    for (const call of sig.calls || []) {
      if (!contractEndpointKeys.has(call)) {
        unknown.push({ file: sig.file, call });
        const hint = `Remove or correct the call to "${call}" — not in contract.endpoints. ` +
          `Allowed: ${[...contractEndpointKeys].join(', ') || '(none)'}`;
        violations.push({ file: sig.file, type: 'unknown-endpoint', detail: hint, hint });
        retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
      }
    }
  }

  return {
    passed: unknown.length === 0,
    detail: unknown.length === 0
      ? 'All frontend fetch calls map to contract.endpoints.'
      : `${unknown.length} unknown endpoint call(s): ${unknown.map(u => u.call).join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 5: backend-endpoints-implement-contract
// ─────────────────────────────────────────────────────────────────────────────

function checkBackendImplementsContract({ contract, bodies, stack, violations, retryHints }) {
  const endpoints = contract?.endpoints || [];
  const missing = [];

  for (const ep of endpoints) {
    const method = ep.method.toLowerCase();
    const epPath = ep.path;
    let found = false;

    for (const [filePath, body] of Object.entries(bodies)) {
      if (filePath.startsWith('client/')) continue;

      let re;
      if (stack === 'stack-a') {
        re = new RegExp(`@(?:router|app)\\.${method}\\s*\\(\\s*["']${escapeRe(epPath)}["']`);
      } else {
        re = new RegExp(`(?:router|app)\\.${method}\\s*\\(\\s*['"]${escapeRe(epPath)}['"]`);
      }

      if (re.test(body)) {
        found = true;
        break;
      }
    }

    if (!found) {
      missing.push(`${ep.method} ${epPath}`);
      const routeFile = guessRouteFile(bodies, epPath);
      const hint = `Add a ${ep.method} handler for "${epPath}".`;
      violations.push({ file: routeFile || '(backend)', type: 'missing-endpoint', detail: hint, hint });
      if (routeFile) retryHints[routeFile] = appendHint(retryHints[routeFile], hint);
    }
  }

  return {
    passed: missing.length === 0,
    detail: missing.length === 0
      ? `All ${endpoints.length} contract endpoint(s) are implemented.`
      : `Missing implementation(s): ${missing.join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 6: env-vars-declared (+ env-default-missing)
// ─────────────────────────────────────────────────────────────────────────────

function checkEnvVarsDeclared({ signatures, contract, bodies, violations, retryHints }) {
  const frontendEnvKeys = new Set(Object.keys(contract?.frontendEnv || {}));
  const backendEnvKeys = new Set(Object.keys(contract?.backendEnv || {}));
  const issues = [];

  for (const sig of signatures) {
    const isFrontend = sig.file.startsWith('client/');
    const isJs = ['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(sig.file));
    const body = bodies[sig.file] || '';

    for (const envVar of sig.envVars || []) {
      const knownKeys = isFrontend ? frontendEnvKeys : backendEnvKeys;

      if (!knownKeys.has(envVar)) {
        issues.push(`${sig.file}: ${envVar}`);
        const hint = `Remove use of env var "${envVar}" — not in contract.${isFrontend ? 'frontendEnv' : 'backendEnv'}.`;
        violations.push({ file: sig.file, type: 'env-var-mismatch', detail: hint, hint });
        retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
        continue;
      }

      // For backend JS files, check for missing || default
      if (!isFrontend && isJs && body) {
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes(`process.env.${envVar}`)) continue;
          const nextLine = lines[i + 1] || '';
          const hasFallback = line.includes('||') || line.includes('??') ||
            nextLine.trimStart().startsWith('||') || nextLine.trimStart().startsWith('??');
          if (!hasFallback) {
            issues.push(`${sig.file}: ${envVar} missing default`);
            const hint = `Add a fallback: process.env.${envVar} || '<stack-default>'`;
            violations.push({ file: sig.file, type: 'env-default-missing', detail: hint, hint });
            retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
            break;
          }
        }
      }

      // For backend Python files, check for os.environ["X"] (no default possible)
      if (!isFrontend && !isJs && body) {
        const bracketRe = new RegExp(`os\\.environ\\s*\\[\\s*["']${escapeRe(envVar)}["']\\s*\\]`);
        if (bracketRe.test(body)) {
          issues.push(`${sig.file}: ${envVar} missing default`);
          const hint = `Use os.getenv("${envVar}", "<default>") instead of os.environ["${envVar}"].`;
          violations.push({ file: sig.file, type: 'env-default-missing', detail: hint, hint });
          retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
        }
      }
    }
  }

  return {
    passed: issues.length === 0,
    detail: issues.length === 0
      ? 'All env vars are declared in the contract with defaults.'
      : `Issues (${issues.length}): ${issues.slice(0, 5).join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 7: imports-resolve
// ─────────────────────────────────────────────────────────────────────────────

function checkImportsResolve({ signatures, fileTreePaths, stack, violations, retryHints }) {
  const issues = [];
  const backendPkgs = stack === 'stack-a' ? STACK_A_SERVER_PKGS : STACK_B_SERVER_PKGS;

  for (const sig of signatures) {
    const isFrontend = sig.file.startsWith('client/');
    const isJs = ['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(sig.file));

    for (const imp of sig.imports || []) {
      if (imp.startsWith('node:')) continue;

      if (imp.startsWith('.')) {
        // Relative import — resolve and check against fileTree
        const dir = path.posix.dirname(sig.file);
        const resolved = path.posix.normalize(path.posix.join(dir, imp));
        const found = resolveAgainstFileTree(resolved, fileTreePaths);
        if (!found) {
          issues.push({ file: sig.file, imp });
          const hint = `Import "${imp}" (resolves to "${resolved}") is not in architecture.fileTree. ` +
            `Check the path or remove the import.`;
          violations.push({ file: sig.file, type: 'unknown-import', detail: hint, hint });
          retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
        }
      } else {
        // Bare module import
        const base = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
        const knownPkgs = isFrontend ? FRONTEND_PKGS : backendPkgs;
        const stdlib = isJs ? NODE_STDLIB : PYTHON_STDLIB;
        // Allow sub-paths of known packages (e.g. csv-parse/sync)
        const isKnown = knownPkgs.has(base) || knownPkgs.has(imp) ||
          stdlib.has(base) || stdlib.has(imp) ||
          [...knownPkgs].some(p => imp.startsWith(p + '/'));

        if (!isKnown) {
          issues.push({ file: sig.file, imp });
          const hint = `Import "${imp}" is not a known package for stack ${stack}. ` +
            `Use only packages available in the stack or remove the import.`;
          violations.push({ file: sig.file, type: 'unknown-import', detail: hint, hint });
          retryHints[sig.file] = appendHint(retryHints[sig.file], hint);
        }
      }
    }
  }

  return {
    passed: issues.length === 0,
    detail: issues.length === 0
      ? 'All imports resolve.'
      : `${issues.length} unresolvable import(s): ${issues.slice(0, 3).map(i => `"${i.imp}" in ${i.file}`).join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 8: out-of-scope-via-mocks-only
// ─────────────────────────────────────────────────────────────────────────────

function checkOutOfScope({ signatures, fileTreePaths, bodies, violations, retryHints }) {
  const issues = [];

  // Rule A: no mock file for an in-scope entity
  for (const p of fileTreePaths) {
    const m = p.match(/^client\/src\/mocks\/([^/]+)\.(js|ts|jsx)$/);
    if (!m) continue;
    const mockName = m[1];
    if (!ALLOWED_MOCK_NAMES.has(mockName)) {
      issues.push(p);
      const hint = `Remove ${p} — "${mockName}" is an in-scope CRUD entity. ` +
        `Call fetch('/api/${mockName}') directly.`;
      violations.push({ file: p, type: 'out-of-scope-violation', detail: hint, hint });
      retryHints[p] = hint;
    }
  }

  // Rule B: no backend file imports a library that implements an out-of-scope concern
  for (const [filePath, body] of Object.entries(bodies)) {
    if (filePath.startsWith('client/')) continue;
    for (const lib of OUT_OF_SCOPE_BACKEND_LIBS) {
      const re = new RegExp(
        `(?:import|require)\\s*(?:[\\w\\s{},*]+from\\s*)?["']${escapeRe(lib)}["']`
      );
      if (re.test(body)) {
        issues.push(`${filePath}: ${lib}`);
        const hint = `Remove import of "${lib}" — this is an out-of-scope concern for DemoKit. ` +
          `Backend should only implement CRUD against SQLite.`;
        violations.push({ file: filePath, type: 'out-of-scope-violation', detail: hint, hint });
        retryHints[filePath] = appendHint(retryHints[filePath], hint);
      }
    }
  }

  return {
    passed: issues.length === 0,
    detail: issues.length === 0
      ? 'All out-of-scope concerns are properly mocked.'
      : `${issues.length} out-of-scope violation(s) found.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Check 9: tables-in-contract
// ─────────────────────────────────────────────────────────────────────────────

function checkTablesInContract({ signatures, contractTableNames, bodies, violations, retryHints }) {
  const issues = [];
  const already = new Set();

  const flag = (file, table) => {
    const key = `${file}:${table}`;
    if (already.has(key)) return;
    already.add(key);
    issues.push({ file, table });
    const hint = `Table "${table}" is not in contract.db.tables. ` +
      `Use only: ${[...contractTableNames].join(', ') || '(none)'}.`;
    violations.push({ file, type: 'table-mismatch', detail: hint, hint });
    retryHints[file] = appendHint(retryHints[file], hint);
  };

  // From signatures (SQL CREATE TABLE statements)
  for (const sig of signatures) {
    for (const table of sig.tables || []) {
      if (!contractTableNames.has(table.toLowerCase())) flag(sig.file, table);
    }
  }

  // From backend file bodies (SQL DML queries)
  const DML_RE = /\b(?:SELECT\s+\S.*?\s+FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`]?(\w+)["'`]?/gi;
  for (const [filePath, body] of Object.entries(bodies)) {
    if (filePath.startsWith('client/')) continue;
    for (const m of body.matchAll(DML_RE)) {
      const table = m[1].toLowerCase();
      if (table.startsWith('sqlite_')) continue;
      if (!contractTableNames.has(table)) flag(filePath, table);
    }
  }

  return {
    passed: issues.length === 0,
    detail: issues.length === 0
      ? 'All referenced tables are declared in the contract.'
      : `Undeclared table(s): ${[...new Set(issues.map(i => i.table))].join(', ')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendHint(existing, addition) {
  return existing ? `${existing}; ${addition}` : addition;
}

/**
 * Build a normalised Set of all paths from the architecture fileTree, plus
 * extension-stripped variants so imports without extension also resolve.
 */
function buildFileTreePaths(architecture) {
  const s = new Set();
  for (const f of architecture || []) {
    s.add(f.path);
    const ext = path.posix.extname(f.path);
    if (ext) s.add(f.path.slice(0, -ext.length));
  }
  return s;
}

/**
 * Check whether a resolved (extension-stripped) import path exists in the
 * fileTree, trying common JS/Python extensions and index files.
 */
function resolveAgainstFileTree(resolved, fileTreePaths) {
  if (fileTreePaths.has(resolved)) return true;
  const jsExts = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  const pyExts = ['.py'];
  const allExts = [...jsExts, ...pyExts, '.css', '.json'];
  for (const ext of allExts) {
    if (fileTreePaths.has(resolved + ext)) return true;
  }
  for (const ext of jsExts) {
    const idx = path.posix.join(resolved, 'index' + ext);
    if (fileTreePaths.has(idx)) return true;
  }
  return false;
}

/**
 * Guess which backend file owns a given endpoint path, for attaching hints.
 * e.g. "/api/notes" → look for a file with "notes" in its path.
 */
function guessRouteFile(bodies, epPath) {
  const resource = epPath.split('/').filter(Boolean)[1]; // e.g. "notes"
  if (!resource) return null;
  for (const filePath of Object.keys(bodies)) {
    if (filePath.startsWith('client/')) continue;
    if (filePath.toLowerCase().includes(resource)) return filePath;
  }
  for (const filePath of Object.keys(bodies)) {
    if (filePath.startsWith('client/')) continue;
    if (filePath.includes('routes') || filePath.includes('route')) return filePath;
  }
  return null;
}
