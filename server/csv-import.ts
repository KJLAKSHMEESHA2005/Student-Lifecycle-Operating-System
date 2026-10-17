import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'
import type { PoolClient } from 'pg'

type CsvRow = Record<string, string>
type ImportEntity = { id: string; label: string; headers: readonly string[] }

const entities: readonly ImportEntity[] = [
  { id: 'departments', label: 'Departments', headers: ['department_code', 'department_name'] },
  { id: 'programs', label: 'Programs', headers: ['department_code', 'program_code', 'program_name', 'degree_level', 'standard_credits'] },
  { id: 'academic_terms', label: 'Academic terms', headers: ['term_code', 'term_name', 'starts_on', 'ends_on', 'registration_opens_on'] },
  { id: 'faculty', label: 'Faculty', headers: ['department_code', 'employee_number', 'first_name', 'last_name', 'email', 'title'] },
  { id: 'students', label: 'Students', headers: ['roll_number', 'first_name', 'last_name', 'email', 'admission_date', 'current_semester', 'program_code'] },
  { id: 'courses', label: 'Courses', headers: ['department_code', 'course_code', 'course_name', 'credits', 'description'] },
  { id: 'course_prerequisites', label: 'Course prerequisites', headers: ['course_code', 'prerequisite_course_code'] },
  { id: 'course_sections', label: 'Course sections', headers: ['course_code', 'term_code', 'employee_number', 'section_code', 'room', 'capacity'] },
  { id: 'section_meetings', label: 'Section meetings', headers: ['course_code', 'term_code', 'section_code', 'day_of_week', 'starts_at', 'ends_at'] },
  { id: 'enrollments', label: 'Enrollments', headers: ['roll_number', 'course_code', 'term_code', 'section_code', 'status', 'final_grade'] },
  { id: 'class_sessions', label: 'Class sessions', headers: ['course_code', 'term_code', 'section_code', 'session_date', 'starts_at', 'topic'] },
  { id: 'attendance', label: 'Attendance', headers: ['roll_number', 'course_code', 'term_code', 'section_code', 'session_date', 'starts_at', 'attendance_status', 'marked_by_employee_number'] },
  { id: 'assessments', label: 'Assessments', headers: ['course_code', 'term_code', 'section_code', 'title', 'assessment_type', 'points_possible', 'weight_percent', 'assigned_at', 'due_at'] },
  { id: 'assessment_results', label: 'Assessment results', headers: ['roll_number', 'course_code', 'term_code', 'section_code', 'assessment_title', 'points_earned', 'feedback'] },
  { id: 'course_materials', label: 'Course materials', headers: ['course_code', 'term_code', 'section_code', 'employee_number', 'title', 'material_type', 'resource_url'] },
  { id: 'announcements', label: 'Announcements', headers: ['audience', 'title', 'body', 'department_code', 'course_code', 'term_code', 'section_code', 'author_employee_number', 'published_at', 'expires_at'] },
  { id: 'student_records', label: 'Student records', headers: ['roll_number', 'term_code', 'record_type', 'title', 'details', 'recorded_at'] },
  { id: 'timetable_entries', label: 'Timetable entries', headers: ['day_of_week', 'day_name', 'starts_at', 'ends_at', 'entry_kind', 'entry_text', 'source_range'] },
]

export function listCsvImportEntities() {
  return entities.map(({ id, label, headers }) => ({ id, label, headers }))
}

function parseCsv(csvText: string, entity: ImportEntity): CsvRow[] {
  let headers: string[]
  let rows: CsvRow[]
  try {
    headers = (parse(csvText, { bom: true, to_line: 1, skip_empty_lines: true }) as string[][])[0] ?? []
    rows = parse(csvText, { bom: true, columns: true, skip_empty_lines: true, trim: true }) as CsvRow[]
  } catch (error) {
    throw new Error(`Could not parse CSV: ${error instanceof Error ? error.message : 'invalid format'}`)
  }
  const expected = new Set(entity.headers)
  const actual = new Set(headers)
  const missing = entity.headers.filter((header) => !actual.has(header))
  const unexpected = headers.filter((header) => !expected.has(header))
  if (headers.length !== actual.size || missing.length || unexpected.length) {
    throw new Error(`CSV headers must be: ${entity.headers.join(', ')}. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`)
  }
  if (!rows.length) throw new Error('CSV contains a header but no records.')
  if (rows.length > 5000) throw new Error('A single CSV import is limited to 5,000 records.')
  return rows
}

export function validateCsvImport(entityId: string, csvText: string) {
  const entity = entities.find((item) => item.id === entityId)
  if (!entity) throw new Error('Choose a supported academic record type.')
  return { entity, rows: parseCsv(csvText, entity) }
}

