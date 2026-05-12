import { useState } from 'react';
import { approveGate, rejectGate } from '../lib/api.js';
import { Spinner } from './Spinner.jsx';

const GATE_LABELS = {
  'scope-approval': {
    title: 'Approve the project scope',
    body: 'Review the spec the debrief produced in the Spec tab. Approving advances to architecture; rejecting will cancel this run.',
  },
  'architecture-approval': {
    title: 'Approve the architecture',
    body: 'Review the file tree and interface contract in the Architecture tab. Approving starts code generation; rejecting will cancel this run.',
  },
  'evaluator-clarification': {
    title: 'The evaluator wants clarification',
    body: 'The evaluator failed too many times. Provide a clarification or refine the spec.',
  },
};

export function GatePanel({ sessionId, gate }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const info = GATE_LABELS[gate] || {
    title: `Action required: ${gate}`,
    body: 'The pipeline is paused and waiting for your input.',
  };

  async function handle(action, payload) {
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') {
        await approveGate(sessionId, gate, payload);
      } else {
        await rejectGate(sessionId, gate, payload);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/30 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-100">{info.title}</h3>
          <p className="mt-1 text-xs text-amber-200/80">{info.body}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => handle('approve')}
              disabled={Boolean(busy)}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 px-3 py-1.5 text-xs font-medium text-white inline-flex items-center gap-1.5"
            >
              {busy === 'approve' && <Spinner size={10} />}
              Approve
            </button>
            <button
              type="button"
              onClick={() => handle('reject', 'rejected by user')}
              disabled={Boolean(busy)}
              className="rounded-md bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-3 py-1.5 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
            >
              {busy === 'reject' && <Spinner size={10} />}
              Reject
            </button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
