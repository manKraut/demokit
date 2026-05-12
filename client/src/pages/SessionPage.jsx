import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Header } from '../components/Header.jsx';
import { StageProgress } from '../components/StageProgress.jsx';
import { GatePanel } from '../components/GatePanel.jsx';
import { ChatPanel } from '../components/ChatPanel.jsx';
import { ArtifactViewer } from '../components/ArtifactViewer.jsx';
import { FileExplorer } from '../components/FileExplorer.jsx';
import { ApiKeyGate } from '../components/ApiKeyGate.jsx';
import { useSession } from '../hooks/useSession.js';
import { cancelSession, sendMessage } from '../lib/api.js';
import { isAuthErrorMessage } from '../lib/apiKey.js';
import { formatTokens } from '../lib/formatters.js';
import { Spinner } from '../components/Spinner.jsx';

const TABS = [
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'files', label: 'Files' },
];

export function SessionPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = useSession(id);
  const [tab, setTab] = useState('artifacts');
  const [authBannerOpen, setAuthBannerOpen] = useState(false);

  // Refinement: re-open the key gate if the SSE error pattern matches auth.
  useEffect(() => {
    if (state.lastError && isAuthErrorMessage(state.lastError.message)) {
      setAuthBannerOpen(true);
    }
  }, [state.lastError]);

  // If the user arrived here from HomePage with a typed brief, submit it
  // as the first debrief message — but only after the SSE stream is up,
  // and only once per session. Then strip the router state so a refresh
  // or back/forward won't re-send.
  const initialMessage = location.state?.initialMessage;
  const initialSentRef = useRef(false);
  useEffect(() => {
    if (initialSentRef.current) return;
    if (!initialMessage) return;
    if (state.status !== 'connected') return;
    if (state.chat.length > 0) return; // already sent in a previous mount
    initialSentRef.current = true;
    sendMessage(id, initialMessage).catch(() => {
      // best-effort; the user can retry from the chat box
    });
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.chat.length, initialMessage, id]);

  const meta = state.meta;
  const status = meta?.status || 'idle';
  const pending = state.pendingGate;
  const usage = meta?.usage?.total ?? 0;

  // Bump refresh key whenever a major artifact-impacting event arrives
  // so the viewers refetch from disk.
  const refreshKey = useMemo(() => {
    return state.events.filter((e) =>
      ['state-changed', 'agent-end', 'gate-approved', 'done'].includes(e.name)
    ).length;
  }, [state.events]);

  const canDownload = status === 'done';

  async function handleCancel() {
    try {
      await cancelSession(id);
    } catch {
      // ignore
    }
  }

  if (!meta) {
    return (
      <>
        <Header />
        <main className="mx-auto max-w-7xl px-6 py-12">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 flex items-center gap-3 text-slate-300">
            <Spinner /> Connecting to session…
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header projectName={meta.projectName} status={status} />

      {authBannerOpen && (
        <ApiKeyGate
          forceOpen="The last run failed with what looks like an authentication problem. Update your provider keys and restart the run."
          onClose={() => setAuthBannerOpen(false)}
        />
      )}

      <main className="mx-auto max-w-7xl px-6 py-6 grid grid-rows-[auto_1fr] gap-4 min-h-[calc(100vh-4rem)]">
        {/* Top strip: progress + controls */}
        <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <StageProgress status={status} currentStep={meta.currentStep} />
            </div>
            <div className="shrink-0 flex flex-col items-end gap-2">
              <div className="text-xs text-slate-400 font-mono">
                <span className="text-slate-500">tokens </span>
                {formatTokens(usage)}
              </div>
              {state.terminalStatus !== 'done' && state.terminalStatus !== 'cancelled' && (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="text-xs px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800"
                >
                  Cancel run
                </button>
              )}
            </div>
          </div>
          {pending && (
            <div className="mt-4">
              <GatePanel sessionId={id} gate={pending} />
            </div>
          )}
          {state.lastError && (
            <div className="mt-4 rounded-md border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              <strong className="text-red-200">Pipeline error: </strong>
              {state.lastError.message}
            </div>
          )}
          {state.terminalStatus === 'cancelled' && (
            <div className="mt-4 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">
              This run was cancelled.
            </div>
          )}
        </section>

        {/* Workspace: chat (left) + tabs (right) */}
        <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 min-h-0">
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 flex flex-col min-h-[480px]">
            <div className="px-4 py-2 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-200">Debrief</h3>
              <span className="text-xs text-slate-500">{state.chat.length} turns</span>
            </div>
            <div className="flex-1 min-h-0">
              <ChatPanel
                sessionId={id}
                chat={state.chat}
                liveAssistantText={state.liveDebriefText}
                status={status}
                disabled={state.terminalStatus !== null && state.terminalStatus !== 'done'}
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/40 flex flex-col min-h-[480px]">
            <div className="flex border-b border-slate-800">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={
                    tab === t.id
                      ? 'px-4 py-2 text-sm font-medium border-b-2 border-emerald-400 text-emerald-300'
                      : 'px-4 py-2 text-sm text-slate-400 hover:text-slate-200'
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0">
              {tab === 'artifacts' && (
                <ArtifactViewer sessionId={id} refreshKey={refreshKey} />
              )}
              {tab === 'files' && (
                <FileExplorer sessionId={id} refreshKey={refreshKey} canDownload={canDownload} />
              )}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
