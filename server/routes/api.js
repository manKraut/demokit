// All /api/* HTTP routes for DemoKit.
//
// Responsibilities:
//   - Create / inspect / cancel sessions
//   - Start the pipeline with per-request providerKeys + modelConfig
//     (never persisted to disk)
//   - Drive the debrief multi-turn (POST /messages)
//   - Approve / reject HITL gates (POST /approve, /reject)
//   - Stream live orchestrator events over SSE (GET /events)
//   - Serve trace, artifacts, file listings, individual file reads
//   - Stream the final project as a zip download
//
// The route layer holds NO orchestration state — that lives in
// `state/activeSession.js` (in-memory, single-active) and on disk.

import { Router } from 'express';

import {
  createSession,
  loadSession,
  loadArtifact,
  readTrace,
  listOutputFiles,
  readOutputFile,
  listSessions,
} from '../sessions/sessionStore.js';
import { createOrchestrator, createAgentRegistry } from '../pipeline/orchestrator.js';
import { createTokenTracker } from '../utils/tokenTracker.js';
import { registerAgents, AGENT_NAMES } from '../agents/index.js';
import { PROVIDERS } from '../providers/index.js';
import { STACK_IDS, STACKS } from '../agents/stacks.js';
import { AGENT_MODEL_DEFAULTS } from '../agents/shared.js';
import { bridgeOrchestratorToSse } from '../utils/sse.js';
import { buildSessionZip, sanitiseFolderName } from '../utils/zipBuilder.js';
import {
  getActiveOrchestrator,
  getActiveOrchestratorFor,
  setActiveOrchestrator,
  clearActiveOrchestrator,
  activeSessionId,
} from '../state/activeSession.js';

const TOKEN_BUDGET = 300_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireActive(req, res) {
  const orch = getActiveOrchestratorFor(req.params.id);
  if (!orch) {
    res.status(409).json({
      error: 'session is not active',
      detail: 'POST /api/sessions/:id/start first, or the session was cancelled.',
      activeSessionId: activeSessionId(),
    });
    return null;
  }
  return orch;
}

function validateProviderKeys(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const p of PROVIDERS) {
    if (input[p] != null) {
      if (typeof input[p] !== 'string') {
        throw new TypeError(`providerKeys.${p} must be a string`);
      }
      out[p] = input[p];
    }
  }
  return out;
}

function validateModelConfig(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const name of AGENT_NAMES) {
    const entry = input[name];
    if (!entry) continue;
    if (typeof entry !== 'object') {
      throw new TypeError(`modelConfig.${name} must be an object`);
    }
    out[name] = {};
    for (const k of ['provider', 'model', 'baseUrl']) {
      if (entry[k] != null) {
        if (typeof entry[k] !== 'string') throw new TypeError(`modelConfig.${name}.${k} must be a string`);
        out[name][k] = entry[k];
      }
    }
    for (const k of ['temperature', 'maxTokens']) {
      if (entry[k] != null) {
        if (typeof entry[k] !== 'number') throw new TypeError(`modelConfig.${name}.${k} must be a number`);
        out[name][k] = entry[k];
      }
    }
  }
  return out;
}

