// Session storage on disk.
//
// One active session at a time. Survives server restart. Layout:
//
//   server/.sessions/
//     active.json                   pointer: { id, since }
//     <id>/
//       meta.json                   id, projectName, stack, status, currentStep, usage, retries, ...
//       spec.json                   debrief output (structured spec)
//       architecture.json           architect output (file tree as array)
//       contract.json               architect output (interface contract)
//       signatures.json             accumulated signatures (array)
//       trace.jsonl                 append-only event log
//       output/                     generated source files
//
// All writes go through `atomicWrite` (tmp + rename) so a crash mid-write
// leaves the old version intact.

import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_ROOT = path.resolve(__dirname, '..', '.sessions');
const ACTIVE_FILE = path.join(SESSIONS_ROOT, 'active.json');

const ARTIFACTS = ['spec', 'architecture', 'contract', 'signatures'];

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureSessionsRoot() {
  if (!existsSync(SESSIONS_ROOT)) {
    mkdirSync(SESSIONS_ROOT, { recursive: true });
  }
}

function sessionDir(id) {
  if (!id || typeof id !== 'string' || id.includes('..') || id.includes('/')) {
    throw new Error(`Invalid session id: ${id}`);
  }
  return path.join(SESSIONS_ROOT, id);
}

function generateSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(16).slice(2, 6);
  return `${ts}-${random}`;
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

function defaultMeta(id, projectName) {
  const now = new Date().toISOString();
  return {
    id,
    projectName: projectName || 'untitled',
    stack: null,
    status: 'idle',
    currentStep: null,
    createdAt: now,
    updatedAt: now,
    usage: { input: 0, output: 0, total: 0 },
    retries: {},
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a brand new session on disk. Returns its descriptor.
 *
 * @param {{ projectName?: string }} [options]
 * @returns {Promise<{ id: string, meta: object, dir: string }>}
 */
export async function createSession({ projectName } = {}) {
  ensureSessionsRoot();
  const id = generateSessionId();
  const dir = sessionDir(id);
  await fs.mkdir(path.join(dir, 'output'), { recursive: true });

  const meta = defaultMeta(id, projectName);
  await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  await atomicWrite(path.join(dir, 'signatures.json'), '[]\n');
  await atomicWrite(path.join(dir, 'trace.jsonl'), '');

  return { id, meta, dir };
}

/**
 * Load an existing session from disk.
 *
 * @param {string} id
 * @returns {Promise<{ id: string, meta: object, dir: string }>}
 */
export async function loadSession(id) {
  const dir = sessionDir(id);
  if (!existsSync(dir)) {
    throw new Error(`Session not found: ${id}`);
  }
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  return { id, meta, dir };
}

/**
 * Merge a partial object into meta.json and persist. Returns the new meta.
 *
 * @param {string} id
 * @param {object} partial
 * @returns {Promise<object>}
 */
export async function saveMeta(id, partial) {
  const dir = sessionDir(id);
  const current = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const merged = { ...current, ...partial, updatedAt: new Date().toISOString() };
  await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Persist a named artifact as JSON. Allowed names: spec, architecture, contract, signatures.
 */
export async function saveArtifact(id, name, data) {
  if (!ARTIFACTS.includes(name)) {
    throw new Error(`Unknown artifact: ${name}. Allowed: ${ARTIFACTS.join(', ')}`);
  }
  const file = path.join(sessionDir(id), `${name}.json`);
  await atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Load a named artifact. Returns null if not yet written.
 */
export async function loadArtifact(id, name) {
  if (!ARTIFACTS.includes(name)) {
    throw new Error(`Unknown artifact: ${name}. Allowed: ${ARTIFACTS.join(', ')}`);
  }
  const file = path.join(sessionDir(id), `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * Append one JSON-encoded entry as a new line of `trace.jsonl`.
 * A `timestamp` is added automatically if not present.
 */
export async function appendTrace(id, entry) {
  const file = path.join(sessionDir(id), 'trace.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const enriched =
    entry && typeof entry === 'object' && !entry.timestamp
      ? { timestamp: new Date().toISOString(), ...entry }
      : entry;
  await fs.appendFile(file, JSON.stringify(enriched) + '\n');
}

/**
 * Read all entries from `trace.jsonl` as parsed objects.
 */
export async function readTrace(id) {
  const file = path.join(sessionDir(id), 'trace.jsonl');
  if (!existsSync(file)) return [];
  const content = await fs.readFile(file, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Write a file under `<session>/output/<relPath>`. Creates parent dirs.
 */
export async function writeOutputFile(id, relPath, content) {
  if (relPath.startsWith('/') || relPath.includes('..')) {
    throw new Error(`Invalid output path: ${relPath}`);
  }
  const file = path.join(sessionDir(id), 'output', relPath);
  await atomicWrite(file, content);
}

/**
 * Read a file from `<session>/output/<relPath>`. Returns null if missing.
 */
export async function readOutputFile(id, relPath) {
  const file = path.join(sessionDir(id), 'output', relPath);
  if (!existsSync(file)) return null;
  return fs.readFile(file, 'utf8');
}

/**
 * List every file under `<session>/output/`, returning forward-slash paths.
 */
export async function listOutputFiles(id) {
  const root = path.join(sessionDir(id), 'output');
  if (!existsSync(root)) return [];
  const out = [];
  async function walk(dir, base) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

/**
 * Return the id of the currently active session, or null if none.
 */
export async function getActiveSessionId() {
  if (!existsSync(ACTIVE_FILE)) return null;
  try {
    const { id } = JSON.parse(await fs.readFile(ACTIVE_FILE, 'utf8'));
    return id ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark `id` as the active session, or pass `null` to clear it.
 */
export async function setActiveSessionId(id) {
  ensureSessionsRoot();
  if (id === null) {
    if (existsSync(ACTIVE_FILE)) await fs.unlink(ACTIVE_FILE);
    return;
  }
  await atomicWrite(
    ACTIVE_FILE,
    JSON.stringify({ id, since: new Date().toISOString() }, null, 2) + '\n'
  );
}

/**
 * Return every session's meta, newest first.
 */
export async function listSessions() {
  ensureSessionsRoot();
  const entries = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true });
  const metas = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(SESSIONS_ROOT, e.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      metas.push(JSON.parse(await fs.readFile(metaPath, 'utf8')));
    } catch {
      // skip corrupted
    }
  }
  return metas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** Absolute path to a session's directory. */
export function getSessionDir(id) {
  return sessionDir(id);
}

/** Absolute path to the sessions root (for tests/cleanup). */
export function getSessionsRoot() {
  return SESSIONS_ROOT;
}
