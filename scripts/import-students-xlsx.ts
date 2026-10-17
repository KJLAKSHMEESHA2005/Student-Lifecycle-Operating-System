import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import pg from 'pg'
import { parseStudentRoster, persistStudentRoster, summarizeStudentRoster } from '../server/student-roster-xlsx.ts'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const workbookPath = args.find((argument) => argument !== '--dry-run')
  if (!workbookPath) throw new Error('Usage: npm run db:import-students-xlsx -- <workbook.xlsx> [--dry-run]')
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before importing the student roster.')

  const filePath = resolve(workbookPath)
  const workbookBytes = await readFile(filePath)
  const rows = await parseStudentRoster(workbookBytes)
  const summary = summarizeStudentRoster(rows)
  const checksum = createHash('sha256').update(workbookBytes).digest('hex')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const existing = await client.query<{ import_id: number; student_count: number }>(
      'SELECT import_id, student_count FROM student_roster_imports WHERE source_sha256 = $1',
      [checksum],
    )
    if (existing.rowCount) {
      await client.query('ROLLBACK')
      console.log(`This workbook is already imported (${existing.rows[0].student_count} student records).`)
      return
    }

    await persistStudentRoster(client, rows, basename(filePath), checksum)

    if (dryRun) {
      await client.query('ROLLBACK')
      console.log(`Validated ${summary.students} students. Blank student numbers: ${summary.blankStudentNumbers}; blank student IDs: ${summary.blankStudentIds}; blank emails: ${summary.blankEmails}. Dry run: no records were saved.`)
    } else {
      await client.query('COMMIT')
      console.log(`Imported ${rows.length} students from ${basename(filePath)}.`)
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