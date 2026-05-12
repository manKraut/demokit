import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Header } from '../components/Header.jsx';
import { Spinner } from '../components/Spinner.jsx';
import { createSession, listSessions, startSession } from '../lib/api.js';
import { getAllApiKeys, hasAnyKey } from '../lib/apiKey.js';
import { loadModelConfig, pruneModelConfig } from '../lib/modelConfig.js';
import { buildModelConfig, summariseModelConfig } from '../lib/providerDefaults.js';
import { useApiKey } from '../hooks/useApiKey.js';
import { relativeTime } from '../lib/formatters.js';

const TEXTAREA_MAX_HEIGHT_PX = 240;

// Pull a short kebab-case project name out of whatever the user typed.
// The debrief agent will overwrite this with the real spec.projectName
// once the spec is finalised.
function deriveProjectName(input) {
  const cleaned = (input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'untitled';
  const slug = cleaned.split(' ').slice(0, 5).join('-').slice(0, 48);
  return slug || 'untitled';
}

const STATUS_COLOR = {
  idle: 'bg-slate-700 text-slate-300',
  debriefing: 'bg-emerald-700/50 text-emerald-200',
  scoping: 'bg-emerald-700/50 text-emerald-200',
  architecting: 'bg-emerald-700/50 text-emerald-200',
  coding: 'bg-emerald-700/50 text-emerald-200',
  evaluating: 'bg-emerald-700/50 text-emerald-200',
  packaging: 'bg-emerald-700/50 text-emerald-200',
  'awaiting-scope-approval': 'bg-amber-700/50 text-amber-200',
  'awaiting-architecture-approval': 'bg-amber-700/50 text-amber-200',
  'awaiting-clarification': 'bg-amber-700/50 text-amber-200',
  done: 'bg-emerald-600/30 text-emerald-300',
  failed: 'bg-red-700/40 text-red-300',
};

export function HomePage() {
  const navigate = useNavigate();
  const { keys: availableKeys } = useApiKey();
  const [brief, setBrief] = useState('');
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  // Recompute every render so the "Using …" caption stays in sync as
  // the user adds/removes keys (the Keys modal can change them while
  // this page is mounted).
  const previewConfig = buildModelConfig(
    availableKeys,
    pruneModelConfig(loadModelConfig())
  );
  const summary = summariseModelConfig(previewConfig);

  async function refresh() {
    try {
      const r = await listSessions();
      setSessions(r.sessions || []);
      setActive(r.activeSessionId || null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function autoGrow() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
  }

  async function handleCreate(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (!hasAnyKey()) {
      setError('Please configure at least one provider key first.');
      return;
    }
    const trimmed = brief.trim();
    setBusy(true);
    setError(null);
    try {
      const keys = getAllApiKeys();
      const modelConfig = buildModelConfig(keys, pruneModelConfig(loadModelConfig()));
      const { sessionId } = await createSession(deriveProjectName(trimmed));
      await startSession(sessionId, {
        providerKeys: keys,
        modelConfig,
      });
      // Hand the typed brief to the Session page so it can submit it as
      // the first debrief turn once the SSE stream is connected. We pass
      // it through router state (cheap, ephemeral) rather than pre-POSTing
      // /messages here, which would race the SSE subscription.
      navigate(`/session/${sessionId}`, {
        state: trimmed ? { initialMessage: trimmed } : undefined,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-10 space-y-10">
        <section>
          <h1 className="text-3xl font-semibold text-slate-100">Start a new prototype</h1>
          <p className="mt-2 text-sm text-slate-400 max-w-xl">
            Describe an app, talk it through with the debrief agent, approve the
            architecture, and download a runnable starter zip.
          </p>

          <form
            onSubmit={handleCreate}
            className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-end gap-2"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={brief}
              onChange={(e) => {
                setBrief(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                // Slack-style: Enter submits, Shift+Enter inserts newline.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
              placeholder="What do you want to build? A name or a short brief — Shift+Enter for a new line."
              className="flex-1 min-h-[42px] resize-none overflow-y-auto rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm leading-relaxed text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              style={{ maxHeight: `${TEXTAREA_MAX_HEIGHT_PX}px` }}
            />
            <button
              type="submit"
              disabled={busy}
              className="shrink-0 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 px-5 py-2 text-sm font-medium text-white inline-flex items-center justify-center gap-2"
            >
              {busy && <Spinner size={12} />}
              Start
            </button>
          </form>
          <p className="mt-2 text-xs text-slate-500">
            Anything you type here becomes the first message of the debrief —
            the agent will ask follow-up questions from there.
          </p>

          {summary.label && (
            <p className="mt-2 text-xs text-slate-400">
              Using{' '}
              <span className="font-medium text-emerald-300">{summary.label}</span>
              {summary.strong && summary.fast && summary.strong !== summary.fast && (
                <>
                  {' '}·{' '}
                  <span className="font-mono text-slate-400">{summary.strong}</span>{' '}
                  for reasoning,{' '}
                  <span className="font-mono text-slate-400">{summary.fast}</span>{' '}
                  for codegen
                </>
              )}
              {summary.strong === summary.fast && (
                <> · <span className="font-mono text-slate-400">{summary.strong}</span></>
              )}
              .
            </p>
          )}
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </section>

        <section>
          <header className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium text-slate-100">Recent sessions</h2>
            <button
              type="button"
              onClick={refresh}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Refresh
            </button>
          </header>

          <div className="mt-3 rounded-lg border border-slate-800 divide-y divide-slate-800 overflow-hidden">
            {sessions.length === 0 && (
              <div className="p-4 text-sm text-slate-500 italic">No sessions yet.</div>
            )}
            {sessions.map((s) => (
              <Link
                key={s.id}
                to={`/session/${s.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-900/60"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-100 truncate">
                      {s.projectName || '(untitled)'}
                    </span>
                    {active === s.id && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-700/40 text-emerald-300">
                        live
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">
                    {s.id} · {relativeTime(s.createdAt)}
                  </p>
                </div>
                <span
                  className={
                    'shrink-0 text-[10px] uppercase tracking-wide px-2 py-1 rounded ' +
                    (STATUS_COLOR[s.status] || 'bg-slate-700 text-slate-300')
                  }
                >
                  {s.status}
                </span>
              </Link>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
