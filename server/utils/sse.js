// SSE (Server-Sent Events) helpers.
//
// One small surface area:
//   writeSseEvent(res, eventName, data)   — write a single named event
//   bridgeOrchestratorToSse(res, orch)    — attach SSE forwarders for every
//                                           orchestrator event + heartbeat
//
// We don't depend on Express here — only Node's response shape (writable
// stream) — so this stays testable without booting Express.

// The orchestrator's full public event set. Keep this in sync with what
// `pipeline/orchestrator.js` emits.
export const ORCHESTRATOR_EVENTS = Object.freeze([
  'state-changed',
  'progress',
  'agent-start',
  'agent-end',
  'agent-event',
  'token',
  'user-message',
  'awaiting-input',
  'gate-approved',
  'gate-rejected',
  'done',
  'failed',
  'error',
  'cancelled',
]);

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Write one SSE event. Safe to call repeatedly on the same response.
 * Falls back silently if the response is already destroyed.
 */
export function writeSseEvent(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
  } catch {
    // Client disconnected mid-write — ignore.
  }
}

/**
 * Set SSE headers and attach forwarders for every orchestrator event.
 * Emits an initial `snapshot` event so a client connecting mid-pipeline
 * can render current state without waiting for the next transition.
 *
 * Returns a cleanup function that detaches handlers and clears the
 * heartbeat. Cleanup is also wired to `res.on('close')` automatically.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<import('../pipeline/orchestrator.js').createOrchestrator>} orch
 * @returns {() => void}
 */
export function bridgeOrchestratorToSse(res, orch) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  writeSseEvent(res, 'snapshot', {
    sessionId: orch.session.id,
    meta: orch.session.meta,
    pendingGate: orch.pendingGate,
  });

  const handlers = {};
  for (const eventName of ORCHESTRATOR_EVENTS) {
    handlers[eventName] = (payload) => writeSseEvent(res, eventName, payload);
    orch.on(eventName, handlers[eventName]);
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      // Comments are valid SSE noise that keep the connection alive
      // without firing an EventSource listener.
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      // ignore
    }
  }, HEARTBEAT_INTERVAL_MS);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    for (const eventName of ORCHESTRATOR_EVENTS) {
      orch.off(eventName, handlers[eventName]);
    }
  }

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return cleanup;
}
