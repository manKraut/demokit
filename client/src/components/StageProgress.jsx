import { PRIMARY_STAGES, STAGE_LABELS } from '../lib/eventNames.js';
import { classNames } from '../lib/formatters.js';

// Map every concrete pipeline state to the "stage" it visually belongs to.
const STATE_TO_STAGE = {
  idle: 'debriefing',
  debriefing: 'debriefing',
  'awaiting-scope-approval': 'debriefing',
  scoping: 'scoping',
  architecting: 'architecting',
  'awaiting-architecture-approval': 'architecting',
  coding: 'coding',
  evaluating: 'evaluating',
  'awaiting-clarification': 'evaluating',
  packaging: 'packaging',
  done: 'done',
  failed: 'done',
};

export function StageProgress({ status, currentStep }) {
  const current = STATE_TO_STAGE[status] || 'debriefing';
  const currentIdx = PRIMARY_STAGES.indexOf(current);

  return (
    <div>
      <ol className="grid grid-cols-7 gap-1">
        {PRIMARY_STAGES.map((stage, idx) => {
          const done = idx < currentIdx;
          const active = idx === currentIdx;
          return (
            <li key={stage} className="flex flex-col items-center gap-1">
              <div
                className={classNames(
                  'h-1.5 w-full rounded-full transition-colors',
                  done && 'bg-emerald-500',
                  active && status === 'failed' && 'bg-red-500',
                  active && status !== 'failed' && 'bg-emerald-400 animate-pulse',
                  !done && !active && 'bg-slate-800'
                )}
              />
              <span
                className={classNames(
                  'text-[10px] uppercase tracking-wide font-medium',
                  done && 'text-slate-400',
                  active && 'text-emerald-300',
                  !done && !active && 'text-slate-600'
                )}
              >
                {STAGE_LABELS[stage]}
              </span>
            </li>
          );
        })}
      </ol>
      {currentStep && (
        <p className="mt-2 text-xs text-slate-400 font-mono truncate">
          {currentStep}
        </p>
      )}
    </div>
  );
}
