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
- The architecture fileTree (the authoritative list of generated files).
- All extracted signatures.
- All generated file bodies (concatenated, one per fenced section).
- The chosen stack and its default backend env values (PORT, DATABASE_URL).
  contract.backendEnv MUST match these defaults exactly.

REQUIRED CHECKS — each one MUST appear as a key in your output \`checks\` object
with { passed: bool, detail: string }. \`passed\` at the top level is true iff
EVERY check passes.

1. frontend-endpoints-in-contract — every endpoint called from any frontend
   signature appears in contract.endpoints.
2. backend-endpoints-implement-contract — every endpoint in contract.endpoints
   is implemented by exactly one backend file body. Backend route definitions
   do NOT appear in signatures.calls, so read the file bodies and look for
   \`router.<method>('/api/...')\` (Express) or \`@router.<method>("/api/...")\`
   (FastAPI).
3. env-vars-declared — every env var in signatures appears in
   contract.frontendEnv (if VITE_*) or contract.backendEnv. Backend env reads
   MUST ALSO have a \`||\` / second-arg default; missing defaults are
   \`env-default-missing\` violations and fail this check.
4. out-of-scope-via-mocks-only — no file outside src/mocks/ implements an
   out-of-scope concern, AND no mock file exists for an in-scope CRUD entity.
   Mocks under src/mocks/ are reserved for the SEVEN concerns listed in
   [OUT_OF_SCOPE]: auth, payments, notify, push, uploads, realtime, ai.
5. imports-resolve — every import path in every signature resolves to
   (a) a file present in architecture.fileTree (use the fileTree you were
   given — be strict), (b) a package known to the chosen stack, or (c) a
   language stdlib module.
6. tables-in-contract — every SQL table referenced by queries appears in
   contract.db.tables.
7. stack-defaults-respected — contract.backendEnv.PORT and
   contract.backendEnv.DATABASE_URL EXACTLY match the stack-default values
   shown in your input.

VIOLATION TYPES (use these strings exactly; use "other" for anything else):
  missing-endpoint | unknown-endpoint | unknown-import |
  out-of-scope-violation | env-var-mismatch | env-default-missing |
  stack-defaults-mismatch | type-mismatch | table-mismatch | other

OUTPUT
- Respond with ONLY a JSON object. First char '{', last char '}'.
- Schema: { "passed": bool, "checks": {<all 7 above>}, "violations": [...], "retryHints": {...} }.
- retryHints is a map of file path → concrete instruction the coder will see
  on retry. Only include files that should be regenerated. Be specific:
  "Remove the import of '../mocks/notes' and call fetch('/api/notes') directly"
  is good; "fix imports" is not.
- A run with passed=true MUST have an empty violations array and every
  checks[*].passed===true. Internal inconsistency is treated as a fail.
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

const REQUIRED_CHECKS = Object.freeze([
  'frontend-endpoints-in-contract',
  'backend-endpoints-implement-contract',
  'env-vars-declared',
  'out-of-scope-via-mocks-only',
  'imports-resolve',
  'tables-in-contract',
  'stack-defaults-respected',
]);

export async function evaluatorAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('evaluator', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  const vars = buildVarsBag({
    spec: input.spec,
    contract: input.contract,
    signatures: input.signatures,
    stack: input.stack,
  });
  const skill = loadSkill(['EVALUATION', 'SIGNATURES', 'OUT_OF_SCOPE'], vars);

  const stackDefaults = input.stackDefaults || {};

  const userPrompt = [
    skill,
    '',
    `## Stack: ${input.stack || '(unknown)'}`,
    '',
    'Stack-default backend env values (contract.backendEnv MUST equal these exactly):',
    '',
    '```json',
    JSON.stringify(stackDefaults, null, 2),
    '```',
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
    '## Architecture (authoritative fileTree)',
    '',
    '```json',
    JSON.stringify(input.architecture ?? [], null, 2),
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
    'Emit the JSON verdict now. Remember: every required check MUST appear as a key in `checks` with { passed, detail }, and top-level `passed` must equal the AND of every check.passed.',
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

  const checks = parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {};
  const violations = Array.isArray(parsed.violations) ? parsed.violations : [];

  // Cross-validate: if the LLM marked passed=true but any check failed (or
  // there are violations), demote to false. We trust the per-check verdicts
  // over the top-level boolean because they're harder to lie about.
  const anyCheckFailed = REQUIRED_CHECKS.some(
    (name) => checks[name] && checks[name].passed === false
  );
  const reconciledPassed = parsed.passed && !anyCheckFailed && violations.length === 0;

  return {
    output: {
      passed: reconciledPassed,
      checks,
      violations,
      retryHints:
        parsed.retryHints && typeof parsed.retryHints === 'object'
          ? parsed.retryHints
          : {},
    },
    usage: result.usage,
  };
}

export default evaluatorAgent;
