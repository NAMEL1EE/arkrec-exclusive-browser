CREATE TABLE IF NOT EXISTS site_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatching', 'queued', 'failed')),
  run_id INTEGER
);
