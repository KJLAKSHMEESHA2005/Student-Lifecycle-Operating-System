import ExcelJS from 'exceljs'
import type pg from 'pg'

export type StudentRosterRow = {
  sourceRowNumber: number
  sourceData: {
    serial_number: string
    student_number: string | null
    student_id: string | null
    full_name: string
    email: string | null
    section: string
  }
  rollNumber: string | null
  institutionStudentId: string | null
  firstName: string
  lastName: string
  email: string | null
  section: string
}

const requiredHeaders = [
  'slno', 'studentnumber', 'studentid', 'nameofthestudent', 'rvuupdatedemail', 'section',
] as const

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function readCellText(worksheet: ExcelJS.Worksheet, row: number, column: number): string {
  const cell = worksheet.getCell(row, column)
  if (cell.isMerged && cell.master.address !== cell.address) return ''
  if (cell.value == null) return ''
  try {
    return cell.text.trim()
  } catch {
    return ''
  }
}

function findHeaderRow(worksheet: ExcelJS.Worksheet): { row: number; columns: Map<string, number> } {
  for (let row = 1; row <= Math.min(worksheet.rowCount, 40); row += 1) {
    const columns = new Map<string, number>()
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const header = normalizeHeader(readCellText(worksheet, row, column))
      if (header) columns.set(header, column)
    }
    if (requiredHeaders.every((header) => columns.has(header))) return { row, columns }
  }

  throw new Error(`Could not find the student roster headers: ${requiredHeaders.join(', ')}.`)
}

function readRoster(worksheet: ExcelJS.Worksheet): StudentRosterRow[] {
  const { row: headerRow, columns } = findHeaderRow(worksheet)
  const rows: StudentRosterRow[] = []
  const studentNumbers = new Set<string>()
  const institutionIds = new Set<string>()

  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const serialNumber = readCellText(worksheet, rowNumber, columns.get('slno')!)
    if (!serialNumber || !Number.isInteger(Number(serialNumber))) continue

    const studentNumber = readCellText(worksheet, rowNumber, columns.get('studentnumber')!)
    const institutionStudentId = readCellText(worksheet, rowNumber, columns.get('studentid')!)
    const fullName = readCellText(worksheet, rowNumber, columns.get('nameofthestudent')!)
    const sourceEmail = readCellText(worksheet, rowNumber, columns.get('rvuupdatedemail')!)
    const section = readCellText(worksheet, rowNumber, columns.get('section')!).toUpperCase()
    const nameParts = fullName.split(/\s+/).filter(Boolean)
    const firstName = nameParts.shift() ?? ''
    const lastName = nameParts.join(' ')
    const email = sourceEmail.toLowerCase() || null
    const rollNumber = studentNumber || null
    const externalId = institutionStudentId || null

    if (!fullName) throw new Error(`Worksheet row ${rowNumber}: student name is required.`)
    if (firstName.length > 80 || lastName.length > 80) {
      throw new Error(`Worksheet row ${rowNumber}: split student name exceeds the 80-character database limit.`)
    }
    if (rollNumber && rollNumber.length > 24) {
      throw new Error(`Worksheet row ${rowNumber}: student number exceeds 24 characters.`)
    }
    if (externalId && externalId.length > 40) {
      throw new Error(`Worksheet row ${rowNumber}: student ID exceeds 40 characters.`)
    }
    if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
      throw new Error(`Worksheet row ${rowNumber}: email is not valid.`)
    }
    if (!section || section.length > 16) {
      throw new Error(`Worksheet row ${rowNumber}: section is required and must not exceed 16 characters.`)
    }

    const numberKey = rollNumber?.toLowerCase()
    if (numberKey && studentNumbers.has(numberKey)) {
      throw new Error(`Worksheet row ${rowNumber}: duplicate student number in the workbook.`)
    }
    const idKey = externalId?.toLowerCase()
    if (idKey && institutionIds.has(idKey)) {
      throw new Error(`Worksheet row ${rowNumber}: duplicate student ID in the workbook.`)
    }
    if (numberKey) studentNumbers.add(numberKey)
    if (idKey) institutionIds.add(idKey)

    rows.push({
      sourceRowNumber: rowNumber,
      sourceData: {
        serial_number: serialNumber,
        student_number: rollNumber,
        student_id: externalId,
        full_name: fullName,
        email,
        section,
      },
      rollNumber,
      institutionStudentId: externalId,
      firstName,
      lastName,
      email,
      section,
    })
  }

  if (!rows.length) throw new Error('The workbook contains no student rows.')
  return rows
}

export async function parseStudentRoster(workbookBytes: Buffer): Promise<StudentRosterRow[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(workbookBytes as unknown as ArrayBuffer)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('The workbook has no worksheets.')
  return readRoster(worksheet)
}

export async function persistStudentRoster(
  client: pg.PoolClient,
  rows: StudentRosterRow[],
  sourceFilename: string,
  checksum: string,
): Promise<void> {
  const rosterImport = await client.query<{ import_id: number }>(
    `INSERT INTO student_roster_imports(source_filename, source_sha256, student_count)
     VALUES ($1, $2, $3) RETURNING import_id`,
    [sourceFilename, checksum, rows.length],
  )
  const importId = rosterImport.rows[0].import_id

  for (const row of rows) {
    const student = await client.query<{ student_id: number }>(
      `INSERT INTO students
        (program_id, roll_number, institution_student_id, academic_section,
         first_name, last_name, email, admission_date, current_semester)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, NULL, 1)
       RETURNING student_id`,
      [row.rollNumber, row.institutionStudentId, row.section,
        row.firstName, row.lastName, row.email],
    )
    await client.query(
      `INSERT INTO student_roster_import_rows(import_id, source_row_number, source_data, student_id)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [importId, row.sourceRowNumber, JSON.stringify(row.sourceData), student.rows[0].student_id],
    )
  }
}

export function summarizeStudentRoster(rows: StudentRosterRow[]) {
  return {
    students: rows.length,
    blankStudentNumbers: rows.filter((row) => !row.rollNumber).length,
    blankStudentIds: rows.filter((row) => !row.institutionStudentId).length,
    blankEmails: rows.filter((row) => !row.email).length,
  }
}