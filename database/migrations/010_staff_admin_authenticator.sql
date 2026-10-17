ALTER TABLE staff_accounts
  ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'staff'
    CHECK (role IN ('admin', 'staff')),
  ADD COLUMN totp_secret_encrypted TEXT,
  ADD COLUMN totp_pending_secret_encrypted TEXT,
  ADD COLUMN totp_last_time_step BIGINT;

UPDATE staff_accounts
SET role='admin'
WHERE staff_id=(SELECT min(staff_id) FROM staff_accounts);