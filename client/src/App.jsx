import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { HomePage } from './pages/HomePage.jsx';
import { SessionPage } from './pages/SessionPage.jsx';
import { TracePage } from './pages/TracePage.jsx';
import { ApiKeyGate } from './components/ApiKeyGate.jsx';

/**
 * Top-level shell.
 *
 * Routing (max 3 routes):
 *   /                    HomePage     — list + new project + key gate
 *   /session/:id         SessionPage  — main workspace
 *   /session/:id/trace   TracePage    — full agent I/O trace
 *
 * The ApiKeyGate is mounted globally and renders as a blocking modal
 * whenever localStorage has no provider keys saved. Once at least one is
 * stored, the gate hides itself; it re-opens automatically when an SSE
 * `error` event carries an authentication-shaped message (handled inside
 * SessionPage).
 */
export function App() {
  return (
    <BrowserRouter>
      <ApiKeyGate />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/session/:id" element={<SessionPage />} />
        <Route path="/session/:id/trace" element={<TracePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
