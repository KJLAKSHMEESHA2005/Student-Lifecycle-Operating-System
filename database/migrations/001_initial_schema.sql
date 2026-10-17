CREATE TABLE departments (
  department_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_code VARCHAR(12) NOT NULL UNIQUE,
  department_name VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE programs (
  program_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments ON DELETE RESTRICT,
  program_code VARCHAR(16) NOT NULL UNIQUE,
  program_name VARCHAR(120) NOT NULL,
  degree_level VARCHAR(24) NOT NULL CHECK (degree_level IN ('Undergraduate','Postgraduate','Doctoral')),
  standard_credits SMALLINT NOT NULL CHECK (standard_credits > 0),
  UNIQUE (department_id, program_name)
);

CREATE TABLE academic_terms (
  term_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_code VARCHAR(20) NOT NULL UNIQUE,
  term_name VARCHAR(80) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  registration_opens_on DATE NOT NULL,
  CHECK (ends_on > starts_on),
  CHECK (registration_opens_on <= starts_on)
);

CREATE TABLE students (
  student_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs ON DELETE RESTRICT,
  roll_number VARCHAR(24) NOT NULL UNIQUE,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  admission_date DATE NOT NULL,
  current_semester SMALLINT NOT NULL CHECK (current_semester > 0),
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','leave','graduated','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE faculty (
  faculty_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments ON DELETE RESTRICT,
  employee_number VARCHAR(24) NOT NULL UNIQUE,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  title VARCHAR(40) NOT NULL
);

CREATE TABLE courses (
  course_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments ON DELETE RESTRICT,
  course_code VARCHAR(16) NOT NULL UNIQUE,
  course_name VARCHAR(140) NOT NULL,
  credits SMALLINT NOT NULL CHECK (credits BETWEEN 1 AND 12),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE course_prerequisites (
  course_id INTEGER NOT NULL REFERENCES courses ON DELETE CASCADE,
  prerequisite_course_id INTEGER NOT NULL REFERENCES courses ON DELETE RESTRICT,
  PRIMARY KEY (course_id, prerequisite_course_id),
  CHECK (course_id <> prerequisite_course_id)
);

CREATE TABLE course_sections (
  section_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses ON DELETE RESTRICT,
  term_id INTEGER NOT NULL REFERENCES academic_terms ON DELETE RESTRICT,
  faculty_id INTEGER NOT NULL REFERENCES faculty ON DELETE RESTRICT,
  section_code VARCHAR(8) NOT NULL,
  room VARCHAR(40) NOT NULL,
  capacity SMALLINT NOT NULL CHECK (capacity > 0),
  UNIQUE (course_id, term_id, section_code)
);

CREATE TABLE section_meetings (
  meeting_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES course_sections ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (section_id, day_of_week, starts_at)
);

CREATE TABLE enrollments (
  enrollment_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students ON DELETE RESTRICT,
  section_id INTEGER NOT NULL REFERENCES course_sections ON DELETE RESTRICT,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status VARCHAR(16) NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','dropped','completed')),
  final_grade VARCHAR(3) CHECK (final_grade IS NULL OR final_grade IN ('A','A-','B+','B','B-','C+','C','D','F')),
  UNIQUE (student_id, section_id)
);

CREATE TABLE class_sessions (
  session_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES course_sections ON DELETE CASCADE,
  session_date DATE NOT NULL,
  starts_at TIME NOT NULL,
  topic VARCHAR(160) NOT NULL DEFAULT '',
  UNIQUE (section_id, session_date, starts_at)
);

CREATE TABLE attendance (
  attendance_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES class_sessions ON DELETE CASCADE,
  attendance_status VARCHAR(12) NOT NULL CHECK (attendance_status IN ('present','absent','late','excused')),
  marked_by INTEGER REFERENCES faculty ON DELETE SET NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, session_id)
);

CREATE TABLE assessments (
  assessment_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES course_sections ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  assessment_type VARCHAR(20) NOT NULL CHECK (assessment_type IN ('assignment','quiz','project','midterm','final','lab')),
  points_possible NUMERIC(7,2) NOT NULL CHECK (points_possible > 0),
  weight_percent NUMERIC(5,2) NOT NULL CHECK (weight_percent BETWEEN 0 AND 100),
  assigned_at DATE NOT NULL DEFAULT CURRENT_DATE,
  due_at TIMESTAMPTZ,
  UNIQUE (section_id, title)
);

CREATE TABLE assessment_results (
  result_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments ON DELETE CASCADE,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments ON DELETE CASCADE,
  points_earned NUMERIC(7,2) NOT NULL CHECK (points_earned >= 0),
  feedback TEXT NOT NULL DEFAULT '',
  graded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, enrollment_id)
);

CREATE TABLE course_materials (
  material_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES course_sections ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES faculty ON DELETE RESTRICT,
  title VARCHAR(160) NOT NULL,
  material_type VARCHAR(20) NOT NULL CHECK (material_type IN ('lecture','reading','slides','reference','recording')),
  resource_url TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  announcement_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id INTEGER REFERENCES departments ON DELETE CASCADE,
  section_id INTEGER REFERENCES course_sections ON DELETE CASCADE,
  author_faculty_id INTEGER REFERENCES faculty ON DELETE SET NULL,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  audience VARCHAR(16) NOT NULL CHECK (audience IN ('campus','department','section')),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  CHECK (expires_at IS NULL OR expires_at > published_at),
  CHECK ((audience='campus' AND department_id IS NULL AND section_id IS NULL) OR
         (audience='department' AND department_id IS NOT NULL AND section_id IS NULL) OR
         (audience='section' AND section_id IS NOT NULL AND department_id IS NULL))
);

CREATE TABLE student_records (
  record_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students ON DELETE RESTRICT,
  term_id INTEGER NOT NULL REFERENCES academic_terms ON DELETE RESTRICT,
  record_type VARCHAR(24) NOT NULL CHECK (record_type IN ('semester_result','academic_notice','degree_audit','conduct')),
  title VARCHAR(160) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  operation VARCHAR(10) NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  record_key TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_values JSONB,
  new_values JSONB
);

CREATE INDEX idx_students_program_status ON students(program_id, status);
CREATE INDEX idx_sections_term_course ON course_sections(term_id, course_id);
CREATE INDEX idx_sections_faculty_term ON course_sections(faculty_id, term_id);
CREATE INDEX idx_enrollments_student_status ON enrollments(student_id, status);
CREATE INDEX idx_meetings_day_time ON section_meetings(section_id, day_of_week, starts_at);
CREATE INDEX idx_sessions_section_date ON class_sessions(section_id, session_date);
CREATE INDEX idx_attendance_enrollment_status ON attendance(enrollment_id, attendance_status);
CREATE INDEX idx_assessments_section_due ON assessments(section_id, due_at);
CREATE INDEX idx_results_enrollment ON assessment_results(enrollment_id);
CREATE INDEX idx_announcements_published ON announcements(published_at DESC);
CREATE INDEX idx_records_student_term ON student_records(student_id, term_id);

CREATE FUNCTION audit_attendance_change() RETURNS TRIGGER AS $$
DECLARE row_data JSONB;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  INSERT INTO audit_log(table_name, operation, record_key, old_values, new_values)
  VALUES (TG_TABLE_NAME, TG_OP, COALESCE(row_data->>'attendance_id','unknown'),
          CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_audit AFTER INSERT OR UPDATE OR DELETE ON attendance
FOR EACH ROW EXECUTE FUNCTION audit_attendance_change();

CREATE FUNCTION enforce_section_capacity() RETURNS TRIGGER AS $$
DECLARE section_capacity SMALLINT; occupied INTEGER; excluded_id INTEGER;
BEGIN
  IF NEW.status <> 'enrolled' THEN RETURN NEW; END IF;
  SELECT capacity INTO section_capacity FROM course_sections WHERE section_id=NEW.section_id FOR UPDATE;
  IF TG_OP='UPDATE' THEN excluded_id := OLD.enrollment_id; END IF;
  SELECT COUNT(*) INTO occupied FROM enrollments
  WHERE section_id=NEW.section_id AND status='enrolled'
    AND (excluded_id IS NULL OR enrollment_id <> excluded_id);
  IF occupied >= section_capacity THEN
    RAISE EXCEPTION 'Section % is at capacity (%)', NEW.section_id, section_capacity USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER enrollment_capacity BEFORE INSERT OR UPDATE OF section_id, status ON enrollments
FOR EACH ROW EXECUTE FUNCTION enforce_section_capacity();

CREATE FUNCTION validate_attendance_section() RETURNS TRIGGER AS $$
DECLARE enrollment_section INTEGER; session_section INTEGER;
BEGIN
  SELECT section_id INTO enrollment_section FROM enrollments WHERE enrollment_id=NEW.enrollment_id;
  SELECT section_id INTO session_section FROM class_sessions WHERE session_id=NEW.session_id;
  IF enrollment_section IS DISTINCT FROM session_section THEN
    RAISE EXCEPTION 'Enrollment and class session must belong to the same section' USING ERRCODE='foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER attendance_section BEFORE INSERT OR UPDATE OF enrollment_id, session_id ON attendance
FOR EACH ROW EXECUTE FUNCTION validate_attendance_section();

CREATE VIEW student_lifecycle_summary AS
SELECT s.student_id, s.roll_number, s.first_name, s.last_name, s.email, s.current_semester,
       s.status AS student_status, p.program_name, d.department_name,
       COUNT(DISTINCT e.section_id) FILTER (WHERE e.status='enrolled') AS active_courses,
       COALESCE(ROUND(100.0 * COUNT(a.attendance_id) FILTER (WHERE a.attendance_status IN ('present','late')) /
         NULLIF(COUNT(a.attendance_id) FILTER (WHERE a.attendance_status <> 'excused'),0),1),0) AS attendance_percent
FROM students s JOIN programs p USING(program_id) JOIN departments d USING(department_id)
LEFT JOIN enrollments e USING(student_id) LEFT JOIN attendance a USING(enrollment_id)
GROUP BY s.student_id,p.program_name,d.department_name;

CREATE VIEW attendance_register AS
SELECT e.enrollment_id,s.roll_number,cs.section_id,c.course_code,c.course_name,
       COUNT(a.attendance_id) AS sessions_recorded,
       COUNT(a.attendance_id) FILTER (WHERE a.attendance_status IN ('present','late')) AS sessions_attended,
       COUNT(a.attendance_id) FILTER (WHERE a.attendance_status='absent') AS sessions_missed,
       COALESCE(ROUND(100.0 * COUNT(a.attendance_id) FILTER (WHERE a.attendance_status IN ('present','late')) /
         NULLIF(COUNT(a.attendance_id) FILTER (WHERE a.attendance_status <> 'excused'),0),1),0) AS attendance_percent
FROM enrollments e JOIN students s USING(student_id)
JOIN course_sections cs USING(section_id) JOIN courses c USING(course_id)
LEFT JOIN attendance a USING(enrollment_id)
GROUP BY e.enrollment_id,s.roll_number,cs.section_id,c.course_code,c.course_name;

CREATE VIEW course_gradebook AS
SELECT e.enrollment_id,s.roll_number,c.course_code,c.course_name,a.assessment_id,
       a.title AS assessment_title,a.weight_percent,r.points_earned,a.points_possible,
       CASE WHEN r.result_id IS NOT NULL THEN ROUND(100.0*r.points_earned/a.points_possible,2) END AS score_percent,
       r.graded_at
FROM enrollments e JOIN students s USING(student_id)
JOIN course_sections cs USING(section_id) JOIN courses c USING(course_id)
JOIN assessments a USING(section_id)
LEFT JOIN assessment_results r ON r.assessment_id=a.assessment_id AND r.enrollment_id=e.enrollment_id;
