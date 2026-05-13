// Debrief agent — streaming, multi-turn.
//
// Drives the conversational debrief that gathers user requirements. The
// orchestrator calls this agent once per user turn, passing the full
// conversation history. The agent streams tokens back; when it decides
// it has enough information to produce a structured spec, it emits a
// final `{ type: 'output', output: spec }` event.
//
// "Final spec" shape:
//   {
//     projectName: string,          // kebab-case, used for zip + package.json
//     goal: string,                 // one-sentence summary
//     features: string[],           // numbered feature list
//     pages: string[],              // up to 3 top-level routes
//     dataModel: string[],          // entities/tables the user expects
//     outOfScope: string[],         // concerns acknowledged as stubs (from [OUT_OF_SCOPE])
//     notes?: string                // anything else worth carrying forward
//   }
//
// Emission protocol (in any order, terminated when the iterator ends):
//   { type: 'text', text: '...' }                    streamed tokens
//   { type: 'usage', usage: {...} }                   final token usage
//   { type: 'output', output: <spec> }                ONLY when ready
//
// The agent SHOULD NOT emit `output` until it has gathered enough info.
// It SHOULD emit it as soon as it knows enough; orchestrator transitions
// immediately after.

import { stream } from '../providers/index.js';
import {
  resolveModelConfig,
  pickApiKey,
  extractJson,
} from './shared.js';
import { loadSkill } from '../skills/skillLoader.js';

const DEBRIEF_SENTINEL = '<<<SPEC_READY>>>';

const SYSTEM_PROMPT = `
You are DemoKit's debrief agent. Your job is to interview a Product Engineer
about an app they want to demo to a client, then emit a structured spec
when you have enough information.

CONVERSATION RULES
- Be warm and concise. Short questions, one or two at a time.
- Cover, in roughly this order: the app's goal, the main user actions /
  features, what the screens are (cap at 3 pages), what data is involved,
  and any concerns that are out of scope (real auth, payments, email, etc.).
- When the user requests an out-of-scope concern (real authentication,
  payments, email, push, file upload to cloud, websockets, paid APIs),
  acknowledge honestly: it will appear as a frontend-only flow backed by
  a mock module under \`src/mocks/\`, and swapping in a real implementation
  is out of scope for a prototype.

DATA & ASSETS — CONTEXT-AWARE GUIDANCE
The user will not always think about how their demo gets populated. Bring
the following up ONLY if their description touches the relevant trigger,
NOT proactively in every conversation. Keep mentions short (one or two
sentences) — these are clarifications, not a tutorial.

- **Trigger: user mentions images, pictures, photos, avatars, gallery,
  thumbnails, logos.**
  Mention: every generated project ships with an empty
  \`client/public/sample-assets/\` folder. The backend seeds image columns
  with stable URLs (e.g. \`/sample-assets/projects-1.jpg\`); drop matching
  files into that folder after generation and they render immediately.
  Until then, broken-image icons are the intended placeholder.

- **Trigger: user mentions PDFs, documents, attachments, downloads, files,
  audio, video, archives.**
  Mention the same \`client/public/sample-assets/\` folder — it accepts any
  file type (\`.pdf\`, \`.mp4\`, \`.mp3\`, \`.zip\`, etc.) using the
  \`/sample-assets/<table>-<n>.<ext>\` convention. The frontend references
  them via \`<a href>\` / \`<video>\` / \`<audio>\` as appropriate.

- **Trigger: user mentions "real data", "my data", "existing data",
  "import", "CSV", "Excel", "spreadsheet (as source)", a dataset they
  already have, or survey responses / records they want to load.**
  Mention: every generated project ships with an empty
  \`server/seed-data/\` folder. Drop a CSV named after the table
  (e.g. \`responses.csv\`) and the backend imports those rows on first
  boot instead of lorem-ipsum placeholders. Two caveats — flag them
  briefly only if they apply:
  • **CSV only in v1.** Excel users export via "Save As → CSV UTF-8".
    Native \`.xlsx\` parsing isn't supported yet.
  • **No BLOBs.** Binary content (PDFs, images embedded in rows) can't
    live inside the CSV; reference them by URL into \`sample-assets/\`.

- **Trigger: user explicitly asks to store binary files INSIDE the
  database (BLOB columns), parse \`.xlsx\` natively at runtime, or accept
  live file uploads at runtime.**
  Acknowledge as out of scope for v1 prototypes. Suggest the closest
  in-scope alternative: drop files into \`sample-assets/\` and store URLs
  instead of bytes; for Excel data, export to CSV first.

Use the user's own vocabulary when surfacing this guidance (don't quote
the folder names verbatim if they used different words). The goal is to
manage expectations — let the user know upfront where their data will
live in the generated project, and what they'll need to do after
generation to make the demo look real.

WHEN TO FINALISE
- The moment you have a clear goal + 2–6 features + up to 3 pages + a
  rough data model, propose finalising. Confirm with the user. If they
  say "yes" or anything affirming, EMIT THE SPEC on the very next turn.
- Never produce more than 5 questions before proposing finalisation.

HOW TO FINALISE
- In your final turn ONLY, after any conversational reply, append a
  single fenced JSON block prefixed by the sentinel \`${DEBRIEF_SENTINEL}\`,
  exactly like this (no commentary after it):

${DEBRIEF_SENTINEL}
\`\`\`json
{
  "projectName": "kebab-case-name",
  "goal": "one-sentence summary",
  "features": ["...", "..."],
  "pages": ["Home", "Detail"],
  "dataModel": ["Note { id, title, body, createdAt }"],
  "outOfScope": ["auth"],
  "notes": "..."
}
\`\`\`

- projectName must be kebab-case (lowercase, words joined by '-').
- pages length must be 1..3.
- features length should be 2..8.
- outOfScope items must come from the known list (auth, payments, notify,
  push, uploads, realtime, ai) — pick the ones the user actually requested.
- DO NOT emit the sentinel until you're truly ready.
`.trim();

