import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import ExcelJS from 'exceljs'
import pg from 'pg'

type CellRange = {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
  startAddress: string
  rangeAddress: string
}

type TimeRange = { startsAtMinutes: number; endsAtMinutes: number }

type TimetableEntry = {
  dayOfWeek: number
  dayName: string
  startsAt: string
  endsAt: string
  entryKind: 'class' | 'short_break' | 'lunch_break'
  entryText: string
  sourceRange: string
}

const dayNumbers = new Map([
  ['MONDAY', 1], ['TUESDAY', 2], ['WEDNESDAY', 3],
  ['THURSDAY', 4], ['FRIDAY', 5], ['SATURDAY', 6],
])

function columnNumber(letters: string): number {
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0)
}

function parseRange(address: string): CellRange {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(address)
  if (!match) throw new Error(`Unsupported merged range: ${address}`)

  const startRow = Number(match[2])
  const endRow = Number(match[4])
  const startColumn = columnNumber(match[1])
  const endColumn = columnNumber(match[3])
  return {
    startRow,
    endRow,
    startColumn,
    endColumn,
    startAddress: `${match[1]}${startRow}`,
    rangeAddress: address,
  }
}

function readTimeRange(text: string): TimeRange | undefined {
  const match = /(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/.exec(text)
  if (!match) return undefined
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + minutes
  }
  return { startsAtMinutes: toMinutes(match[1]), endsAtMinutes: toMinutes(match[2]) }
}

