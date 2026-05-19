// Runtime checker — layers 2 and 3 of the evaluation pipeline.
//
// Layer 2: install backend dependencies, start the generated server,
//          wait for the port to bind, probe every GET endpoint for a 2xx.
// Layer 3: parse each GET response as JSON and validate its shape against
//          the contract's responseShape / types definitions.
//
// Only GET endpoints are probed (POST/PUT/DELETE require request bodies
// that would need test-data generation — that's a future layer 4).
//
// The check runs only after the user grants permission via the
// `runtime-permission` HITL gate; the orchestrator calls this module
// only when that gate has been approved.
//
// Output: same shape as the static checker and the old LLM evaluator:
//   { passed, checks, violations, retryHints }

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getSessionDir } from '../sessions/sessionStore.js';

const INSTALL_TIMEOUT_MS  = 180_000;  // 3 min — better-sqlite3 needs to compile
const STARTUP_TIMEOUT_MS  =  30_000;  // 30 s  — time for the server to bind its port
const ENDPOINT_TIMEOUT_MS =  10_000;  // 10 s  — per-endpoint probe timeout
const PORT_POLL_INTERVAL  =     500;  // 0.5 s — TCP poll cadence

// ─────────────────────────────────────────────────────────────────────────────
// Public: command list (shown to user in the permission gate)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the human-readable list of commands that will be executed, so the
 * user can review them in the permission gate before approving.
 *
 * @param {string} stack  - 'stack-a' | 'stack-b'
 * @param {string} outputDir - absolute path to the session output directory
 * @returns {string[]}
 */
