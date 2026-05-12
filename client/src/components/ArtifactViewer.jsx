import { useEffect, useState } from 'react';
import { fetchArtifact } from '../lib/api.js';
import { Spinner } from './Spinner.jsx';

const ARTIFACTS = ['spec', 'architecture', 'contract', 'signatures'];

/**
 * Tabbed viewer for the four named JSON artifacts a session produces.
 * Refreshes whenever `refreshKey` changes (caller bumps it on state-changed).
 */
export function ArtifactViewer({ sessionId, refreshKey }) {
  const [active, setActive] = useState('spec');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchArtifact(sessionId, active)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) {
          if (err.status === 404) {
            setData(null);
            setError(null);
          } else {
            setError(err.message);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, active, refreshKey]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-slate-800">
        {ARTIFACTS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setActive(name)}
            className={
              active === name
                ? 'px-3 py-2 text-xs font-medium border-b-2 border-emerald-400 text-emerald-300'
                : 'px-3 py-2 text-xs text-slate-400 hover:text-slate-200'
            }
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-3 text-xs font-mono">
        {loading && (
          <div className="text-slate-500 flex items-center gap-2">
            <Spinner size={12} /> Loading…
          </div>
        )}
        {!loading && error && (
          <div className="text-red-400">{error}</div>
        )}
        {!loading && !error && data === null && (
          <div className="text-slate-500 italic">
            Not yet produced. This artifact appears after its stage completes.
          </div>
        )}
        {!loading && data !== null && (
          <pre className="whitespace-pre-wrap break-words text-slate-200">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
