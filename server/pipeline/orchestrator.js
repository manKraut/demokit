// Pipeline orchestrator.
//
// Drives the multi-agent state machine: debrief → scope → architect → coder
// loop → evaluator (with up-to-2 retries per file) → packager. Persists
// every state transition to disk so a server restart can resume the session
// where it left off. Emits structured events the routes layer (step 6)
// turns into SSE for the UI.
//
// Public API (factory style for consistency with the rest of the codebase):
//
//   const orch = createOrchestrator({ session, agentRegistry, tokenTracker,
//                                     providerKeys, modelConfig });
//   orch.on('*', handler);            // subscribe to every event
//   orch.on('state-changed', ...);    // subscribe to a specific event
//   await orch.start();               // run until terminal state or gate
//   await orch.approve(gateName, payload);   // resume after a HITL gate
//   await orch.cancel();              // abort in-flight work
//
// Agent contract: an agent is a function that, given an input bag,
// returns either:
//   - a Promise<{ output, usage? }>          (non-streaming)
//   - an AsyncIterable<{ type: 'text' | 'output' | 'usage', ... }>  (streaming)
// Detection is by Symbol.asyncIterator on the call result.
//
// Step 4 ships orchestrator + storage only. Real agents arrive in step 5;
// until then, callers register stub agents matching this contract.

import { EventEmitter } from 'node:events';

import {
  appendTrace,
  loadArtifact,
  readOutputFile,
  saveArtifact,
  saveMeta,
  writeOutputFile,
} from '../sessions/sessionStore.js';
import { extractSignatures } from '../utils/signatureExtractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES_PER_FILE = 2;
const AGENT_TIMEOUT_MS = 90_000;

/** Pipeline step → SKILL.md sections it consumes. */
export const AGENT_SECTIONS = Object.freeze({
  debrief: [],
  scope: ['OUT_OF_SCOPE'],
  architect: ['STRUCTURE', 'OUT_OF_SCOPE'],
  coder: ['CODE', 'SIGNATURES', 'OUT_OF_SCOPE'],
  evaluator: ['EVALUATION', 'SIGNATURES', 'OUT_OF_SCOPE'],
  packager: ['PACKAGING'],
});

/** State machine — terminal states stop the loop. */
const TERMINAL_STATES = new Set(['done', 'failed']);

