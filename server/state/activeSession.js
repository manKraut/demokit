// In-memory holder for THE ONE active orchestrator.
//
// At most one session is "live" at a time. Creating a new active session
// cancels the previous orchestrator (in-flight LLM calls aborted, gates
// rejected, in-memory state cleared). The on-disk active pointer is
// mirrored via sessionStore.setActiveSessionId so that restart-safe
// readers can still see "which session was last live".
//
// On server restart the in-memory orchestrator is gone; the disk pointer
// remains but the session is no longer live. Re-attaching to a restored
// session (resume after crash) is intentionally out of scope for v1.

import {
  setActiveSessionId,
  getActiveSessionId as readDiskActiveId,
} from '../sessions/sessionStore.js';

let active = null;

/**
 * @typedef {{
 *   sessionId: string,
 *   orchestrator: ReturnType<import('../pipeline/orchestrator.js').createOrchestrator>,
 *   startedAt: string,
 * }} ActiveEntry
 */

/**
 * Return the current in-memory active entry, or null.
 * @returns {ActiveEntry | null}
 */
export function getActiveOrchestrator() {
  return active;
}

/**
 * Return the active orchestrator IF its session id matches `id`. Returns
 * null otherwise. Most route handlers want this match check.
 */
export function getActiveOrchestratorFor(id) {
  if (active && active.sessionId === id) return active.orchestrator;
  return null;
}

/**
 * Set the active orchestrator. Cancels any prior one first.
 *
 * @param {string} sessionId
 * @param {ReturnType<import('../pipeline/orchestrator.js').createOrchestrator>} orchestrator
 */
export async function setActiveOrchestrator(sessionId, orchestrator) {
  await clearActiveOrchestrator();
  active = {
    sessionId,
    orchestrator,
    startedAt: new Date().toISOString(),
  };
  await setActiveSessionId(sessionId);
}

/**
 * Cancel and clear the in-memory active orchestrator. Also clears the
 * on-disk active pointer. Safe to call when nothing is active.
 */
export async function clearActiveOrchestrator() {
  if (active && active.orchestrator) {
    try {
      await active.orchestrator.cancel();
    } catch {
      // already cancelled / never started — ignore
    }
  }
  active = null;
  try {
    await setActiveSessionId(null);
  } catch {
    // ignore disk pointer cleanup failures
  }
}

/**
 * Convenience: id of the active in-memory session, or null.
 */
export function activeSessionId() {
  return active ? active.sessionId : null;
}

/**
 * Convenience: last-active session id according to disk. Useful when the
 * UI reconnects after a server restart — it can show that previous
 * session as "stopped" without trying to drive it.
 */
export async function diskActiveSessionId() {
  return readDiskActiveId();
}