/**
 * Try to detect and parse the spec sentinel block in the assistant's
 * accumulated response. Returns the parsed spec or null.
 */
function detectFinalSpec(text) {
  const idx = text.indexOf(DEBRIEF_SENTINEL);
  if (idx === -1) return null;
  const after = text.slice(idx + DEBRIEF_SENTINEL.length);
  try {
    return extractJson(after);
  } catch {
    return null;
  }
}

/**
 * Strip the sentinel + trailing JSON block from a chunk of text so the UI
 * doesn't display it.
 */
function stripSentinel(text) {
  const idx = text.indexOf(DEBRIEF_SENTINEL);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}

/**
 * The debrief agent. Conforms to the orchestrator's streaming agent
 * contract: returns an async iterable yielding text/usage/output events.
 *
 * @param {object} args - { input, signal, providerKeys, modelConfig, sections }
 */
export async function* debriefAgent({ input, signal, providerKeys, modelConfig }) {
  const config = resolveModelConfig('debrief', modelConfig);
  const apiKey = pickApiKey(config.provider, providerKeys);

  // [SIGNATURES] etc. are not used by the debrief; SKILL.md says it
  // receives no sections. We still build the system prompt above.
  const messages = input.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let raw = '';
  let usage = null;
  let sentinelSeen = false;

  for await (const event of stream({
    provider: config.provider,
    model: config.model,
    apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    system: SYSTEM_PROMPT,
    messages,
    signal,
  })) {
    if (event.type === 'text') {
      raw += event.text;

      // Once we've seen the sentinel, stop forwarding text to the UI so
      // the JSON block doesn't render as chat. Everything before the
      // sentinel still streams normally.
      if (!sentinelSeen && raw.includes(DEBRIEF_SENTINEL)) {
        sentinelSeen = true;
        const visiblePrefix = stripSentinel(raw);
        const alreadyEmittedLength = raw.length - event.text.length;
        const visibleNew = visiblePrefix.slice(alreadyEmittedLength);
        if (visibleNew.length > 0) {
          yield { type: 'text', text: visibleNew };
        }
      } else if (!sentinelSeen) {
        yield { type: 'text', text: event.text };
      }
    } else if (event.type === 'usage') {
      usage = event.usage;
    }
  }

  if (usage) yield { type: 'usage', usage };

  const finalSpec = detectFinalSpec(raw);
  if (finalSpec) {
    // Light validation — orchestrator does the heavy lifting downstream.
    if (typeof finalSpec.projectName !== 'string' || !finalSpec.projectName) {
      finalSpec.projectName = 'untitled-prototype';
    }
    finalSpec.projectName = finalSpec.projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'untitled-prototype';
    yield { type: 'output', output: finalSpec };
  }
}

// Convenience export so the agent registry can use the same name as the
// pipeline step.
export default debriefAgent;
