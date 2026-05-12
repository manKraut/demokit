import { useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble.jsx';
import { sendMessage } from '../lib/api.js';
import { Spinner } from './Spinner.jsx';

/**
 * Debrief chat — multi-turn conversation with the debrief agent.
 *
 * Props:
 *   - sessionId: string
 *   - chat:      [{ role, content }]
 *   - liveAssistantText: string  (currently streaming bubble)
 *   - status:    pipeline state (so we can disable input post-debrief)
 *   - disabled?: bool
 */
export function ChatPanel({ sessionId, chat, liveAssistantText, status, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, liveAssistantText]);

  const debriefActive = status === 'debriefing' || status === 'idle';
  const canSend = debriefActive && !disabled && !sending && text.trim().length > 0;

  async function submit(e) {
    e?.preventDefault();
    if (!canSend) return;
    const t = text.trim();
    setText('');
    setSending(true);
    setError(null);
    try {
      await sendMessage(sessionId, t);
    } catch (err) {
      setError(err.message);
      setText(t); // restore so user can retry
    } finally {
      setSending(false);
    }
  }

  const empty = chat.length === 0 && liveAssistantText.length === 0;

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {empty && debriefActive && (
          <div className="text-center text-sm text-slate-500 pt-12">
            <p className="font-medium text-slate-300">Describe the prototype you want to build.</p>
            <p className="mt-2 text-xs">
              The debrief agent will ask follow-up questions and produce a structured spec.
            </p>
          </div>
        )}

        {chat.map((m, i) => (
          <MessageBubble key={i} role={m.role} content={m.content} />
        ))}

        {liveAssistantText && (
          <MessageBubble role="assistant" content={liveAssistantText} streaming />
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-slate-800 p-3 bg-slate-900/40"
      >
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            debriefActive
              ? "I want to build…"
              : 'Debrief has finished — the pipeline is running.'
          }
          disabled={!debriefActive || disabled || sending}
          className="flex-1 resize-none rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-400 px-4 py-2 text-sm font-medium text-white inline-flex items-center gap-1.5"
        >
          {sending ? <Spinner size={12} /> : null}
          Send
        </button>
      </form>
      {error && (
        <div className="px-4 py-2 bg-red-950/40 border-t border-red-900/40 text-xs text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