export function buildRuntimeCommands(stack, outputDir) {
  if (stack === 'stack-b') {
    return [
      `cd ${outputDir}`,
      'npm --prefix server install   # installs Express, better-sqlite3, etc.',
      `node server/index.js          # starts the backend (cwd: ${outputDir})`,
      'HTTP GET probes to each contract endpoint',
    ];
  }
  return [
    `cd ${path.join(outputDir, 'server')}`,
    'pip3 install -r requirements.txt   # installs FastAPI, uvicorn, SQLAlchemy, etc.',
    'python3 -m uvicorn app.main:app --port <PORT>',
    'HTTP GET probes to each contract endpoint',
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: run the runtime check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install deps, start the generated server, probe endpoints, validate shapes.
 *
 * @param {{
 *   sessionId: string,
 *   contract: object,
 *   stack: string,
 * }} options
 * @returns {Promise<{ passed: boolean, checks: object, violations: Array, retryHints: object }>}
 */
export async function runRuntimeCheck({ sessionId, contract, stack }) {
  const outputDir = path.join(getSessionDir(sessionId), 'output');
  const port = parseInt(contract?.backendEnv?.PORT, 10) ||
    (stack === 'stack-a' ? 8000 : 3001);

  const checks = {};
  const violations = [];
  const retryHints = {};

  let serverProc = null;

  try {
    // ── Step 1: install deps ──────────────────────────────────────────────
    const installCheck = await installDeps(stack, outputDir);
    checks['runtime-deps-installed'] = installCheck;
    if (!installCheck.passed) {
      return { passed: false, checks, violations, retryHints };
    }

    // ── Step 2: start server ──────────────────────────────────────────────
    serverProc = spawnServer(stack, outputDir, port);

    // ── Step 3: wait for port to bind ─────────────────────────────────────
    const startCheck = await waitForPort(port, STARTUP_TIMEOUT_MS);
    checks['runtime-server-starts'] = startCheck;

    if (!startCheck.passed) {
      const stderr = serverProc.stderrBuffer.slice(0, 600);
      const entryFile = entryFilePath(outputDir, stack);
      if (entryFile) {
        const detail = `Server did not bind port ${port} within ${STARTUP_TIMEOUT_MS}ms. ` +
          (stderr ? `Stderr: ${stderr}` : '');
        violations.push({ file: entryFile, type: 'other', detail, hint: detail });
        retryHints[entryFile] = `Fix startup error. Stderr:\n${stderr}`;
      }
      return { passed: false, checks, violations, retryHints };
    }

    // ── Step 4: probe GET endpoints ───────────────────────────────────────
    const getEndpoints = (contract?.endpoints || []).filter(e =>
      e.method.toUpperCase() === 'GET'
    );
    const types = contract?.types || {};

    const { endpointCheck, shapeCheck, newViolations, newHints } =
      await probeEndpoints(getEndpoints, port, types);

    checks['runtime-endpoints-respond'] = endpointCheck;
    checks['runtime-response-shapes'] = shapeCheck;
    violations.push(...newViolations);
    Object.assign(retryHints, newHints);

    const passed = Object.values(checks).every(c => c.passed);
    return { passed, checks, violations, retryHints };
  } finally {
    if (serverProc) killProc(serverProc);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: install dependencies
// ─────────────────────────────────────────────────────────────────────────────

function installDeps(stack, outputDir) {
  if (stack === 'stack-b') {
    const serverModules = path.join(outputDir, 'server', 'node_modules');
    if (existsSync(serverModules)) {
      return Promise.resolve({ passed: true, detail: 'Server node_modules already present.' });
    }
    return runCommand(
      'npm', ['--prefix', 'server', 'install', '--prefer-offline'],
      { cwd: outputDir, timeout: INSTALL_TIMEOUT_MS }
    );
  }

  // stack-a: pip install
  return runCommand(
    'pip3', ['install', '-r', 'requirements.txt', '-q', '--disable-pip-version-check'],
    { cwd: path.join(outputDir, 'server'), timeout: INSTALL_TIMEOUT_MS, needsFullPath: true }
  );
}

function runCommand(cmd, args, { cwd, timeout, needsFullPath = false }) {
  return new Promise((resolve) => {
    const env = buildEnv(needsFullPath);
    let proc;
    try {
      proc = spawn(cmd, args, { cwd, stdio: 'pipe', env, detached: false });
    } catch (err) {
      resolve({ passed: false, detail: `Failed to spawn "${cmd}": ${err.message}` });
      return;
    }

    let stderr = '';
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.stdout?.on('data', () => {});

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve({ passed: false, detail: `"${cmd} ${args[0]}" timed out after ${timeout}ms.` });
    }, timeout);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ passed: true, detail: `${cmd} completed successfully.` });
      } else {
        resolve({ passed: false, detail: `${cmd} exited ${code}: ${stderr.slice(0, 200)}` });
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ passed: false, detail: `${cmd} error: ${err.message}` });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: spawn the generated server
// ─────────────────────────────────────────────────────────────────────────────

function spawnServer(stack, outputDir, port) {
  const env = { ...buildEnv(true), PORT: String(port) };
  let proc;

  try {
    if (stack === 'stack-b') {
      proc = spawn('node', ['server/index.js'], {
        cwd: outputDir, stdio: 'pipe', env,
        // detached so we can kill the whole process group
        detached: true,
      });
    } else {
      proc = spawn(
        'python3',
        ['-m', 'uvicorn', 'app.main:app', `--port=${port}`, '--no-access-log'],
        {
          cwd: path.join(outputDir, 'server'), stdio: 'pipe', env,
          detached: true,
        }
      );
    }
  } catch (err) {
    // Return a dummy proc with an error buffer so callers don't crash.
    return { stderrBuffer: err.message, kill: () => {}, pid: null };
  }

  proc.stderrBuffer = '';
  proc.stderr.on('data', d => { proc.stderrBuffer += d.toString(); });
  proc.stdout.on('data', () => {});
  proc.on('error', () => {});
  proc.unref();

  return proc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: wait for port to bind
// ─────────────────────────────────────────────────────────────────────────────

function waitForPort(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;

    function probe() {
      const sock = new net.Socket();
      sock.setTimeout(1000);

      sock.on('connect', () => {
        sock.destroy();
        resolve({ passed: true, detail: `Server listening on port ${port}.` });
      });

      const retry = () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          resolve({
            passed: false,
            detail: `Server did not bind port ${port} within ${timeoutMs}ms.`,
          });
        } else {
          setTimeout(probe, PORT_POLL_INTERVAL);
        }
      };

      sock.on('error', retry);
      sock.on('timeout', retry);
      sock.connect(port, '127.0.0.1');
    }

    probe();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: probe GET endpoints (layers 2 + 3)
// ─────────────────────────────────────────────────────────────────────────────

async function probeEndpoints(endpoints, port, types) {
  const violations = [];
  const retryHints = {};
  const failedEndpoints = [];
  const shapeFailures = [];

  for (const ep of endpoints) {
    const url = `http://127.0.0.1:${port}${ep.path}`;
    let response;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        failedEndpoints.push({ ep, status: response.status });
      } else {
        // Layer 3: validate response shape
        let body;
        try { body = await response.json(); } catch { body = null; }

        if (body !== null && ep.responseShape) {
          const issue = checkShape(body, ep.responseShape, types);
          if (issue) shapeFailures.push({ ep, issue });
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        failedEndpoints.push({ ep, error: err.message });
      } else {
        failedEndpoints.push({ ep, error: `Timed out after ${ENDPOINT_TIMEOUT_MS}ms` });
      }
    }
  }

  for (const { ep, status, error } of failedEndpoints) {
    const detail = status
      ? `${ep.method} ${ep.path} returned HTTP ${status}`
      : `${ep.method} ${ep.path} failed: ${error}`;
    violations.push({ file: '(runtime)', type: 'other', detail, hint: `Fix the handler for ${ep.method} ${ep.path}.` });
  }

  for (const { ep, issue } of shapeFailures) {
    const detail = `${ep.method} ${ep.path} response shape mismatch: ${issue}`;
    violations.push({ file: '(runtime)', type: 'type-mismatch', detail, hint: `Fix response shape. Expected: ${ep.responseShape}` });
  }

  return {
    endpointCheck: {
      passed: failedEndpoints.length === 0,
      detail: failedEndpoints.length === 0
        ? `All ${endpoints.length} GET endpoint(s) returned 2xx.`
        : `${failedEndpoints.length}/${endpoints.length} endpoint(s) failed.`,
    },
    shapeCheck: {
      passed: shapeFailures.length === 0,
      detail: shapeFailures.length === 0
        ? 'All response shapes match the contract.'
        : `${shapeFailures.length} shape mismatch(es).`,
    },
    newViolations: violations,
    newHints: retryHints,
  };
}

