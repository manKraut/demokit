// Stack registry — DemoKit ships with two stacks, both with the same
// React + Vite + Tailwind frontend. Architect, coder, and packager
// agents read from this registry to fill in stack-specific text in
// their SKILL.md sections via the `{{stackNotes}}`, `{{stackPrereqs}}`,
// `{{stackInstallSteps}}`, and `{{stackRunSteps}}` placeholders.

export const STACKS = Object.freeze({
  'stack-a': {
    id: 'stack-a',
    label: 'React + FastAPI + SQLAlchemy + SQLite',
    notes: `
Frontend: React + Vite + Tailwind + React Router (browser router).
Backend: FastAPI (Python 3.11+) with SQLAlchemy 2.x ORM, served by Uvicorn.
Database: SQLite via SQLAlchemy.

Project layout (relative to project root):
  client/                   — React app
    src/
      mocks/                — stubs for out-of-scope concerns (see [OUT_OF_SCOPE])
      pages/                — top-level routes (max 3)
      components/           — shared UI
      lib/api.js            — fetch helpers; reads import.meta.env.VITE_API_URL
      App.jsx, main.jsx, index.css
  server/
    app/
      main.py               — FastAPI app object, route registration
      db.py                 — SQLAlchemy engine + session
      models.py             — declarative table models
      schemas.py            — pydantic request/response schemas
      routes/               — one module per resource (notes.py, ...)
    requirements.txt        — pinned Python deps

Endpoint definition pattern:
  from fastapi import APIRouter
  router = APIRouter()

  @router.get("/api/notes")
  async def list_notes(db: Session = Depends(get_db)) -> list[NoteOut]:
      ...

Then in app/main.py:
  app = FastAPI()
  app.include_router(notes.router)

Env reads must be literal:
  os.environ["DATABASE_URL"]  or  os.getenv("PORT")
`.trim(),
    prereqs: 'Node 20+, Python 3.11+, pip',
    installSteps: [
      'npm run install:client',
      'python -m venv server/.venv && source server/.venv/bin/activate',
      'pip install -r server/requirements.txt',
    ].join('\n'),
    runSteps: [
      '# Terminal 1 — backend',
      'cd server && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000',
      '# Terminal 2 — frontend (proxies /api to localhost:8000)',
      'npm run dev:client',
    ].join('\n'),
    backendPackages: ['fastapi', 'uvicorn[standard]', 'sqlalchemy', 'pydantic'],
    defaultBackendEnv: { PORT: '8000', DATABASE_URL: 'sqlite:///./dev.db' },
    defaultFrontendEnv: { VITE_API_URL: 'http://localhost:8000' },
  },

  'stack-b': {
    id: 'stack-b',
    label: 'React + Express + better-sqlite3 + SQLite',
    notes: `
Frontend: React + Vite + Tailwind + React Router (browser router).
Backend: Node.js + Express, using better-sqlite3 (sync, in-process).
Database: SQLite file via better-sqlite3.

Project layout (relative to project root):
  client/                   — React app
    src/
      mocks/                — stubs for out-of-scope concerns (see [OUT_OF_SCOPE])
      pages/                — top-level routes (max 3)
      components/           — shared UI
      lib/api.js            — fetch helpers; reads import.meta.env.VITE_API_URL
      App.jsx, main.jsx, index.css
  server/
    index.js                — Express app, route mounting, listen()
    db.js                   — better-sqlite3 connection + schema init
    routes/                 — one module per resource (notes.js, ...)
  package.json              — root package.json with concurrently scripts

Endpoint definition pattern:
  import express from 'express';
  const router = express.Router();

  router.get('/api/notes', (req, res) => {
    const rows = db.prepare('SELECT * FROM notes').all();
    res.json(rows);
  });

  export default router;

Then in server/index.js:
  app.use(notesRouter);

Env reads must be literal:
  process.env.PORT  or  process.env.DATABASE_URL
`.trim(),
    prereqs: 'Node 20+',
    installSteps: 'npm run install:all',
    runSteps: 'npm run dev   # starts both client and server via concurrently (proxies /api to the backend)',
    backendPackages: ['express', 'better-sqlite3', 'cors'],
    defaultBackendEnv: { PORT: '3001', DATABASE_URL: './dev.db' },
    defaultFrontendEnv: { VITE_API_URL: 'http://localhost:3001' },
  },
});

export const STACK_IDS = Object.freeze(['stack-a', 'stack-b']);

/**
 * Resolve a stack id to its full descriptor. Throws on unknown id.
 * @param {string} id
 */
export function getStack(id) {
  const stack = STACKS[id];
  if (!stack) {
    throw new Error(`Unknown stack: ${id}. Supported: ${STACK_IDS.join(', ')}`);
  }
  return stack;
}
