// Mirrors `server/utils/sse.js` ORCHESTRATOR_EVENTS. Keep this in sync
// if the server ever adds or removes an event type.

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

// The pipeline's state machine (read-only — used for stage progress UI).
export const PIPELINE_STATES = Object.freeze([
  'idle',
  'debriefing',
  'awaiting-scope-approval',
  'scoping',
  'architecting',
  'awaiting-architecture-approval',
  'coding',
  'evaluating',
  'awaiting-clarification',
  'packaging',
  'done',
  'failed',
]);

export const STAGE_LABELS = Object.freeze({
  idle: 'Idle',
  debriefing: 'Debriefing',
  'awaiting-scope-approval': 'Review scope',
  scoping: 'Scoping',
  architecting: 'Architecting',
  'awaiting-architecture-approval': 'Review architecture',
  coding: 'Coding',
  evaluating: 'Evaluating',
  'awaiting-clarification': 'Needs clarification',
  packaging: 'Packaging',
  done: 'Done',
  failed: 'Failed',
});

// Primary stages shown in the StageProgress strip (collapses gate states
// under their flanking active state).
export const PRIMARY_STAGES = Object.freeze([
  'debriefing',
  'scoping',
  'architecting',
  'coding',
  'evaluating',
  'packaging',
  'done',
]);
