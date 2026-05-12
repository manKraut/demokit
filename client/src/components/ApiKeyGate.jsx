import { useEffect, useState } from 'react';
import { ApiKeyEditor } from './ApiKeyEditor.jsx';
import { useApiKey } from '../hooks/useApiKey.js';

/**
 * Top-level modal that blocks the rest of the UI until at least one
 * provider key is stored. The gate also auto-reopens when a downstream
 * SSE error looks like an auth/key failure — caller passes that signal
 * via the `forceOpen` prop.
 *
 * Props:
 *   - forceOpen?:  boolean | string  // if string, used as banner text
 *   - onClose?:    () => void
 */
export function ApiKeyGate({ forceOpen = false, onClose }) {
  const { hasAny } = useApiKey();
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal when an explicit force signal arrives.
  useEffect(() => {
    if (forceOpen) setDismissed(false);
  }, [forceOpen]);

  const blocking = !hasAny;
  const open = blocking || (Boolean(forceOpen) && !dismissed);
  if (!open) return null;

  const banner =
    typeof forceOpen === 'string' && forceOpen.length > 0
      ? forceOpen
      : blocking
        ? 'DemoKit needs at least one provider key before it can run.'
        : null;

  function close() {
    if (blocking) return; // cannot close while no keys saved
    setDismissed(true);
    onClose?.();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Provider keys</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Bring your own keys — DemoKit never stores them on the server.
            </p>
          </div>
          {!blocking && (
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>

        {banner && (
          <div className="mx-6 mt-4 rounded-md border border-amber-700/40 bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
            {banner}
          </div>
        )}

        <div className="px-6 py-5">
          <ApiKeyEditor />
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-800">
          <button
            type="button"
            onClick={close}
            disabled={blocking}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white"
          >
            {blocking ? 'Save a key to continue' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