/** States that pause the loop until external resume. */
const GATE_STATES = new Set([
  'awaiting-scope-approval',
  'awaiting-architecture-approval',
  'awaiting-clarification',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Agent registry
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentRegistry() {
  const agents = new Map();
  return {
    register(name, fn) {
      if (typeof fn !== 'function') {
        throw new TypeError(`agent must be a function: ${name}`);
      }
      agents.set(name, fn);
    },
    get(name) {
      const fn = agents.get(name);
      if (!fn) throw new Error(`Agent not registered: ${name}`);
      return fn;
    },
    has(name) {
      return agents.has(name);
    },
    list() {
      return [...agents.keys()];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an orchestrator bound to one session.
 *
 * @param {{
 *   session: { id: string, meta: object },
 *   agentRegistry: ReturnType<typeof createAgentRegistry>,
 *   tokenTracker: import('../utils/tokenTracker.js').createTokenTracker extends (...a:any)=>infer R ? R : never,
 *   providerKeys?: Record<string, string|null>,
 *   modelConfig?: Record<string, { provider: string, model: string, temperature?: number, maxTokens?: number }>,
 * }} options
 */
export function createOrchestrator({
  session,
  agentRegistry,
  tokenTracker,
  providerKeys = {},
  modelConfig = {},
}) {
  if (!session || !session.id) throw new TypeError('session is required');
  if (!agentRegistry) throw new TypeError('agentRegistry is required');
  if (!tokenTracker) throw new TypeError('tokenTracker is required');

  const emitter = new EventEmitter();
  let cancelled = false;
  let pendingGate = null;

  // Multi-turn debrief queue. The route layer (step 6) calls
  // orchestrator.sendUserMessage(text) for each user turn; the debrief
  // loop awaits nextUserMessage() between rounds.
  const userMessageQueue = [];
  let userMessageResolver = null;

  // ── Event emission ──
  async function emit(event) {
    const enriched = { timestamp: new Date().toISOString(), ...event };
    emitter.emit(enriched.type, enriched);
    emitter.emit('*', enriched);
    try {
      await appendTrace(session.id, enriched);
    } catch (err) {
      // tracing failure should not crash the pipeline
      emitter.emit('trace-error', { error: err.message });
    }
  }

  async function setState(state, currentStep = null) {
    const previousState = session.meta.status;
    const updated = await saveMeta(session.id, { status: state, currentStep });
    session.meta = updated;
    await emit({ type: 'state-changed', from: previousState, to: state, currentStep });
  }

  async function setCurrentStep(currentStep) {
    const updated = await saveMeta(session.id, { currentStep });
    session.meta = updated;
    await emit({ type: 'progress', state: updated.status, currentStep });
  }

  // ── Agent invocation ──
  function isAsyncIterable(x) {
    return x != null && typeof x[Symbol.asyncIterator] === 'function';
  }

  async function invokeAgent(name, input, { allowStream = false } = {}) {
    const agent = agentRegistry.get(name);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Agent ${name} timed out after ${AGENT_TIMEOUT_MS}ms`));
    }, AGENT_TIMEOUT_MS);

    const agentInput = {
      input,
      signal: controller.signal,
      providerKeys,
      modelConfig: modelConfig[name] || null,
      sections: AGENT_SECTIONS[name] || [],
    };

    const startedAt = Date.now();
    await emit({ type: 'agent-start', agent: name, input: redactKeys(input) });

    try {
      const callResult = agent(agentInput);

      if (allowStream && isAsyncIterable(callResult)) {
        let usage = null;
        let output = null;
        let assistantText = '';
        for await (const event of callResult) {
          if (cancelled) {
            controller.abort();
            throw new Error('Pipeline cancelled');
          }
          if (event.type === 'text') {
            assistantText += event.text;
            await emit({ type: 'token', agent: name, text: event.text });
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else if (event.type === 'output') {
            output = event.output;
          } else {
            await emit({ type: 'agent-event', agent: name, ...event });
          }
        }
        if (usage) {
          tokenTracker.add(usage);
          tokenTracker.check();
          await saveMeta(session.id, { usage: tokenTracker.snapshot() });
        }
        await emit({
          type: 'agent-end',
          agent: name,
          output,
          usage,
          durationMs: Date.now() - startedAt,
        });
        return { output, usage, assistantText };
      }

      const result = await callResult;
      if (cancelled) throw new Error('Pipeline cancelled');
      if (result?.usage) {
        tokenTracker.add(result.usage);
        tokenTracker.check();
        await saveMeta(session.id, { usage: tokenTracker.snapshot() });
      }
      await emit({
        type: 'agent-end',
        agent: name,
        output: result?.output,
        usage: result?.usage,
        durationMs: Date.now() - startedAt,
      });
      return result || { output: null, usage: null };
    } catch (err) {
      await emit({
        type: 'agent-error',
        agent: name,
        error: { message: err.message, stack: err.stack },
        durationMs: Date.now() - startedAt,
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function redactKeys(input) {
    // Shallow redaction — keys at top level only. Sufficient for trace logging.
    if (input && typeof input === 'object') {
      const copy = { ...input };
      if ('providerKeys' in copy) copy.providerKeys = '[redacted]';
      if ('apiKey' in copy) copy.apiKey = '[redacted]';
      return copy;
    }
    return input;
  }

  // ── Gates ──
  function awaitGate(name) {
    return new Promise((resolve, reject) => {
      pendingGate = { name, resolve, reject };
    });
  }

  /**
   * Set up a gate, THEN emit the awaiting-input event. Order matters:
   * listeners that call approve() synchronously must find a pending gate.
   */
  async function gateAt(name, extra = {}) {
    const promise = awaitGate(name);
    await emit({ type: 'awaiting-input', gate: name, ...extra });
    return promise;
  }

  async function approve(gateName, payload = {}) {
    if (!pendingGate) {
      throw new Error(`No pending gate to approve (asked for: ${gateName})`);
    }
    if (pendingGate.name !== gateName) {
      throw new Error(
        `Gate mismatch: pending=${pendingGate.name}, requested=${gateName}`
      );
    }
    const gate = pendingGate;
    pendingGate = null;
    await emit({ type: 'gate-approved', gate: gateName, payload });
    gate.resolve(payload);
  }

  async function reject(gateName, reason) {
    if (!pendingGate || pendingGate.name !== gateName) return;
    const gate = pendingGate;
    pendingGate = null;
    await emit({ type: 'gate-rejected', gate: gateName, reason });
    gate.reject(new Error(`Gate ${gateName} rejected: ${reason || 'no reason'}`));
  }

  async function cancel() {
    cancelled = true;
    if (pendingGate) {
      const gate = pendingGate;
      pendingGate = null;
      gate.reject(new Error('Cancelled'));
    }
    if (userMessageResolver) {
      const r = userMessageResolver;
      userMessageResolver = null;
      r(null);
    }
    await emit({ type: 'cancelled' });
  }

  // ── Debrief multi-turn ──
  function sendUserMessage(text) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('sendUserMessage: text must be a non-empty string');
    }
    if (userMessageResolver) {
      const r = userMessageResolver;
      userMessageResolver = null;
      r(text);
    } else {
      userMessageQueue.push(text);
    }
  }

  function nextUserMessage() {
    if (userMessageQueue.length > 0) return Promise.resolve(userMessageQueue.shift());
    return new Promise((resolve) => {
      userMessageResolver = resolve;
    });
  }

  // ── Step implementations ──
  // Each step function assumes its target state is already set by the
  // driver in runOneTransition. They do work, save artifacts, and report
  // per-item progress via setCurrentStep — they don't change top-level state.

  async function runDebrief() {
    // Multi-turn loop: stay in 'debriefing' state, consuming user messages
    // until the agent yields a final structured spec via { type: 'output' }.
    const conversation = [];
    let finalOutput = null;

    while (!finalOutput && !cancelled) {
      const userMessage = await nextUserMessage();
      if (cancelled || userMessage === null) return;

      conversation.push({ role: 'user', content: userMessage });
      await emit({ type: 'user-message', text: userMessage });

      const turn = await invokeAgent(
        'debrief',
        { history: conversation, session: session.meta },
        { allowStream: true }
      );

      if (turn.assistantText) {
        conversation.push({ role: 'assistant', content: turn.assistantText });
      }
      if (turn.output) {
        finalOutput = turn.output;
      }
    }

    if (!finalOutput) {
      throw new Error('debrief did not emit a final spec before cancellation');
    }
    await saveArtifact(session.id, 'spec', finalOutput);
    if (finalOutput.projectName) {
      session.meta = await saveMeta(session.id, { projectName: finalOutput.projectName });
    }
  }

  async function runScope() {
    const spec = await loadArtifact(session.id, 'spec');
    const { output } = await invokeAgent('scope', { spec });
    if (!output?.stack) throw new Error('scope agent must return { stack }');
    session.meta = await saveMeta(session.id, { stack: output.stack });
    if (output.refinedSpec) await saveArtifact(session.id, 'spec', output.refinedSpec);
  }

  async function runArchitect() {
    const spec = await loadArtifact(session.id, 'spec');
    const { output } = await invokeAgent('architect', { spec, stack: session.meta.stack });
    if (!output?.fileTree || !output?.contract) {
      throw new Error('architect agent must return { fileTree, contract }');
    }
    await saveArtifact(session.id, 'architecture', output.fileTree);
    await saveArtifact(session.id, 'contract', output.contract);
  }

  async function runCoderLoop({ retryHints = {} } = {}) {
    const architecture = await loadArtifact(session.id, 'architecture');
    const contract = await loadArtifact(session.id, 'contract');
    let signatures = (await loadArtifact(session.id, 'signatures')) || [];

    const targets =
      Object.keys(retryHints).length > 0
        ? architecture.filter((f) => Object.prototype.hasOwnProperty.call(retryHints, f.path))
        : architecture;

    let idx = 0;
    for (const file of targets) {
      if (cancelled) return;
      idx += 1;
      await setCurrentStep(`coder:${file.path} (${idx}/${targets.length})`);

      const attempt = (session.meta.retries?.[file.path] || 0) + 1;
      const { output: body } = await invokeAgent('coder', {
        file,
        architecture,
        contract,
        signatures,
        stack: session.meta.stack,
        retryHint: retryHints[file.path] || null,
        attempt,
      });

      if (typeof body !== 'string') {
        throw new Error(`coder agent must return string output for ${file.path}`);
      }

      await writeOutputFile(session.id, file.path, body);

      const sig = extractSignatures(file.path, body);
      await emit({ type: 'signature-extracted', file: file.path, signature: sig });

      // Replace prior signature for this file, then append.
      signatures = signatures.filter((s) => s.file !== file.path);
      signatures.push(sig);
      await saveArtifact(session.id, 'signatures', signatures);
    }
  }

  async function runEvaluator() {
    const [spec, contract, signatures, architecture] = await Promise.all([
      loadArtifact(session.id, 'spec'),
      loadArtifact(session.id, 'contract'),
      loadArtifact(session.id, 'signatures'),
      loadArtifact(session.id, 'architecture'),
    ]);
    const bodies = {};
    for (const f of architecture || []) {
      const body = await readOutputFile(session.id, f.path);
      if (body !== null) bodies[f.path] = body;
    }
    const { output } = await invokeAgent('evaluator', { spec, contract, signatures, bodies });
    if (!output || typeof output.passed !== 'boolean') {
      throw new Error('evaluator must return { passed: boolean, violations, retryHints? }');
    }
    await emit({ type: 'evaluator-result', ...output });
    return output;
  }

  async function runEvaluatorWithRetries() {
    let result = await runEvaluator();
    while (!result.passed) {
      const hints = result.retryHints || {};
      const retryable = {};
      const exhausted = [];
      for (const [filePath, hint] of Object.entries(hints)) {
        const used = session.meta.retries?.[filePath] || 0;
        if (used < MAX_RETRIES_PER_FILE) retryable[filePath] = hint;
        else exhausted.push(filePath);
      }

      if (Object.keys(retryable).length === 0 || exhausted.length > 0) {
        // Hard fail — pause for user clarification.
        await setState(
          'awaiting-clarification',
          exhausted.length > 0 ? `exhausted: ${exhausted.join(', ')}` : 'no retryable hints'
        );
        const clarification = await gateAt('evaluator-clarification', { report: result });
        const newHints = clarification.retryHints || {};

        // Reset retry counters for files the user explicitly clarified.
        const newRetries = { ...(session.meta.retries || {}) };
        for (const filePath of Object.keys(newHints)) newRetries[filePath] = 0;
        session.meta = await saveMeta(session.id, { retries: newRetries });

        Object.assign(retryable, newHints);
      }

      // Bump retry counters for the files we're about to re-code.
      const bumped = { ...(session.meta.retries || {}) };
      for (const filePath of Object.keys(retryable)) {
        bumped[filePath] = (bumped[filePath] || 0) + 1;
      }
      session.meta = await saveMeta(session.id, { retries: bumped });

      await emit({ type: 'evaluator-retry', files: Object.keys(retryable) });
      await setState('coding');
      await runCoderLoop({ retryHints: retryable });
      await setState('evaluating');
      result = await runEvaluator();
    }
    return result;
  }

  async function runPackager() {
    const [spec, contract, architecture] = await Promise.all([
      loadArtifact(session.id, 'spec'),
      loadArtifact(session.id, 'contract'),
      loadArtifact(session.id, 'architecture'),
    ]);
    const { output } = await invokeAgent('packager', {
      spec,
      contract,
      architecture,
      stack: session.meta.stack,
    });
    if (!output?.files || typeof output.files !== 'object') {
      throw new Error('packager agent must return { files: { relPath: content, ... } }');
    }
    for (const [relPath, content] of Object.entries(output.files)) {
      await writeOutputFile(session.id, relPath, content);
    }
  }

  // ── State-machine driver ──
  // The driver owns state transitions. It sets the new state, calls the
  // matching step function, then sets the next state. Step functions
  // assume their state is already set on entry.
  async function runOneTransition() {
    const status = session.meta.status;

    switch (status) {
      case 'idle':
      case 'debriefing':
        if (status !== 'debriefing') await setState('debriefing');
        await runDebrief();
        await setState('awaiting-scope-approval');
        return;

      case 'awaiting-scope-approval':
        await gateAt('scope-approval');
        await setState('scoping');
        await runScope();
        await setState('architecting');
        await runArchitect();
        await setState('awaiting-architecture-approval');
        return;

      case 'scoping':
        await runScope();
        await setState('architecting');
        await runArchitect();
        await setState('awaiting-architecture-approval');
        return;

      case 'architecting':
        await runArchitect();
        await setState('awaiting-architecture-approval');
        return;

      case 'awaiting-architecture-approval':
        await gateAt('architecture-approval');
        await setState('coding');
        return;

      case 'coding':
        await runCoderLoop();
        await setState('evaluating');
        return;

      case 'evaluating': {
        const result = await runEvaluatorWithRetries();
        if (result.passed) await setState('packaging');
        return;
      }

      case 'awaiting-clarification':
        // If we land here at the top of the loop, the previous transition
        // was interrupted (e.g. server restart). Re-enter evaluating to
        // surface the report again.
        await setState('evaluating');
        return;

      case 'packaging':
        await runPackager();
        await setState('done');
        return;

      default:
        throw new Error(`Unknown state: ${status}`);
    }
  }

  /**
   * Drive the pipeline forward from the current persisted state until it
   * reaches a terminal state ('done' or 'failed'). Gates inside are awaited
   * via approve()/reject() called externally.
   */
  async function start() {
    while (!cancelled && !TERMINAL_STATES.has(session.meta.status)) {
      try {
        await runOneTransition();
      } catch (err) {
        await saveMeta(session.id, {
          status: 'failed',
          error: { message: err.message, stack: err.stack },
        });
        session.meta = await saveMeta(session.id, {});
        await emit({
          type: 'error',
          error: { message: err.message, stack: err.stack },
        });
        throw err;
      }
    }
    if (TERMINAL_STATES.has(session.meta.status) || GATE_STATES.has(session.meta.status)) {
      await emit({ type: 'pipeline-paused', status: session.meta.status });
    }
  }

  return {
    on(eventName, handler) {
      emitter.on(eventName, handler);
    },
    off(eventName, handler) {
      emitter.off(eventName, handler);
    },
    start,
    approve,
    reject,
    cancel,
    sendUserMessage,
    get session() {
      return session;
    },
    get pendingGate() {
      return pendingGate ? pendingGate.name : null;
    },
  };
}
