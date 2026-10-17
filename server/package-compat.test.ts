import assert from 'node:assert/strict'
import { test } from 'node:test'
import ExcelJS from 'exceljs'
import { generate, generateURI } from 'otplib'
import QRCode from 'qrcode'
import { authenticatorPeriodSeconds, createTotpSecret, verifyAuthenticatorCode } from './totp.ts'

test('ExcelJS creates and reloads XLSX with UUID-backed formatting', async () => {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('compatibility')
  worksheet.getCell('A1').value = 'ExcelJS'
  worksheet.addConditionalFormatting({
    ref: 'A1',
    rules: [{ type: 'expression', formulae: ['TRUE'], style: { font: { bold: true } } }],
  })

  const bytes = await workbook.xlsx.writeBuffer()
  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(bytes)

  assert.equal(loaded.getWorksheet('compatibility')?.getCell('A1').text, 'ExcelJS')
})

test('otplib creates a 60-second provisioning URI that QRCode renders', async () => {
  const secret = createTotpSecret()
  const uri = generateURI({
    issuer: 'Student Lifecycle OS',
    label: 'test@example.invalid',
    secret,
    period: authenticatorPeriodSeconds,
    digits: 6,
    algorithm: 'sha1',
  })
  assert.match(uri, /^otpauth:\/\/totp\//)
  assert.match(uri, /period=60/)

  const png = await QRCode.toBuffer(uri, { type: 'png', width: 240, margin: 1 })
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])

  const epoch = 120
  const token = await generate({ secret, epoch, period: authenticatorPeriodSeconds })
  const verified = await verifyAuthenticatorCode(secret, token, epoch)
  assert.equal(verified.valid, true)
})