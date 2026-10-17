CREATE TABLE staff_accounts (
  staff_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff_accounts ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_sessions_expiry ON staff_sessions(expires_at);