function value(row: CsvRow, column: string): string {
  return row[column]?.trim() ?? ''
}

function required(row: CsvRow, column: string, rowNumber: number): string {
  const result = value(row, column)
  if (!result) throw new Error(`CSV row ${rowNumber}: ${column} is required.`)
  return result
}

function nullable(row: CsvRow, column: string): string | null {
  return value(row, column) || null
}

async function lookupId(client: PoolClient, sql: string, values: unknown[], description: string, rowNumber: number): Promise<number> {
  const result = await client.query<{ id: number }>(sql, values)
  if (!result.rows[0]) throw new Error(`CSV row ${rowNumber}: ${description} was not found. Import related records first.`)
  return result.rows[0].id
}

async function sectionId(client: PoolClient, row: CsvRow, rowNumber: number): Promise<number> {
  return lookupId(client,
    `SELECT section.section_id AS id FROM course_sections section
     JOIN courses course USING(course_id) JOIN academic_terms term USING(term_id)
     WHERE course.course_code=$1 AND term.term_code=$2 AND section.section_code=$3`,
    [required(row, 'course_code', rowNumber), required(row, 'term_code', rowNumber), required(row, 'section_code', rowNumber)],
    'course section', rowNumber)
}

export async function importAcademicCsv(client: PoolClient, entityId: string, csvText: string): Promise<{ label: string; imported: number }> {
  const { entity, rows } = validateCsvImport(entityId, csvText)

  if (entityId === 'timetable_entries') {
    const sourceHash = createHash('sha256').update(csvText).digest('hex')
    const metadata = JSON.stringify({ source_format: 'csv', row_count: rows.length })
    const sourceCells = JSON.stringify(rows)
    const result = await client.query<{ import_id: number }>(
      `INSERT INTO timetable_imports(source_filename, source_sha256, sheet_name, metadata, sheet_cells)
       VALUES('timetable.csv', $1, 'CSV upload', $2::jsonb, $3::jsonb) RETURNING import_id`,
      [sourceHash, metadata, sourceCells],
    )
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2
      await client.query(
        `INSERT INTO timetable_entries(import_id, day_of_week, day_name, starts_at, ends_at, entry_kind, entry_text, source_range)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8)`,
        [result.rows[0].import_id, required(row, 'day_of_week', rowNumber), required(row, 'day_name', rowNumber),
          required(row, 'starts_at', rowNumber), required(row, 'ends_at', rowNumber), required(row, 'entry_kind', rowNumber),
          required(row, 'entry_text', rowNumber), required(row, 'source_range', rowNumber)],
      )
    }
    return { label: entity.label, imported: rows.length }
  }

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2
    switch (entityId) {
      case 'departments':
        await client.query('INSERT INTO departments(department_code, department_name) VALUES($1, $2)',
          [required(row, 'department_code', rowNumber), required(row, 'department_name', rowNumber)])
        break
      case 'programs': {
        const departmentId = await lookupId(client, 'SELECT department_id AS id FROM departments WHERE department_code=$1',
          [required(row, 'department_code', rowNumber)], 'department', rowNumber)
        await client.query('INSERT INTO programs(department_id, program_code, program_name, degree_level, standard_credits) VALUES($1, $2, $3, $4, $5)',
          [departmentId, required(row, 'program_code', rowNumber), required(row, 'program_name', rowNumber), required(row, 'degree_level', rowNumber), required(row, 'standard_credits', rowNumber)])
        break
      }
      case 'academic_terms':
        await client.query('INSERT INTO academic_terms(term_code, term_name, starts_on, ends_on, registration_opens_on) VALUES($1, $2, $3, $4, $5)',
          ['term_code', 'term_name', 'starts_on', 'ends_on', 'registration_opens_on'].map((column) => required(row, column, rowNumber)))
        break
      case 'faculty': {
        const departmentId = await lookupId(client, 'SELECT department_id AS id FROM departments WHERE department_code=$1',
          [required(row, 'department_code', rowNumber)], 'department', rowNumber)
        await client.query('INSERT INTO faculty(department_id, employee_number, first_name, last_name, email, title) VALUES($1, $2, $3, $4, $5, $6)',
          [departmentId, ...['employee_number', 'first_name', 'last_name', 'email', 'title'].map((column) => required(row, column, rowNumber))])
        break
      }
      case 'students': {
        const programCode = nullable(row, 'program_code')
        const programId = programCode
          ? await lookupId(client, 'SELECT program_id AS id FROM programs WHERE program_code=$1', [programCode], 'program', rowNumber)
          : null
        await client.query(
          `INSERT INTO students(program_id, roll_number, first_name, last_name, email, admission_date, current_semester)
           VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [programId, nullable(row, 'roll_number'), required(row, 'first_name', rowNumber), required(row, 'last_name', rowNumber),
            nullable(row, 'email')?.toLowerCase() ?? null, nullable(row, 'admission_date'), required(row, 'current_semester', rowNumber)],
        )
        break
      }
      case 'courses': {
        const departmentId = await lookupId(client, 'SELECT department_id AS id FROM departments WHERE department_code=$1',
          [required(row, 'department_code', rowNumber)], 'department', rowNumber)
        await client.query('INSERT INTO courses(department_id, course_code, course_name, credits, description) VALUES($1, $2, $3, $4, $5)',
          [departmentId, required(row, 'course_code', rowNumber), required(row, 'course_name', rowNumber), required(row, 'credits', rowNumber), value(row, 'description')])
        break
      }
      case 'course_prerequisites': {
        const courseId = await lookupId(client, 'SELECT course_id AS id FROM courses WHERE course_code=$1',
          [required(row, 'course_code', rowNumber)], 'course', rowNumber)
        const prerequisiteId = await lookupId(client, 'SELECT course_id AS id FROM courses WHERE course_code=$1',
          [required(row, 'prerequisite_course_code', rowNumber)], 'prerequisite course', rowNumber)
        await client.query('INSERT INTO course_prerequisites(course_id, prerequisite_course_id) VALUES($1, $2)', [courseId, prerequisiteId])
        break
      }
      case 'course_sections': {
        const courseId = await lookupId(client, 'SELECT course_id AS id FROM courses WHERE course_code=$1',
          [required(row, 'course_code', rowNumber)], 'course', rowNumber)
        const termId = await lookupId(client, 'SELECT term_id AS id FROM academic_terms WHERE term_code=$1',
          [required(row, 'term_code', rowNumber)], 'academic term', rowNumber)
        const facultyId = await lookupId(client, 'SELECT faculty_id AS id FROM faculty WHERE employee_number=$1',
          [required(row, 'employee_number', rowNumber)], 'faculty member', rowNumber)
        await client.query('INSERT INTO course_sections(course_id, term_id, faculty_id, section_code, room, capacity) VALUES($1, $2, $3, $4, $5, $6)',
          [courseId, termId, facultyId, required(row, 'section_code', rowNumber), required(row, 'room', rowNumber), required(row, 'capacity', rowNumber)])
        break
      }
      case 'section_meetings': {
        const id = await sectionId(client, row, rowNumber)
        await client.query('INSERT INTO section_meetings(section_id, day_of_week, starts_at, ends_at) VALUES($1, $2, $3, $4)',
          [id, required(row, 'day_of_week', rowNumber), required(row, 'starts_at', rowNumber), required(row, 'ends_at', rowNumber)])
        break
      }
      case 'enrollments': {
        const studentId = await lookupId(client, 'SELECT student_id AS id FROM students WHERE roll_number=$1',
          [required(row, 'roll_number', rowNumber)], 'student', rowNumber)
        const id = await sectionId(client, row, rowNumber)
        await client.query('INSERT INTO enrollments(student_id, section_id, status, final_grade) VALUES($1, $2, $3, $4)',
          [studentId, id, value(row, 'status') || 'enrolled', nullable(row, 'final_grade')])
        break
      }
      case 'class_sessions': {
        const id = await sectionId(client, row, rowNumber)
        await client.query('INSERT INTO class_sessions(section_id, session_date, starts_at, topic) VALUES($1, $2, $3, $4)',
          [id, required(row, 'session_date', rowNumber), required(row, 'starts_at', rowNumber), value(row, 'topic')])
        break
      }
      case 'attendance': {
        const studentId = await lookupId(client, 'SELECT student_id AS id FROM students WHERE roll_number=$1',
          [required(row, 'roll_number', rowNumber)], 'student', rowNumber)
        const section = await sectionId(client, row, rowNumber)
        const enrollmentId = await lookupId(client, 'SELECT enrollment_id AS id FROM enrollments WHERE student_id=$1 AND section_id=$2',
          [studentId, section], 'student enrollment', rowNumber)
        const sessionId = await lookupId(client,
          'SELECT session_id AS id FROM class_sessions WHERE section_id=$1 AND session_date=$2 AND starts_at=$3',
          [section, required(row, 'session_date', rowNumber), required(row, 'starts_at', rowNumber)], 'class session', rowNumber)
        const employeeNumber = nullable(row, 'marked_by_employee_number')
        const facultyId = employeeNumber
          ? await lookupId(client, 'SELECT faculty_id AS id FROM faculty WHERE employee_number=$1', [employeeNumber], 'faculty member', rowNumber)
          : null
        await client.query('INSERT INTO attendance(enrollment_id, session_id, attendance_status, marked_by) VALUES($1, $2, $3, $4)',
          [enrollmentId, sessionId, required(row, 'attendance_status', rowNumber), facultyId])
        break
      }
      case 'assessments': {
        const id = await sectionId(client, row, rowNumber)
        await client.query(
          `INSERT INTO assessments(section_id, title, assessment_type, points_possible, weight_percent, assigned_at, due_at)
           VALUES($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7)`,
          [id, required(row, 'title', rowNumber), required(row, 'assessment_type', rowNumber), required(row, 'points_possible', rowNumber),
            required(row, 'weight_percent', rowNumber), nullable(row, 'assigned_at'), nullable(row, 'due_at')],
        )
        break
      }
      case 'assessment_results': {
        const studentId = await lookupId(client, 'SELECT student_id AS id FROM students WHERE roll_number=$1',
          [required(row, 'roll_number', rowNumber)], 'student', rowNumber)
        const id = await sectionId(client, row, rowNumber)
        const enrollmentId = await lookupId(client, 'SELECT enrollment_id AS id FROM enrollments WHERE student_id=$1 AND section_id=$2',
          [studentId, id], 'student enrollment', rowNumber)
        const assessmentId = await lookupId(client, 'SELECT assessment_id AS id FROM assessments WHERE section_id=$1 AND title=$2',
          [id, required(row, 'assessment_title', rowNumber)], 'assessment', rowNumber)
        await client.query('INSERT INTO assessment_results(assessment_id, enrollment_id, points_earned, feedback) VALUES($1, $2, $3, $4)',
          [assessmentId, enrollmentId, required(row, 'points_earned', rowNumber), value(row, 'feedback')])
        break
      }
      case 'course_materials': {
        const id = await sectionId(client, row, rowNumber)
        const facultyId = await lookupId(client, 'SELECT faculty_id AS id FROM faculty WHERE employee_number=$1',
          [required(row, 'employee_number', rowNumber)], 'faculty member', rowNumber)
        await client.query('INSERT INTO course_materials(section_id, uploaded_by, title, material_type, resource_url) VALUES($1, $2, $3, $4, $5)',
          [id, facultyId, required(row, 'title', rowNumber), required(row, 'material_type', rowNumber), required(row, 'resource_url', rowNumber)])
        break
      }
      case 'announcements': {
        const departmentCode = nullable(row, 'department_code')
        const departmentId = departmentCode
          ? await lookupId(client, 'SELECT department_id AS id FROM departments WHERE department_code=$1', [departmentCode], 'department', rowNumber)
          : null
        const sectionIdValue = value(row, 'section_code') ? await sectionId(client, row, rowNumber) : null
        const employeeNumber = nullable(row, 'author_employee_number')
        const authorId = employeeNumber
          ? await lookupId(client, 'SELECT faculty_id AS id FROM faculty WHERE employee_number=$1', [employeeNumber], 'faculty member', rowNumber)
          : null
        await client.query(
          `INSERT INTO announcements(department_id, section_id, author_faculty_id, title, body, audience, published_at, expires_at)
           VALUES($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8)`,
          [departmentId, sectionIdValue, authorId, required(row, 'title', rowNumber), required(row, 'body', rowNumber),
            required(row, 'audience', rowNumber), nullable(row, 'published_at'), nullable(row, 'expires_at')],
        )
        break
      }
      case 'student_records': {
        const studentId = await lookupId(client, 'SELECT student_id AS id FROM students WHERE roll_number=$1',
          [required(row, 'roll_number', rowNumber)], 'student', rowNumber)
        const termId = await lookupId(client, 'SELECT term_id AS id FROM academic_terms WHERE term_code=$1',
          [required(row, 'term_code', rowNumber)], 'academic term', rowNumber)
        const details = value(row, 'details') || '{}'
        try { JSON.parse(details) } catch { throw new Error(`CSV row ${rowNumber}: details must be valid JSON.`) }
        await client.query(
          `INSERT INTO student_records(student_id, term_id, record_type, title, details, recorded_at)
           VALUES($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))`,
          [studentId, termId, required(row, 'record_type', rowNumber), required(row, 'title', rowNumber), details, nullable(row, 'recorded_at')],
        )
        break
      }
      default:
        throw new Error('Choose a supported academic record type.')
    }
  }

  return { label: entity.label, imported: rows.length }
}