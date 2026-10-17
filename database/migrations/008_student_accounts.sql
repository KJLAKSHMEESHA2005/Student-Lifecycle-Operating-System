CREATE TABLE student_accounts (
  student_id INTEGER PRIMARY KEY REFERENCES students ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES student_accounts ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_student_sessions_expiry ON student_sessions(expires_at);