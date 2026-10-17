import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listCsvImportEntities, validateCsvImport } from './csv-import.ts'

test('provides templates for all supported academic entities', () => {
  const entities = listCsvImportEntities()
  assert.equal(entities.length, 18)
  for (const entity of entities) {
    const csv = `${entity.headers.join(',')}\n${entity.headers.map(() => 'value').join(',')}\n`
    assert.equal(validateCsvImport(entity.id, csv).rows.length, 1)
  }
})

test('parses quoted CSV values', () => {
  const result = validateCsvImport('departments', 'department_code,department_name\nSCI,"Science, Mathematics"\n')
  assert.equal(result.rows[0].department_name, 'Science, Mathematics')
})

test('rejects missing, unexpected, or duplicate columns', () => {
  assert.throws(() => validateCsvImport('departments', 'department_code\nSCI\n'), /headers must be/)
  assert.throws(() => validateCsvImport('departments', 'department_code,department_name,extra\nSCI,Science,value\n'), /headers must be/)
  assert.throws(() => validateCsvImport('departments', 'department_code,department_code\nSCI,Science\n'), /headers must be/)
  assert.throws(() => validateCsvImport('unknown', 'a\nb\n'), /supported academic record type/)
})

test('limits a CSV import to 5,000 rows', () => {
  const csv = `department_code,department_name\n${'D,Department\n'.repeat(5001)}`
  assert.throws(() => validateCsvImport('departments', csv), /limited to 5,000 records/)
})