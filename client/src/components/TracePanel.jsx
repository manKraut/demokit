import { useEffect, useState } from 'react';
import { fetchTrace } from '../lib/api.js';
import { Spinner } from './Spinner.jsx';

/**
 * Full agent I/O trace, loaded from /trace. Entries are JSONL events
 * persisted by the orchestrator. Items expand on click to reveal the
 * full event payload.
 *
 * Props:
 *   - sessionId
 *   - refreshKey  (caller bumps to refetch)
 *   - filter?:    'all' | 'agents' (default 'all'; 'agents' hides tokens + low-noise events)
 */
export function TracePanel({ sessionId, refreshKey, filter = 'all' }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTrace(sessionId)
      .then(({ entries }) => {
        if (!cancelled) setEntries(entries || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  const visible = entries.filter((e) => {
    if (filter === 'agents') {
      return ['agent-start', 'agent-end', 'awaiting-input', 'gate-approved', 'gate-rejected', 'error', 'failed', 'done', 'state-changed'].includes(e.type);
    }
    return true;
  });

  function toggle(idx) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs text-slate-400">
          {visible.length} event{visible.length === 1 ? '' : 's'}
        </span>
        {loading && <Spinner size={12} />}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {error && <div className="text-red-400 text-xs p-2">{error}</div>}
        {!loading && visible.length === 0 && (
          <div className="text-slate-500 text-xs italic p-3">No trace events yet.</div>
        )}
        {visible.map((e, idx) => (
          <TraceEntry
            key={idx}
            entry={e}
            isOpen={expanded.has(idx)}
            onToggle={() => toggle(idx)}
          />
        ))}
      </div>
    </div>
  );
}

function TraceEntry({ entry, isOpen, onToggle }) {
  const t = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
  const accent = ACCENT[entry.type] || 'text-slate-300';
  const label = formatLabel(entry);
  return (
    <div className="rounded-md border border-slate-800/60 bg-slate-900/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-2 py-1.5 text-left hover:bg-slate-800/40"
      >
        <span className="text-[10px] text-slate-500 font-mono w-16 shrink-0">{t}</span>
        <span className={`text-xs font-medium ${accent} w-32 shrink-0 truncate`}>
          {entry.type}
        </span>
        <span className="text-xs text-slate-300 font-mono truncate">{label}</span>
      </button>
      {isOpen && (
        <pre className="px-2 pb-2 text-[11px] text-slate-300 font-mono overflow-x-auto whitespace-pre-wrap break-words">
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}
    </div>
  );
}

const ACCENT = {
  'agent-start': 'text-cyan-400',
  'agent-end': 'text-cyan-300',
  'state-changed': 'text-emerald-400',
  'awaiting-input': 'text-amber-300',
  'gate-approved': 'text-emerald-300',
  'gate-rejected': 'text-orange-300',
  done: 'text-emerald-300',
  failed: 'text-red-400',
  error: 'text-red-400',
  cancelled: 'text-slate-400',
  token: 'text-slate-500',
  'user-message': 'text-violet-300',
  progress: 'text-slate-400',
  'agent-event': 'text-slate-400',
};

function formatLabel(e) {
  switch (e.type) {
    case 'state-changed':
      return `${e.from || '∅'} → ${e.to}`;
    case 'agent-start':
      return e.agent;
    case 'agent-end': {
      const ms = e.durationMs != null ? ` (${e.durationMs}ms)` : '';
      const tok = e.usage
        ? ` · ${e.usage.input ?? 0}→${e.usage.output ?? 0} tok`
        : '';
      return `${e.agent}${ms}${tok}`;
    }
    case 'awaiting-input':
      return e.gate;
    case 'gate-approved':
    case 'gate-rejected':
      return e.gate;
    case 'progress':
      return e.step || '';
    case 'user-message':
      return (e.text || '').slice(0, 80);
    case 'error':
      return e.error?.message || '';
    case 'failed':
      return e.error?.message || '';
    case 'token':
      return (e.text || '').replace(/\n/g, '↵');
    default:
      return '';
  }
}
