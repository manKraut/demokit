// Coder agent — single-shot, non-streaming.
//
// Generates exactly one file. The orchestrator calls this once per file
// in the architecture, in order, passing the accumulated signatures of
// previously generated files. On retry, the orchestrator includes a
// retryHint and an attempt counter.
//
// SKILL.md sections received: [CODE], [SIGNATURES], [OUT_OF_SCOPE].
//
// Output: a string — the raw file body. No JSON wrapper.

import { chat } from '../providers/index.js';
import { loadSkill } from '../skills/skillLoader.js';
import {
  resolveModelConfig,
  pickApiKey,
  buildVarsBag,
  stripCodeFences,
} from './shared.js';
import { getStack } from './stacks.js';

const SYSTEM_PROMPT = `
You are DemoKit's coder agent. You generate ONE file and ONLY that file.

OUTPUT FORMAT
- The first character of your response is the first character of the file.
- No prose, no commentary, no explanations.
- No markdown code fences wrapping the entire response. The output is the
  file content verbatim.
- Match the language implied by the file extension.

CONFORMANCE
- Imports must resolve to (a) a file in the architecture's fileTree,
  (b) a package known to the chosen stack, or (c) a language stdlib.
- Never invent endpoints not in contract.endpoints.
- If you import a helper from another generated file, it MUST already
  appear as a named/default export in that file's signature. Do NOT
  invent helpers you haven't seen exported.
- Frontend HTTP calls MUST be literal \`fetch('/api/...')\` strings — no
  template literals, no env-var prefixing, no buildUrl helpers. The
  Vite dev server proxies /api to the backend, so single-origin
  fetches just work. Dynamic URLs break the signature extractor and
  the evaluator will flag them.
- For out-of-scope concerns, import from the corresponding mocks/<name>.js.
- NEVER create a mock for an in-scope CRUD entity. Mocks/ is reserved
  for the seven concerns in [OUT_OF_SCOPE] (auth, payments, notify, push,
  uploads, realtime, ai). For a CRUD entity like notes/projects/tasks,
  call fetch('/api/<entity>') directly.
- Every backend env-var read MUST have a fallback default. The
  user prompt lists the exact default values for the chosen stack —
  use them verbatim. JS: \`process.env.X || <default>\`. Python:
  \`os.getenv("X", "<default>")\`. A bare \`process.env.X\` is
  \`undefined\` at runtime and will crash the generated server.
- The only CSS file is src/index.css with the single line
  \`@import "tailwindcss";\` (Tailwind v4 directive). Do NOT use the v3
  \`@tailwind base/components/utilities\` directives.
- Prefer modern idioms current as of mid-2026: ESM imports, async/await,
  React 18 functional components and hooks, react-router-dom v6 APIs,
  Node 20+ syntax, Tailwind v4. Avoid deprecated patterns
  (CommonJS \`require\` in the frontend, class components, \`<Switch>\`,
  v3 Tailwind directives, callback-style fs APIs).

If a "retry hint" is provided, you MUST address it specifically.
`.trim();

export async function coderAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('coder', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  if (!input.file?.path) {
    throw new Error('coder: input.file.path is required');
  }

  const vars = buildVarsBag({
    projectName: input.spec?.projectName,
    stack: input.stack,
    currentFile: input.file.path,
    architecture: input.architecture,
    contract: input.contract,
    signatures: input.signatures,
  });
  const skill = loadSkill(['CODE', 'SIGNATURES', 'OUT_OF_SCOPE'], vars);

  // Resolve the chosen stack so we can show the coder the EXACT default
  // env values it should use as the `||` / fallback side of every
  // process.env / os.getenv read. Without these defaults the generated
  // server crashes on boot when no `.env` file is loaded.
  let stackInfo = null;
  try {
    stackInfo = input.stack ? getStack(input.stack) : null;
  } catch {
    stackInfo = null;
  }
  const stackDefaultBackendEnv = stackInfo?.defaultBackendEnv || {};
  const stackDefaultFrontendEnv = stackInfo?.defaultFrontendEnv || {};

  const userParts = [
    skill,
    '',
    `## Current file to generate: \`${input.file.path}\``,
    '',
    `Purpose (from the architecture): ${input.file.purpose || '(no purpose recorded)'}`,
    '',
    `## Stack defaults for ${input.stack || '(unknown stack)'}`,
    '',
    'When this file is a backend file and reads env vars, you MUST fall back to these literal default values (the scaffold writes them to `.env.example` but DemoKit does NOT auto-load `.env` at runtime — a bare `process.env.X` is `undefined` and crashes the server):',
    '',
    '```json',
    JSON.stringify(stackDefaultBackendEnv, null, 2),
    '```',
    '',
    'For frontend env vars (if any):',
    '',
    '```json',
    JSON.stringify(stackDefaultFrontendEnv, null, 2),
    '```',
    '',
    'Concrete fallback patterns:',
    `- JS: \`const PORT = process.env.PORT || ${JSON.stringify(stackDefaultBackendEnv.PORT ?? '3000')};\``,
    `- JS: \`new Database(process.env.DATABASE_URL || ${JSON.stringify(stackDefaultBackendEnv.DATABASE_URL ?? './dev.db')})\``,
    `- Python: \`port = int(os.getenv("PORT", ${JSON.stringify(stackDefaultBackendEnv.PORT ?? '8000')}))\``,
    '',
  ];

  if (input.retryHint) {
    userParts.push(
      '## Retry hint (attempt #' + (input.attempt ?? '?') + ')',
      '',
      'The previous attempt failed the evaluator. Address THIS specifically:',
      '',
      `> ${input.retryHint}`,
      ''
    );
  }

  userParts.push('Emit the file body now.');

  const result = await chat({
    provider: config.provider,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userParts.join('\n') }],
    signal,
  });

  // Defensive: some models wrap their response in markdown fences despite
  // being told not to. Strip them if present.
  const body = stripCodeFences(result.text);

  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`coder: empty body for ${input.file.path}`);
  }

  return { output: body, usage: result.usage };
}

export default coderAgent;
