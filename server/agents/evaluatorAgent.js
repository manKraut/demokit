// Evaluator agent — single-shot, non-streaming.
//
// Reviews the entire generated project against the interface contract
// and returns a JSON verdict. The orchestrator uses the verdict to
// either advance to packaging (passed) or trigger up to 2 retries per
// file (failed with retryHints).
//
// SKILL.md sections received: [EVALUATION], [SIGNATURES], [OUT_OF_SCOPE].
//
// Output shape:
//   {
//     passed: boolean,
//     violations: [{ file, type, detail, hint? }, ...],
//     retryHints: { '<path>': '<actionable guidance>' }
//   }

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  extractJson,
  buildVarsBag,
} from './shared.js';

const SYSTEM_PROMPT = `
You are DemoKit's evaluator agent. Your job is contract conformance —
NOT subjective code review. Be precise and machine-verifiable.

You will receive:
- The original spec.
- The interface contract.
- All extracted signatures.
- All generated file bodies (concatenated, one per fenced section).

REQUIRED CHECKS
1. Every endpoint called from any frontend signature appears in contract.endpoints.
2. Every endpoint in contract.endpoints is implemented by exactly one backend file.
3. Every env var in signatures appears in contract.frontendEnv (if VITE_*)
   or contract.backendEnv (otherwise).
4. No file outside src/mocks/ implements an out-of-scope concern.
5. Every import path resolves to a file in the architecture, a known
   package for the chosen stack, or a language stdlib module.
6. Every SQL table referenced by queries appears in contract.db.tables.

VIOLATION TYPES (use these strings exactly; use "other" for anything else):
  missing-endpoint | unknown-endpoint | unknown-import |
  out-of-scope-violation | env-var-mismatch | type-mismatch |
  table-mismatch | other

OUTPUT
- Respond with ONLY a JSON object. First char '{', last char '}'.
- retryHints is a map of file path → concrete instruction the coder
  will see on retry. Only include files that should be regenerated.
- Be specific in hints. "Replace fetch('/api/user/me') with
  mocks/auth.getCurrentUser()" > "fix auth".
`.trim();

function formatBodies(bodies) {
  const parts = [];
  for (const [filePath, body] of Object.entries(bodies)) {
    parts.push(`### \`${filePath}\``);
    parts.push('```');
    parts.push(body);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n');
}

export async function evaluatorAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('evaluator', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  const vars = buildVarsBag({
    spec: input.spec,
    contract: input.contract,
    signatures: input.signatures,
  });
  const skill = loadSkill(['EVALUATION', 'SIGNATURES', 'OUT_OF_SCOPE'], vars);

  const userPrompt = [
    skill,
    '',
    '## Spec',
    '',
    '```json',
    JSON.stringify(input.spec ?? {}, null, 2),
    '```',
    '',
    '## Contract',
    '',
    '```json',
    JSON.stringify(input.contract ?? {}, null, 2),
    '```',
    '',
    '## Signatures',
    '',
    '```json',
    JSON.stringify(input.signatures ?? [], null, 2),
    '```',
    '',
    '## File bodies',
    '',
    formatBodies(input.bodies || {}),
    '',
    'Emit the JSON verdict now.',
  ].join('\n');

  const result = await chat({
    provider: config.provider,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    signal,
  });

  const parsed = extractJson(result.text);
  if (typeof parsed.passed !== 'boolean') {
    throw new Error('evaluator: missing or invalid "passed" boolean');
  }

  return {
    output: {
      passed: parsed.passed,
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      retryHints:
        parsed.retryHints && typeof parsed.retryHints === 'object'
          ? parsed.retryHints
          : {},
    },
    usage: result.usage,
  };
}

export default evaluatorAgent;
