import { classNames } from '../lib/formatters.js';

export function MessageBubble({ role, content, streaming = false }) {
  const isUser = role === 'user';
  return (
    <div className={classNames('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={classNames(
          'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words',
          isUser
            ? 'bg-emerald-600 text-white rounded-br-sm'
            : 'bg-slate-800 text-slate-100 rounded-bl-sm'
        )}
      >
        {content}
        {streaming && (
          <span className="ml-1 inline-block w-1.5 h-4 align-[-2px] bg-current opacity-70 animate-pulse" />
        )}
      </div>
    </div>
  );
}
