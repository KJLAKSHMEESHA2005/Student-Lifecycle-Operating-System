-- 1. Join, filtered aggregate, grouping, and HAVING: lifecycle overview by program.
SELECT department_name,program_name,COUNT(*) AS active_students,
       round(avg(attendance_percent),1) AS avg_attendance
FROM student_lifecycle_summary WHERE student_status='active'
GROUP BY department_name,program_name HAVING COUNT(*)>=1;

-- 2. Window functions: rank assessment results inside each course.
SELECT roll_number,course_code,assessment_title,score_percent,
       rank() OVER(PARTITION BY course_code ORDER BY score_percent DESC) AS course_rank,
       avg(score_percent) OVER(PARTITION BY course_code) AS course_average
FROM course_gradebook WHERE score_percent IS NOT NULL;

-- 3. CTE: find students below the 75% attendance threshold.
WITH attendance_check AS (
  SELECT s.roll_number,s.first_name,s.last_name,ar.course_code,ar.attendance_percent
  FROM students s JOIN enrollments e USING(student_id)
  JOIN attendance_register ar USING(enrollment_id)
  WHERE ar.sessions_recorded>0
)
SELECT * FROM attendance_check WHERE attendance_percent<75 ORDER BY attendance_percent;

-- 4. Parameterized workload report for one student.
SELECT s.roll_number,c.course_code,a.title,a.due_at,
       extract(epoch FROM (a.due_at-now()))/3600 AS hours_remaining
FROM students s JOIN enrollments e USING(student_id)
JOIN course_sections cs USING(section_id) JOIN courses c USING(course_id)
JOIN assessments a USING(section_id)
LEFT JOIN assessment_results r ON r.assessment_id=a.assessment_id AND r.enrollment_id=e.enrollment_id
WHERE s.roll_number=$1 AND r.result_id IS NULL AND a.due_at>=now()
ORDER BY a.due_at;

-- 5. Inspect the student enrollment access path and index usage.
EXPLAIN (ANALYZE,BUFFERS)
SELECT section_id,status,final_grade FROM enrollments WHERE student_id=$1 AND status='enrolled';

-- 6. Capacity enforcement is serialized by SELECT ... FOR UPDATE in the enrollment trigger.
-- Run concurrently in separate sessions against a section with one available place.
BEGIN;
SELECT capacity FROM course_sections WHERE section_id=$1 FOR UPDATE;
-- Insert an enrollment here using valid student and section identifiers.
COMMIT;

-- 7. Attendance audit trail stores before/after JSONB snapshots.
SELECT table_name,operation,record_key,changed_at,old_values,new_values
FROM audit_log WHERE table_name='attendance' ORDER BY changed_at DESC LIMIT 20;

-- 8. Unique (student_id, section_id) rejects duplicate enrollment.
SELECT student_id,section_id,count(*) FROM enrollments
GROUP BY student_id,section_id HAVING count(*)>1;
