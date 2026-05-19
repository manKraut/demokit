// Subscribes to a session's SSE stream and aggregates orchestrator
// events into a single React-friendly state object.
//
// Returned state shape:
//   {
//     status: 'connecting' | 'connected' | 'closed' | 'error',
//     meta:   { id, projectName, stack, status, currentStep, usage, retries, error, ... },
//     pendingGate: 'scope-approval' | 'architecture-approval' | 'evaluator-clarification' | null,
//     terminalStatus: 'done' | 'failed' | 'cancelled' | null,
//     chat:   [{ role, content }],     // user + assistant for the debrief
//     liveDebriefText: string,         // currently streaming assistant tokens
//     events: [...],                   // recent orchestrator events (capped)
//     lastError: { message, ts } | null,
//   }

import { useEffect, useReducer, useRef } from 'react';
import { eventsUrl } from '../lib/api.js';
import { subscribeEvents } from '../lib/sseClient.js';

const EVENT_BUFFER_CAP = 500;

function initialState() {
  return {
    status: 'connecting',
    meta: null,
    pendingGate: null,
    pendingGatePayload: null,
    terminalStatus: null,
    chat: [],
    liveDebriefText: '',
    events: [],
    lastError: null,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'connection': {
      return { ...state, status: action.status };
    }

    case 'snapshot': {
      const meta = action.payload?.meta || null;
      let terminalStatus = null;
      if (meta?.status === 'done') terminalStatus = 'done';
      else if (meta?.status === 'failed') terminalStatus = 'failed';
      return {
        ...state,
        meta,
        pendingGate: action.payload?.pendingGate || null,
        pendingGatePayload: null,
        status: 'connected',
        terminalStatus,
      };
    }

    case 'state-changed': {
      // The server's state-changed payload includes { from, to } and
      // current meta is best updated by refetching, but for stage
      // progress purposes we keep a shadow on meta.status.
      const newMeta = state.meta
        ? { ...state.meta, status: action.payload?.to ?? state.meta.status }
        : state.meta;
      return appendEvent({ ...state, meta: newMeta }, action);
    }

    case 'user-message': {
      // Echo user message into the chat history. The orchestrator emits
      // this AFTER receiving the message from sendMessage().
      const text = action.payload?.text;
      if (typeof text !== 'string') return appendEvent(state, action);
      return appendEvent(
        {
          ...state,
          chat: [...state.chat, { role: 'user', content: text }],
          liveDebriefText: '',
        },
        action
      );
    }

    case 'token': {
      // Stream assistant tokens (debrief only). The reducer accumulates
      // them until agent-end, when we flush into chat.
      if (action.payload?.agent !== 'debrief') return appendEvent(state, action);
      return appendEvent(
        {
          ...state,
          liveDebriefText: state.liveDebriefText + (action.payload?.text || ''),
        },
        action
      );
    }

    case 'agent-end': {
      // Flush the streaming buffer into a chat bubble when debrief
      // finishes a turn.
      if (action.payload?.agent === 'debrief' && state.liveDebriefText.length > 0) {
        return appendEvent(
          {
            ...state,
            chat: [
              ...state.chat,
              { role: 'assistant', content: state.liveDebriefText.trim() },
            ],
            liveDebriefText: '',
          },
          action
        );
      }
      return appendEvent(state, action);
    }

    case 'awaiting-input': {
      return appendEvent(
        {
          ...state,
          pendingGate: action.payload?.gate || null,
          pendingGatePayload: action.payload || null,
        },
        action
      );
    }

    case 'gate-approved':
    case 'gate-rejected': {
      return appendEvent({ ...state, pendingGate: null, pendingGatePayload: null }, action);
    }

    case 'done': {
      return appendEvent({ ...state, terminalStatus: 'done' }, action);
    }

    case 'failed': {
      return appendEvent(
        {
          ...state,
          terminalStatus: 'failed',
          lastError: {
            message: action.payload?.error?.message || 'Pipeline failed',
            ts: action.payload?.timestamp,
          },
        },
        action
      );
    }

    case 'cancelled': {
      return appendEvent({ ...state, terminalStatus: 'cancelled' }, action);
    }

    case 'error': {
      return appendEvent(
        {
          ...state,
          lastError: {
            message: action.payload?.error?.message || 'Unknown error',
            ts: action.payload?.timestamp,
          },
        },
        action
      );
    }

    default:
      return appendEvent(state, action);
  }
}

function appendEvent(state, action) {
  const next = state.events.length >= EVENT_BUFFER_CAP
    ? state.events.slice(-EVENT_BUFFER_CAP + 1)
    : state.events.slice();
  next.push({ name: action.type, payload: action.payload, ts: Date.now() });
  return { ...state, events: next };
}

/**
 * @param {string|null} sessionId - if null, no subscription is opened
 */
export function useSession(sessionId) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stopRef = useRef(null);

  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: 'connection', status: 'closed' });
      return;
    }

    dispatch({ type: 'connection', status: 'connecting' });

    const stop = subscribeEvents(eventsUrl(sessionId), {
      onOpen: () => dispatch({ type: 'connection', status: 'connected' }),
      onError: () => dispatch({ type: 'connection', status: 'error' }),
      onEvent: (name, payload) => dispatch({ type: name, payload }),
    });
    stopRef.current = stop;

    return () => {
      try {
        stop();
      } catch {
        // ignore
      }
      stopRef.current = null;
    };
  }, [sessionId]);

  return state;
}
