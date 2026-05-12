import { useState } from 'react';
import { PROVIDER_IDS, PROVIDER_LABELS } from '../lib/apiKey.js';
import { useApiKey } from '../hooks/useApiKey.js';
import { classNames } from '../lib/formatters.js';

/**
 * Editable list of provider keys, persisted to localStorage on blur.
 * Used both inside the gate modal and in the header settings drawer.
 */
export function ApiKeyEditor({ compact = false }) {
  const { keys, setKey } = useApiKey();
  const [revealed, setRevealed] = useState(new Set());

  function toggleReveal(id) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleChange(id, value) {
    // Auto-save on every change so paste-then-click immediately enables
    // the gate's "Done / Continue" button. We pass the value through as
    // typed; the storage layer trims on write.
    setKey(id, value);
  }

  return (
    <div className={classNames('space-y-3', compact ? 'text-sm' : 'text-sm')}>
      {PROVIDER_IDS.map((id) => {
        const stored = keys[id] || '';
        const masked = !revealed.has(id);
        return (
          <div key={id} className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-slate-300">
              <span className="font-medium">{PROVIDER_LABELS[id]}</span>
              {stored && (
                <span className="text-xs text-emerald-400">saved</span>
              )}
            </label>
            <div className="flex gap-2">
              <input
                type={masked ? 'password' : 'text'}
                value={stored}
                placeholder={id === 'ollama' ? '(leave empty for local)' : `${id} API key`}
                onChange={(e) => handleChange(id, e.target.value)}
                className="flex-1 rounded-md bg-slate-900 border border-slate-700 px-3 py-2 font-mono text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={() => toggleReveal(id)}
                className="px-2 rounded-md text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                aria-label={masked ? 'reveal' : 'hide'}
              >
                {masked ? 'show' : 'hide'}
              </button>
              {stored && (
                <button
                  type="button"
                  onClick={() => setKey(id, '')}
                  className="px-2 rounded-md text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800"
                >
                  clear
                </button>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-slate-500 pt-2">
        Keys are stored in your browser&apos;s localStorage and sent only to your
        local DemoKit server. They are never written to disk on the server.
      </p>
    </div>
  );
}
