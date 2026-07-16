CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  trade_time TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(trade_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, trade_time DESC);

CREATE TABLE IF NOT EXISTS trade_reviews (
  trade_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_cache (
  cache_key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_cache_expiry ON market_cache(expires_at);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