/**
 * Light structural validation of a parsed response against a responseShape
 * string (as produced by the architect).
 *
 * Rules:
 *   "Foo[]"         → response must be an array
 *   "Foo"           → if Foo is in types, response must be an object (not array)
 *   "{ ... }"       → response must be an object
 *   "string" etc.   → primitive type check
 *   null/void       → always pass
 */
function checkShape(body, responseShape, types) {
  const shape = responseShape.trim();

  if (!shape || shape === 'null' || shape === 'void' || shape === 'undefined') return null;

  if (shape.endsWith('[]')) {
    return Array.isArray(body) ? null : `expected array (${shape}) but got ${typeof body}`;
  }

  if (shape.startsWith('{')) {
    return typeof body === 'object' && !Array.isArray(body)
      ? null
      : `expected object but got ${Array.isArray(body) ? 'array' : typeof body}`;
  }

  if (types[shape]) {
    return typeof body === 'object' && !Array.isArray(body)
      ? null
      : `expected object of type ${shape} but got ${Array.isArray(body) ? 'array' : typeof body}`;
  }

  if (['string', 'number', 'boolean'].includes(shape)) {
    return typeof body === shape ? null : `expected ${shape} but got ${typeof body}`;
  }

  return null; // unknown / complex shape — pass through
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildEnv(needsFullPath = false) {
  return {
    NODE_ENV: 'development',
    // Pass HOME so npm / pip can find their caches
    HOME: process.env.HOME || '',
    // Full PATH needed for npm, node, pip3, python3 to be resolvable.
    // Restricting PATH further would need careful per-machine calibration.
    PATH: process.env.PATH || '',
    ...(needsFullPath ? {} : {}),
  };
}

function killProc(proc) {
  try {
    if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

function entryFilePath(outputDir, stack) {
  if (stack === 'stack-b') {
    const f = path.join(outputDir, 'server', 'index.js');
    return existsSync(f) ? 'server/index.js' : null;
  }
  const f = path.join(outputDir, 'server', 'app', 'main.py');
  return existsSync(f) ? 'server/app/main.py' : null;
}
