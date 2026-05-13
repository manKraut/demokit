// Architect agent — single-shot, non-streaming.
//
// Given the spec and chosen stack, emits the architecture document
// (file tree) and the interface contract. These two documents become
// the ground truth for the coder loop and the evaluator.
//
// SKILL.md sections received: [STRUCTURE], [OUT_OF_SCOPE].
//
// Output shape:
//   {
//     fileTree: [{ path, purpose }, ...],
//     contract: { endpoints, types, frontendEnv, backendEnv, db }
//   }

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  extractJson,
  buildVarsBag,
} from './shared.js';
import { getStack } from './stacks.js';

const SYSTEM_PROMPT = `
You are DemoKit's architect agent. You receive a structured spec and the
chosen stack. You emit ONE JSON object with exactly two top-level keys:
"fileTree" and "contract". Follow the format in the [STRUCTURE] section
of your skill exactly.

Hard constraints (the evaluator will enforce them):
- fileTree length must not exceed the file ceiling (see [STRUCTURE]).
- Maximum 3 routes/pages in the frontend; stay close to the spec's
  declared pages and do NOT invent extra ones.
- Database is SQLite.
- Out-of-scope concerns (see [OUT_OF_SCOPE]) MUST be implemented via the
  mock library; do NOT add backend endpoints for them. Do include the
  used mock files in fileTree.
- Frontend is always React + Vite + Tailwind + React Router. Backend
  depends on the stack.
- Every endpoint referenced by frontend code must appear in
  contract.endpoints. Every type used in request/response must appear
  in contract.types.
- contract.backendEnv MUST use the stack-default PORT and DATABASE_URL
  (see the stack notes) unless the spec explicitly demands otherwise.
  Stack-a uses a SQLAlchemy URL ("sqlite:///./dev.db"); stack-b uses a
  bare path ("./dev.db"). DO NOT mix them.
- NEVER put any of these files in fileTree (they are generated
  deterministically by the scaffold step): package.json (root, client/,
  server/), client/index.html, client/vite.config.js,
  client/src/main.jsx, client/src/ErrorBoundary.jsx, .env.example,
  .gitignore, README.md, DISCLAIMER.md, server/requirements.txt.
- main.jsx is scaffolded so the BrowserRouter root lives in exactly
  one place. App.jsx (which IS in fileTree, written by the coder) must
  therefore contain only <Routes>/<Route> children — never wrap a
  router. Reflect this in App.jsx's "purpose" string.

OUTPUT
- Respond with ONLY the JSON object. No prose, no markdown code fences
  surrounding the JSON. The first character must be '{', the last '}'.
`.trim();

export async function architectAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('architect', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);
  const stack = getStack(input.stack);

  const vars = buildVarsBag({
    spec: input.spec,
    stack: input.stack,
    projectName: input.spec?.projectName,
  });
  const skill = loadSkill(['STRUCTURE', 'OUT_OF_SCOPE'], vars);

  const userPrompt = [
    skill,
    '',
    '## Input spec',
    '',
    '```json',
    JSON.stringify(input.spec, null, 2),
    '```',
    '',
    `## Chosen stack: ${stack.id} — ${stack.label}`,
    '',
    '## REQUIRED contract.backendEnv values (use these EXACTLY)',
    '',
    '```json',
    JSON.stringify(stack.defaultBackendEnv, null, 2),
    '```',
    '',
    'These are not suggestions. The evaluator runs a `stack-defaults-respected` check; mismatch is a hard fail and triggers a re-architecture.',
    '',
    '## Default contract.frontendEnv for this stack',
    '',
    '```json',
    JSON.stringify(stack.defaultFrontendEnv, null, 2),
    '```',
    '',
    'You MAY override contract.frontendEnv to `{}` (the Vite dev proxy makes VITE_API_URL unnecessary in v1), but if you keep it, use these values verbatim.',
    '',
    'Emit the JSON object now.',
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

  if (!Array.isArray(parsed.fileTree) || parsed.fileTree.length === 0) {
    throw new Error('architect: fileTree must be a non-empty array');
  }
  if (!parsed.contract || typeof parsed.contract !== 'object') {
    throw new Error('architect: contract must be an object');
  }
  for (const f of parsed.fileTree) {
    if (typeof f.path !== 'string' || typeof f.purpose !== 'string') {
      throw new Error(`architect: each fileTree entry needs { path, purpose }: ${JSON.stringify(f)}`);
    }
  }

  return {
    output: { fileTree: parsed.fileTree, contract: parsed.contract },
    usage: result.usage,
  };
}

export default architectAgent;
