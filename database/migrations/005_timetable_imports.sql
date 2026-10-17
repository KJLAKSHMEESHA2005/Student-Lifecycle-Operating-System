CREATE TABLE timetable_imports (
  import_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_filename VARCHAR(255) NOT NULL,
  source_sha256 CHAR(64) NOT NULL UNIQUE,
  sheet_name VARCHAR(120) NOT NULL,
  metadata JSONB NOT NULL,
  sheet_cells JSONB NOT NULL,
  merged_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE timetable_entries (
  entry_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES timetable_imports ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 6),
  day_name VARCHAR(12) NOT NULL,
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  entry_kind VARCHAR(16) NOT NULL CHECK (entry_kind IN ('class','short_break','lunch_break')),
  entry_text TEXT NOT NULL,
  source_range VARCHAR(16) NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (import_id, day_of_week, starts_at, source_range)
);

CREATE INDEX idx_timetable_entries_import_day_time
  ON timetable_entries(import_id, day_of_week, starts_at);