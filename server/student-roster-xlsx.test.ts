import assert from 'node:assert/strict'
import { test } from 'node:test'
import ExcelJS from 'exceljs'
import { parseStudentRoster, summarizeStudentRoster } from './student-roster-xlsx.ts'

async function workbookBuffer(rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Roster')
  rows.forEach((row) => worksheet.addRow(row))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

const headers = ['Sl No', 'Student Number', 'Student ID', 'Name of the Student', 'RVU Updated Email', 'Section']

test('parses a roster header below a title row and summarizes blank optional identifiers', async () => {
  const bytes = await workbookBuffer([
    ['Student Roster'],
    headers,
    [1, 'MCA001', '', 'Asha Rao', 'asha@example.edu', 'a'],
  ])
  const rows = await parseStudentRoster(bytes)

  assert.equal(rows.length, 1)
  assert.equal(rows[0].firstName, 'Asha')
  assert.equal(rows[0].lastName, 'Rao')
  assert.equal(rows[0].section, 'A')
  assert.deepEqual(summarizeStudentRoster(rows), {
    students: 1,
    blankStudentNumbers: 0,
    blankStudentIds: 1,
    blankEmails: 0,
  })
})

test('rejects duplicate student numbers in a workbook', async () => {
  const bytes = await workbookBuffer([
    headers,
    [1, 'MCA001', 'ID1', 'Asha Rao', 'asha@example.edu', 'A'],
    [2, 'MCA001', 'ID2', 'Ravi Das', 'ravi@example.edu', 'A'],
  ])

  await assert.rejects(parseStudentRoster(bytes), /duplicate student number/)
})