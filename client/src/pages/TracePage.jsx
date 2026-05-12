import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '../components/Header.jsx';
import { TracePanel } from '../components/TracePanel.jsx';
import { useSession } from '../hooks/useSession.js';
import { classNames } from '../lib/formatters.js';

const FILTERS = [
  { id: 'agents', label: 'Agents + states' },
  { id: 'all', label: 'Everything' },
];

export function TracePage() {
  const { id } = useParams();
  const state = useSession(id);
  const [filter, setFilter] = useState('agents');

  // Re-fetch the trace whenever a new event arrives via SSE.
  const refreshKey = useMemo(() => state.events.length, [state.events.length]);

  const meta = state.meta;

  return (
    <>
      <Header projectName={meta?.projectName} status={meta?.status} />
      <main className="mx-auto max-w-7xl px-6 py-6 space-y-4">
        <section className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Trace</h1>
            <p className="text-xs text-slate-400">
              Every event the orchestrator emitted for this session, in order.
              Click a row to expand the raw payload.
            </p>
          </div>
          <div className="flex gap-1 rounded-md bg-slate-900 border border-slate-800 p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={classNames(
                  'px-3 py-1 text-xs rounded',
                  filter === f.id
                    ? 'bg-slate-800 text-emerald-300'
                    : 'text-slate-400 hover:text-slate-200'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/40 h-[75vh]">
          <TracePanel sessionId={id} refreshKey={refreshKey} filter={filter} />
        </section>
      </main>
    </>
  );
}
