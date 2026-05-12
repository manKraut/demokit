import { Link, useLocation, useParams } from 'react-router-dom';
import { useState } from 'react';
import { ApiKeyGate } from './ApiKeyGate.jsx';
import { classNames } from '../lib/formatters.js';

export function Header({ projectName, status }) {
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const { id } = useParams();
  const { pathname } = useLocation();
  const onTrace = pathname.endsWith('/trace');

  return (
    <>
      <header className="sticky top-0 z-30 bg-slate-950/80 backdrop-blur border-b border-slate-800">
        <div className="mx-auto max-w-7xl px-6 py-3 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 text-slate-100 hover:text-emerald-400">
            <Logo />
            <span className="font-semibold tracking-tight">DemoKit</span>
          </Link>

          {projectName && (
            <div className="flex-1 text-center text-sm text-slate-300 truncate">
              <span className="font-mono">{projectName}</span>
              {status && (
                <span className="ml-2 text-xs text-slate-500">· {status}</span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {id && (
              <Link
                to={onTrace ? `/session/${id}` : `/session/${id}/trace`}
                className={classNames(
                  'text-xs px-3 py-1.5 rounded-md',
                  'text-slate-300 hover:text-white hover:bg-slate-800'
                )}
              >
                {onTrace ? 'Workspace' : 'Trace'}
              </Link>
            )}
            <button
              type="button"
              onClick={() => setKeyEditorOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800"
            >
              Keys
            </button>
          </div>
        </div>
      </header>
      {keyEditorOpen && <ApiKeyGate forceOpen onClose={() => setKeyEditorOpen(false)} />}
    </>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 4l7 8-7 8"
        stroke="#34d399"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13 20h7" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
