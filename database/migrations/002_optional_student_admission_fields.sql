ALTER TABLE students
  ALTER COLUMN program_id DROP NOT NULL,
  ALTER COLUMN admission_date DROP NOT NULL;

CREATE OR REPLACE VIEW student_lifecycle_summary AS
SELECT s.student_id, s.roll_number, s.first_name, s.last_name, s.email, s.current_semester,
       s.status AS student_status, p.program_name, d.department_name,
       COUNT(DISTINCT e.section_id) FILTER (WHERE e.status='enrolled') AS active_courses,
       COALESCE(ROUND(100.0 * COUNT(a.attendance_id) FILTER (WHERE a.attendance_status IN ('present','late')) /
         NULLIF(COUNT(a.attendance_id) FILTER (WHERE a.attendance_status <> 'excused'),0),1),0) AS attendance_percent
FROM students s
LEFT JOIN programs p USING(program_id)
LEFT JOIN departments d USING(department_id)
LEFT JOIN enrollments e USING(student_id)
LEFT JOIN attendance a USING(enrollment_id)
GROUP BY s.student_id,p.program_name,d.department_name;