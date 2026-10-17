import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'csv-parse/sync'
import pg from 'pg'

type StudentRow = {
  roll_number: string
  first_name: string
  last_name: string
  email: string
  admission_date: string
  current_semester: string
  program_code: string
}

const columns = [
  'roll_number', 'first_name', 'last_name', 'email',
  'admission_date', 'current_semester', 'program_code',
] as const
const columnSet: ReadonlySet<string> = new Set(columns)
const optionalColumns: ReadonlySet<string> = new Set(['roll_number', 'email', 'admission_date', 'program_code'])
const maximumLengths: Partial<Record<keyof StudentRow, number>> = {
  roll_number: 24,
  first_name: 80,
  last_name: 80,
  email: 254,
  program_code: 16,
}

function readRoster(csvText: string): StudentRow[] {
  const [header = []] = parse(csvText, { bom: true, to_line: 1, skip_empty_lines: true }) as string[][]
  const missing = columns.filter((column) => !header.includes(column))
  const unexpected = header.filter((column) => !columnSet.has(column))
  if (missing.length || unexpected.length) {
    throw new Error(`CSV headers must be exactly: ${columns.join(', ')}. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`)
  }

  const rows = parse(csvText, { bom: true, columns: true, skip_empty_lines: true, trim: true }) as StudentRow[]
  if (!rows.length) throw new Error('The CSV has a header but no student rows.')

  const rollNumbers = new Set<string>()
  const emails = new Set<string>()

  return rows.map((row, index) => {
    const rowNumber = index + 2
    const normalized: StudentRow = {
      roll_number: row.roll_number.trim(),
      first_name: row.first_name.trim(),
      last_name: row.last_name.trim(),
      email: row.email.trim().toLowerCase(),
      admission_date: row.admission_date.trim(),
      current_semester: row.current_semester.trim(),
      program_code: row.program_code.trim(),
    }

    for (const column of columns) {
      if (!normalized[column] && !optionalColumns.has(column)) throw new Error(`CSV row ${rowNumber}: ${column} is required.`)
      const maxLength = maximumLengths[column]
      if (maxLength && normalized[column].length > maxLength) {
        throw new Error(`CSV row ${rowNumber}: ${column} exceeds ${maxLength} characters.`)
      }
    }

    if (normalized.email && !/^[^@\s]+@[^@\s]+$/.test(normalized.email)) {
      throw new Error(`CSV row ${rowNumber}: email is not valid.`)
    }
    if (normalized.admission_date) {
      const admissionDate = new Date(`${normalized.admission_date}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.admission_date) ||
        Number.isNaN(admissionDate.getTime()) ||
        admissionDate.toISOString().slice(0, 10) !== normalized.admission_date) {
        throw new Error(`CSV row ${rowNumber}: admission_date must be a real date in YYYY-MM-DD format.`)
      }
    }
    if (!/^\d+$/.test(normalized.current_semester) || Number(normalized.current_semester) < 1 || Number(normalized.current_semester) > 32767) {
      throw new Error(`CSV row ${rowNumber}: current_semester must be a positive whole number.`)
    }

    const rollKey = normalized.roll_number.toLowerCase()
    if (rollKey && rollNumbers.has(rollKey)) throw new Error(`CSV row ${rowNumber}: duplicate roll_number in the file.`)
    if (normalized.email && emails.has(normalized.email)) throw new Error(`CSV row ${rowNumber}: duplicate email in the file.`)
    if (rollKey) rollNumbers.add(rollKey)
    if (normalized.email) emails.add(normalized.email)
    return normalized
  })
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const csvPath = args.find((argument) => argument !== '--dry-run')
  if (!csvPath) throw new Error('Usage: npm run db:import-students -- <students.csv> [--dry-run]')

  const rows = readRoster(await readFile(resolve(csvPath), 'utf8'))
  const programCodes = [...new Set(rows.map((row) => row.program_code).filter(Boolean))]
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const programs = await client.query<{ program_id: number; program_code: string }>(
      'SELECT program_id, program_code FROM programs WHERE program_code = ANY($1::text[])',
      [programCodes],
    )
    const programIds = new Map(programs.rows.map((program) => [program.program_code, program.program_id]))
    const missingPrograms = programCodes.filter((programCode) => !programIds.has(programCode))
    if (missingPrograms.length) {
      throw new Error(`Create these program records before importing: ${missingPrograms.join(', ')}.`)
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO students
          (program_id, roll_number, first_name, last_name, email, admission_date, current_semester)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.program_code ? programIds.get(row.program_code) ?? null : null,
          row.roll_number || null, row.first_name, row.last_name, row.email || null,
          row.admission_date || null, Number(row.current_semester)],
      )
    }

    if (dryRun) {
      await client.query('ROLLBACK')
      console.log(`Validated ${rows.length} student rows. Dry run: no records were saved.`)
    } else {
      await client.query('COMMIT')
      console.log(`Imported ${rows.length} student records.`)
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})