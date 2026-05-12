// Thin wrapper around EventSource that knows about the named-event
// shape the DemoKit server emits.
//
// Usage:
//   const stop = subscribeEvents('/api/sessions/x/events', {
//     onEvent(name, payload) { ... },
//     onOpen() { ... },
//     onError(err) { ... },
//   });
//   // later: stop();

import { ORCHESTRATOR_EVENTS } from './eventNames.js';

export function subscribeEvents(url, { onEvent, onOpen, onError } = {}) {
  const es = new EventSource(url);
  const namedListeners = new Map();

  // EventSource doesn't surface named events on the default onmessage
  // handler — we have to subscribe per event name.
  for (const name of ORCHESTRATOR_EVENTS) {
    const listener = (e) => {
      let payload = null;
      try {
        payload = e.data ? JSON.parse(e.data) : null;
      } catch {
        payload = e.data;
      }
      onEvent?.(name, payload);
    };
    namedListeners.set(name, listener);
    es.addEventListener(name, listener);
  }

  // Snapshot is also a named event, but isn't in the orchestrator's
  // emission set — it's emitted by the SSE bridge on connect.
  const snapshotListener = (e) => {
    let payload = null;
    try {
      payload = e.data ? JSON.parse(e.data) : null;
    } catch {
      payload = e.data;
    }
    onEvent?.('snapshot', payload);
  };
  es.addEventListener('snapshot', snapshotListener);

  es.onopen = () => onOpen?.();
  es.onerror = (e) => onError?.(e);

  return function stop() {
    for (const [name, listener] of namedListeners) {
      es.removeEventListener(name, listener);
    }
    es.removeEventListener('snapshot', snapshotListener);
    try {
      es.close();
    } catch {
      // ignore
    }
  };
}
