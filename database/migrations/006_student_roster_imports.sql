ALTER TABLE students
  DROP CONSTRAINT students_email_key,
  ADD COLUMN institution_student_id VARCHAR(40) UNIQUE,
  ADD COLUMN academic_section VARCHAR(16);

CREATE INDEX idx_students_email ON students(email) WHERE email IS NOT NULL;

CREATE TABLE student_roster_imports (
  import_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_filename VARCHAR(255) NOT NULL,
  source_sha256 CHAR(64) NOT NULL UNIQUE,
  student_count INTEGER NOT NULL CHECK (student_count > 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_roster_import_rows (
  import_id INTEGER NOT NULL REFERENCES student_roster_imports ON DELETE CASCADE,
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  source_data JSONB NOT NULL,
  student_id INTEGER REFERENCES students ON DELETE SET NULL,
  PRIMARY KEY (import_id, source_row_number)
);