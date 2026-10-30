CREATE TABLE IF NOT EXISTS price_book_rule_snapshots (
  price_book_id INTEGER PRIMARY KEY REFERENCES billing_price_books(id),
  version INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
