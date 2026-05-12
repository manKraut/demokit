import { useEffect, useState } from 'react';
import { fetchFile, fetchFiles, zipUrl } from '../lib/api.js';
import { Spinner } from './Spinner.jsx';

/**
 * Two-pane viewer for the session's generated output/ tree.
 * Auto-refetches the list on `refreshKey` change.
 */
export function FileExplorer({ sessionId, refreshKey, canDownload }) {
  const [files, setFiles] = useState([]);
  const [active, setActive] = useState(null);
  const [content, setContent] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoadingList(true);
    setError(null);
    fetchFiles(sessionId)
      .then(({ files }) => {
        if (cancelled) return;
        setFiles(files || []);
        if (active && !files?.includes(active)) {
          setActive(null);
          setContent('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refreshKey]);

  useEffect(() => {
    if (!sessionId || !active) return;
    let cancelled = false;
    setLoadingFile(true);
    fetchFile(sessionId, active)
      .then((text) => {
        if (!cancelled) setContent(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
      })
      .catch((err) => {
        if (!cancelled) setContent(`// failed to load: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, active]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-xs text-slate-400">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <a
          href={zipUrl(sessionId)}
          download
          className={
            canDownload
              ? 'text-xs px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium'
              : 'text-xs px-3 py-1.5 rounded-md bg-slate-800 text-slate-500 cursor-not-allowed pointer-events-none'
          }
          aria-disabled={!canDownload}
        >
          Download zip
        </a>
      </div>
      <div className="flex-1 grid grid-cols-[minmax(160px,1fr)_2fr] min-h-0">
        <div className="overflow-y-auto border-r border-slate-800 p-2 space-y-0.5">
          {loadingList && (
            <div className="text-slate-500 text-xs flex items-center gap-2 p-2">
              <Spinner size={10} /> Loading…
            </div>
          )}
          {!loadingList && files.length === 0 && (
            <div className="text-slate-500 text-xs italic p-2">No files yet.</div>
          )}
          {!loadingList &&
            files.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setActive(p)}
                className={
                  active === p
                    ? 'block w-full text-left px-2 py-1 rounded text-xs font-mono bg-slate-800 text-emerald-300'
                    : 'block w-full text-left px-2 py-1 rounded text-xs font-mono text-slate-300 hover:bg-slate-800'
                }
                title={p}
              >
                {p}
              </button>
            ))}
        </div>
        <div className="overflow-auto p-3 text-xs font-mono min-h-0">
          {!active && (
            <div className="text-slate-500 italic">
              Select a file to preview its contents.
            </div>
          )}
          {active && loadingFile && (
            <div className="text-slate-500 flex items-center gap-2">
              <Spinner size={12} /> Loading {active}…
            </div>
          )}
          {active && !loadingFile && (
            <pre className="whitespace-pre-wrap break-words text-slate-200">
              {content}
            </pre>
          )}
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 bg-red-950/40 border-t border-red-900/40 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