function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`
}

function readMetadata(worksheet: ExcelJS.Worksheet) {
  const textAt = (address: string) => worksheet.getCell(address).text
  return {
    classification: textAt('D1'),
    title: textAt('F1'),
    class_teacher: textAt('I1'),
    classroom: textAt('I2'),
    school: textAt('F3'),
    effective_from: textAt('J3'),
    program: textAt('F4'),
    semester: textAt('F5'),
    section: textAt('H5'),
    academic_year: textAt('I5'),
    term: textAt('J5'),
  }
}

function readSchedule(worksheet: ExcelJS.Worksheet, ranges: string[]): TimetableEntry[] {
  const rangeByMaster = new Map<string, CellRange>()
  const mergedSlaves = new Set<string>()

  for (const address of ranges) {
    const range = parseRange(address)
    rangeByMaster.set(range.startAddress, range)
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        const cellAddress = worksheet.getCell(row, column).address
        if (cellAddress !== range.startAddress) mergedSlaves.add(cellAddress)
      }
    }
  }

  const times = new Map<number, { startsAt: string; endsAt: string }>()
  let dayOffsetMinutes = 0
  let previousStartMinutes = -1
  for (let column = 3; column <= 11; column += 1) {
    const time = readTimeRange(worksheet.getCell(8, column).text)
    if (!time) continue

    let startsAtMinutes = time.startsAtMinutes + dayOffsetMinutes
    if (startsAtMinutes <= previousStartMinutes) {
      dayOffsetMinutes += 12 * 60
      startsAtMinutes += 12 * 60
    }
    let endsAtMinutes = time.endsAtMinutes + dayOffsetMinutes
    if (endsAtMinutes <= startsAtMinutes) {
      dayOffsetMinutes += 12 * 60
      endsAtMinutes += 12 * 60
    }
    if (endsAtMinutes >= 24 * 60) throw new Error(`Invalid timetable period: ${worksheet.getCell(8, column).text}.`)
    times.set(column, { startsAt: formatTime(startsAtMinutes), endsAt: formatTime(endsAtMinutes) })
    previousStartMinutes = startsAtMinutes
  }

  const entries: TimetableEntry[] = []
  for (let row = 9; row <= 14; row += 1) {
    for (let column = 3; column <= 11; column += 1) {
      const address = worksheet.getCell(row, column).address
      if (mergedSlaves.has(address)) continue

      const range = rangeByMaster.get(address) ?? {
        startRow: row,
        endRow: row,
        startColumn: column,
        endColumn: column,
        startAddress: address,
        rangeAddress: address,
      }
      if (range.startColumn < 3 || range.endColumn > 11) continue

      const entryText = worksheet.getCell(range.startAddress).text
      if (!entryText.trim()) continue
      const firstTime = times.get(range.startColumn)
      const lastTime = times.get(range.endColumn)
      if (!firstTime || !lastTime) throw new Error(`Missing timetable period for ${range.rangeAddress}.`)

      const normalizedText = entryText.trim().toLowerCase()
      const entryKind = normalizedText.includes('short break')
        ? 'short_break'
        : normalizedText.includes('lunch break')
          ? 'lunch_break'
          : 'class'
      const firstDayRow = Math.max(9, range.startRow)
      const lastDayRow = Math.min(14, range.endRow)

      for (let dayRow = firstDayRow; dayRow <= lastDayRow; dayRow += 1) {
        const dayName = worksheet.getCell(dayRow, 1).text.trim().toUpperCase()
        const dayOfWeek = dayNumbers.get(dayName)
        if (!dayOfWeek) continue
        entries.push({
          dayOfWeek,
          dayName,
          startsAt: firstTime.startsAt,
          endsAt: lastTime.endsAt,
          entryKind,
          entryText,
          sourceRange: range.rangeAddress,
        })
      }
    }
  }

  if (!entries.length) throw new Error('No timetable entries were found in rows 9-14.')
  return entries
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const workbookPath = args.find((argument) => argument !== '--dry-run')
  if (!workbookPath) throw new Error('Usage: npm run db:import-timetable -- <workbook.xlsx> [--dry-run]')
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before importing the timetable.')

  const filePath = resolve(workbookPath)
  const workbookBytes = await readFile(filePath)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(workbookBytes)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw new Error('The workbook has no worksheets.')

  const mergedRanges = worksheet.model.merges ?? []
  const sheetCells: { address: string; value: string }[] = []
  for (let row = 1; row <= worksheet.rowCount; row += 1) {
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      const cell = worksheet.getCell(row, column)
      const isMergedSlave = mergedRanges.some((address) => {
        const parsed = parseRange(address)
        return cell.row >= parsed.startRow && cell.row <= parsed.endRow &&
          cell.col >= parsed.startColumn && cell.col <= parsed.endColumn &&
          cell.address !== parsed.startAddress
      })
      if (isMergedSlave) continue
      const value = cell.text
      if (value.trim()) sheetCells.push({ address: cell.address, value })
    }
  }

  const entries = readSchedule(worksheet, mergedRanges)
  const checksum = createHash('sha256').update(workbookBytes).digest('hex')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const previous = await client.query<{ import_id: number }>(
      'SELECT import_id FROM timetable_imports WHERE source_sha256 = $1',
      [checksum],
    )
    if (previous.rowCount) {
      const count = await client.query<{ entries: string }>(
        'SELECT COUNT(*)::text AS entries FROM timetable_entries WHERE import_id = $1',
        [previous.rows[0].import_id],
      )
      await client.query('ROLLBACK')
      console.log(`This workbook is already imported (${count.rows[0].entries} timetable entries).`)
      return
    }

    const imported = await client.query<{ import_id: number }>(
      `INSERT INTO timetable_imports
        (source_filename, source_sha256, sheet_name, metadata, sheet_cells, merged_ranges)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
       RETURNING import_id`,
      [basename(filePath), checksum, worksheet.name, JSON.stringify(readMetadata(worksheet)),
        JSON.stringify(sheetCells), JSON.stringify(mergedRanges)],
    )
    const importId = imported.rows[0].import_id

    for (const entry of entries) {
      await client.query(
        `INSERT INTO timetable_entries
          (import_id, day_of_week, day_name, starts_at, ends_at, entry_kind, entry_text, source_range)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [importId, entry.dayOfWeek, entry.dayName, entry.startsAt, entry.endsAt,
          entry.entryKind, entry.entryText, entry.sourceRange],
      )
    }

    if (dryRun) {
      await client.query('ROLLBACK')
      console.log(`Validated ${sheetCells.length} workbook cells and ${entries.length} timetable entries. Dry run: no records were saved.`)
    } else {
      await client.query('COMMIT')
      console.log(`Imported workbook metadata, ${sheetCells.length} source cells, and ${entries.length} timetable entries.`)
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