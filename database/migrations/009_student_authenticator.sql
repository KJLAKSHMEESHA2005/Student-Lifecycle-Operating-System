ALTER TABLE student_accounts
  ADD COLUMN totp_secret_encrypted TEXT,
  ADD COLUMN totp_pending_secret_encrypted TEXT,
  ADD COLUMN totp_last_time_step BIGINT;