async function sessionResponse(id) {
  const session = await loadSession(id);
  const orch = getActiveOrchestratorFor(id);
  return {
    sessionId: id,
    meta: session.meta,
    pendingGate: orch ? orch.pendingGate : null,
    isActive: Boolean(orch),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export function createApiRouter() {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, activeSessionId: activeSessionId() });
  });

  r.get('/meta', (_req, res) => {
    res.json({
      providers: PROVIDERS,
      stacks: STACK_IDS.map((id) => ({ id, label: STACKS[id].label })),
      agents: AGENT_NAMES,
      modelDefaults: AGENT_MODEL_DEFAULTS,
      tokenBudget: TOKEN_BUDGET,
    });
  });

  // ── Sessions ──

  r.get('/sessions', async (_req, res, next) => {
    try {
      const sessions = await listSessions();
      res.json({
        sessions,
        activeSessionId: activeSessionId(),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/sessions', async (req, res, next) => {
    try {
      const { projectName } = req.body || {};
      if (projectName != null && typeof projectName !== 'string') {
        return res.status(400).json({ error: 'projectName must be a string' });
      }
      await clearActiveOrchestrator();
      const session = await createSession({
        projectName: projectName ? sanitiseFolderName(projectName) || projectName : 'untitled',
      });
      res.status(201).json({ sessionId: session.id, meta: session.meta });
    } catch (err) {
      next(err);
    }
  });

  r.get('/sessions/:id', async (req, res, next) => {
    try {
      res.json(await sessionResponse(req.params.id));
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      next(err);
    }
  });

  r.post('/sessions/:id/start', async (req, res, next) => {
    try {
      const session = await loadSession(req.params.id);

      let providerKeys;
      let modelConfig;
      try {
        providerKeys = validateProviderKeys(req.body?.providerKeys);
        modelConfig = validateModelConfig(req.body?.modelConfig);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const registry = createAgentRegistry();
      registerAgents(registry);

      const orch = createOrchestrator({
        session,
        agentRegistry: registry,
        tokenTracker: createTokenTracker({ budget: TOKEN_BUDGET }),
        providerKeys,
        modelConfig,
      });

      // Register first so any in-flight POST /messages or GET /events in
      // the same tick finds the orchestrator. The orchestrator catches its
      // own failures, persists them, and broadcasts them via 'error' /
      // 'failed' events — so start() does not reject. The .catch below is
      // a defensive guard against unexpected exceptions only.
      await setActiveOrchestrator(req.params.id, orch);
      orch.start().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[orchestrator ${req.params.id}] unexpected start() rejection:`, err);
      });

      res.json({ started: true, sessionId: req.params.id });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      next(err);
    }
  });

  r.post('/sessions/:id/messages', (req, res) => {
    const orch = requireActive(req, res);
    if (!orch) return;
    const { text } = req.body || {};
    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'text is required (non-empty string)' });
    }
    try {
      orch.sendUserMessage(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/sessions/:id/approve', async (req, res) => {
    const orch = requireActive(req, res);
    if (!orch) return;
    const { gate, payload } = req.body || {};
    if (typeof gate !== 'string') {
      return res.status(400).json({ error: 'gate is required (string)' });
    }
    try {
      await orch.approve(gate, payload);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/sessions/:id/reject', async (req, res) => {
    const orch = requireActive(req, res);
    if (!orch) return;
    const { gate, reason } = req.body || {};
    if (typeof gate !== 'string') {
      return res.status(400).json({ error: 'gate is required (string)' });
    }
    try {
      await orch.reject(gate, reason);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/sessions/:id/cancel', async (req, res) => {
    const orch = getActiveOrchestratorFor(req.params.id);
    if (orch) await clearActiveOrchestrator();
    res.json({ ok: true, wasActive: Boolean(orch) });
  });

  // ── SSE ──

  r.get('/sessions/:id/events', (req, res) => {
    const orch = getActiveOrchestratorFor(req.params.id);
    if (!orch) {
      // SSE clients (EventSource) can't read body of an error response
      // reliably; surface as a status code + plain JSON so a normal
      // fetch() still gets the message.
      res.status(409).json({
        error: 'session is not active',
        activeSessionId: activeSessionId(),
      });
      return;
    }
    bridgeOrchestratorToSse(res, orch);
  });

  // ── Read-only views ──

  r.get('/sessions/:id/trace', async (req, res, next) => {
    try {
      const entries = await readTrace(req.params.id);
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  r.get('/sessions/:id/artifacts/:name', async (req, res) => {
    try {
      const data = await loadArtifact(req.params.id, req.params.name);
      if (data === null) {
        return res.status(404).json({ error: `Artifact "${req.params.name}" not yet produced` });
      }
      res.json(data);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.get('/sessions/:id/files', async (req, res, next) => {
    try {
      const files = await listOutputFiles(req.params.id);
      res.json({ files });
    } catch (err) {
      next(err);
    }
  });

  r.get('/sessions/:id/files/*splat', async (req, res, next) => {
    try {
      const splat = req.params.splat;
      const relPath = Array.isArray(splat) ? splat.join('/') : splat;
      if (!relPath) return res.status(400).json({ error: 'file path is required' });
      const content = await readOutputFile(req.params.id, relPath);
      if (content === null) {
        return res.status(404).json({ error: `File not found: ${relPath}` });
      }
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      next(err);
    }
  });

  // ── Zip download ──

  r.get('/sessions/:id/zip', async (req, res, next) => {
    try {
      const session = await loadSession(req.params.id);
      const folder = sanitiseFolderName(session.meta.projectName) || 'project';
      const archive = await buildSessionZip(req.params.id, folder);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${folder}.zip"`);

      archive.on('error', (err) => next(err));
      archive.pipe(res);
      archive.finalize();
    } catch (err) {
      if (/not found|no output/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      next(err);
    }
  });

  return r;
}
