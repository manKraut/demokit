// Agent registry helper.
//
// Call `registerAgents(registry)` to populate an orchestrator agent
// registry with the six default DemoKit agents. The orchestrator's
// pipeline expects exactly these names: debrief, scope, architect,
// coder, evaluator, packager.

import { debriefAgent } from './debriefAgent.js';
import { scopeAgent } from './scopeAgent.js';
import { architectAgent } from './architectAgent.js';
import { coderAgent } from './coderAgent.js';
import { evaluatorAgent } from './evaluatorAgent.js';
import { packagerAgent } from './packagerAgent.js';

export const AGENT_NAMES = Object.freeze([
  'debrief',
  'scope',
  'architect',
  'coder',
  'evaluator',
  'packager',
]);

/**
 * Register all six default agents on a registry produced by
 * `createAgentRegistry()` from the orchestrator.
 *
 * @param {{ register: (name: string, fn: Function) => void }} registry
 */
export function registerAgents(registry) {
  registry.register('debrief', debriefAgent);
  registry.register('scope', scopeAgent);
  registry.register('architect', architectAgent);
  registry.register('coder', coderAgent);
  registry.register('evaluator', evaluatorAgent);
  registry.register('packager', packagerAgent);
}

// Re-export the individual agents for tests / advanced use.
export {
  debriefAgent,
  scopeAgent,
  architectAgent,
  coderAgent,
  evaluatorAgent,
  packagerAgent,
};
