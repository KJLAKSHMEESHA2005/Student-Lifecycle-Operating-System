import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { generateURI } from 'otplib'
import QRCode from 'qrcode'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { basename, resolve } from 'node:path'
import pg from 'pg'
import type { NextFunction, Request, Response } from 'express'
import { createTotpSecret, decryptTotpSecret, encryptTotpSecret, verifyAuthenticatorCode, authenticatorPeriodSeconds } from './totp.ts'
import { importAcademicCsv, listCsvImportEntities } from './csv-import.ts'
import { parseStudentRoster, persistStudentRoster, summarizeStudentRoster } from './student-roster-xlsx.ts'
import { askGemini, validateGeminiMessages } from './gemini.ts'

const { Pool } = pg
const app = express()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
app.use(cors())
app.use(express.json())

const sessionCookie = 'student_lifecycle_session'
const studentSessionCookie = 'student_lms_session'
const sessionLifetimeSeconds = 60 * 60 * 12

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readSessionToken(request: Request, cookieName = sessionCookie): string | null {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length) || null
  }
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
  return cookie?.slice(cookieName.length + 1) || null
}

function writeSessionCookie(response: Response, token: string, maxAge: number) {
  const attributes = [`${sessionCookie}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`]
  if (process.env.NODE_ENV === 'production') attributes.push('Secure')
  response.setHeader('Set-Cookie', attributes.join('; '))
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key))
  })
}

async function makePasswordHash(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derivePassword(password, salt)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(':')
  if (!saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await derivePassword(password, Buffer.from(saltHex, 'hex'))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function createSession(staffId: number, response: Response, client: pg.Pool | pg.PoolClient = pool) {
  const token = randomBytes(32).toString('hex')
  await client.query(
    "INSERT INTO staff_sessions(token_hash, staff_id, expires_at) VALUES($1, $2, now() + interval '12 hours')",
    [hashToken(token), staffId],
  )
  writeSessionCookie(response, token, sessionLifetimeSeconds)
  return token
}

async function createStudentSession(studentId: number, response: Response, client: pg.Pool | pg.PoolClient = pool) {
  const token = randomBytes(32).toString('hex')
  await client.query(
    "INSERT INTO student_sessions(token_hash, student_id, expires_at) VALUES($1, $2, now() + interval '12 hours')",
    [hashToken(token), studentId],
  )
  response.setHeader('Set-Cookie', [
    `${studentSessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeSeconds}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  ])
  return token
}

const studentLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Try again in 15 minutes.' },
})
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many sign-in attempts. Try again in 15 minutes.' },
})
const geminiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Assistant request limit reached. Try again in 15 minutes.' },
})

async function requireStaff(request: Request, response: Response, next: NextFunction) {
  const token = readSessionToken(request)
  if (!token) {
    response.status(401).json({ message: 'Sign in to continue.' })
    return
  }

  try {
    const result = await pool.query<{ staff_id: number; full_name: string; email: string; role: 'admin' | 'staff' }>(
      'SELECT account.staff_id, account.full_name, account.email, account.role FROM staff_sessions session JOIN staff_accounts account USING(staff_id) WHERE session.token_hash=$1 AND session.expires_at > now()',
      [hashToken(token)],
    )
    if (!result.rows[0]) {
      response.status(401).json({ message: 'Your session has expired. Sign in again.' })
      return
    }
    response.locals.staff = result.rows[0]
    next()
  } catch {
    response.status(503).json({ message: 'The academic database is unavailable.' })
  }
}

function requireAdmin(_request: Request, response: Response, next: NextFunction) {
  if (response.locals.staff?.role !== 'admin') {
    response.status(403).json({ message: 'Administrator access is required.' })
    return
  }
  next()
}

async function requireStudent(request: Request, response: Response, next: NextFunction) {
  const token = readSessionToken(request, studentSessionCookie)
  if (!token) {
    response.status(401).json({ message: 'Sign in with your student account to continue.' })
    return
  }
  try {
    const result = await pool.query<{ student_id: number; institution_student_id: string; full_name: string }>(
      `SELECT student.student_id, student.institution_student_id,
              student.first_name || ' ' || student.last_name AS full_name
       FROM student_sessions session
       JOIN student_accounts account USING(student_id)
       JOIN students student USING(student_id)
       WHERE session.token_hash=$1 AND session.expires_at > now() AND student.status='active'`,
      [hashToken(token)],
    )
    if (!result.rows[0]) {
      response.status(401).json({ message: 'Your student session has expired. Sign in again.' })
      return
    }
    response.locals.student = result.rows[0]
    next()
  } catch {
    response.status(503).json({ message: 'The academic database is unavailable.' })
  }
}

async function requireAssistantUser(request: Request, response: Response, next: NextFunction) {
  const studentToken = readSessionToken(request, studentSessionCookie)
  const staffToken = readSessionToken(request)
  try {
    if (studentToken) {
      const student = await pool.query(
        `SELECT student.student_id, student.roll_number,
                student.first_name || ' ' || student.last_name AS full_name
         FROM student_sessions session
         JOIN student_accounts account USING(student_id)
         JOIN students student USING(student_id)
         WHERE session.token_hash=$1 AND session.expires_at > now() AND student.status='active'`,
        [hashToken(studentToken)],
      )
      if (student.rows[0]) {
        response.locals.assistantUser = { type: 'student', ...student.rows[0] }
        next()
        return
      }
    }
    if (staffToken) {
      const staff = await pool.query(
        `SELECT account.staff_id, account.full_name, account.email, account.role
         FROM staff_sessions session JOIN staff_accounts account USING(staff_id)
         WHERE session.token_hash=$1 AND session.expires_at > now()`,
        [hashToken(staffToken)],
      )
      if (staff.rows[0]) {
        response.locals.assistantUser = { type: 'staff', ...staff.rows[0] }
        next()
        return
      }
    }
    response.status(401).json({ message: 'Sign in to use the academic assistant.' })
  } catch {
    response.status(503).json({ message: 'The academic database is unavailable.' })
  }
}

app.get('/api/auth/status', async (_request, response) => {
  try {
    const result = await pool.query('SELECT NOT EXISTS (SELECT 1 FROM staff_accounts) AS registration_open')
    response.json(result.rows[0])
  } catch {
    response.status(503).json({ message: 'The academic database is unavailable.' })
  }
})

app.get('/api/auth/session', requireStaff, (_request, response) => {
  response.json({ user: response.locals.staff })
})

app.get('/api/admin/csv-imports/entities', requireStaff, requireAdmin, (_request, response) => {
  response.json({ entities: listCsvImportEntities() })
})

app.post('/api/admin/csv-imports/:entity', requireStaff, requireAdmin,
  express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }), async (request, response) => {
    if (typeof request.body !== 'string' || !request.body.trim()) {
      response.status(400).json({ message: 'Choose a non-empty CSV file.' })
      return
    }

    const client = await pool.connect().catch(() => null)
    if (!client) {
      response.status(503).json({ message: 'The academic database is unavailable.' })
      return
    }

    try {
      await client.query('BEGIN')
      const entity = Array.isArray(request.params.entity) ? request.params.entity[0] : request.params.entity
      if (!entity) throw new Error('Choose a supported academic record type.')
      const result = await importAcademicCsv(client, entity, request.body)
      await client.query('COMMIT')
      response.json({ ...result, message: `Imported ${result.imported} ${result.label.toLowerCase()}.` })
    } catch (error) {
      await client.query('ROLLBACK')
      const code = (error as { code?: string }).code
      if (code === '23505') {
        response.status(409).json({ message: 'A record already exists or the CSV contains duplicates. No rows were imported.' })
      } else if (code === '23503') {
        response.status(400).json({ message: 'A referenced record was not found. Import related records first. No rows were imported.' })
      } else if (code === '22P02' || code === '22007' || code === '23514' || code === '23502') {
        response.status(400).json({ message: error instanceof Error ? `${error.message} No rows were imported.` : 'CSV values do not match the selected record type. No rows were imported.' })
      } else if (error instanceof Error && !(error instanceof pg.DatabaseError)) {
        response.status(400).json({ message: error.message })
      } else {
        console.error('CSV import failed:', error)
        response.status(503).json({ message: 'CSV import failed. No rows were imported.' })
      }
    } finally {
      client.release()
    }
  })

app.post('/api/admin/student-roster/import', requireStaff, requireAdmin,
  express.raw({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', limit: '15mb' }), async (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ message: 'Choose a non-empty Excel workbook (.xlsx).'} )
      return
    }

    const workbookBytes = request.body
    const sourceFilename = basename(request.header('x-file-name') || 'student-roster.xlsx')
    const checksum = createHash('sha256').update(workbookBytes).digest('hex')
    const dryRun = request.query.dryRun === 'true'
    const client = await pool.connect().catch(() => null)
    if (!client) {
      response.status(503).json({ message: 'The academic database is unavailable.' })
      return
    }

    let transactionOpen = false
    try {
      const rows = await parseStudentRoster(workbookBytes)
      const summary = summarizeStudentRoster(rows)
      await client.query('BEGIN')
      transactionOpen = true
      const existing = await client.query<{ import_id: number; student_count: number }>(
        'SELECT import_id, student_count FROM student_roster_imports WHERE source_sha256=$1',
        [checksum],
      )
      if (existing.rowCount) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.json({ ...summary, already_imported: true, imported: existing.rows[0].student_count })
        return
      }

      await persistStudentRoster(client, rows, sourceFilename, checksum)
      if (dryRun) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.json({ ...summary, validated: true })
      } else {
        await client.query('COMMIT')
        transactionOpen = false
        response.status(201).json({ ...summary, imported: rows.length })
      }
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK')
      const code = (error as { code?: string }).code
      if (code === '23505') {
        response.status(409).json({ message: 'A student number or student ID already exists. No rows were imported.' })
      } else if (error instanceof Error && !(error instanceof pg.DatabaseError)) {
        response.status(400).json({ message: error.message })
      } else {
        console.error('Student roster import failed:', error)
        response.status(503).json({ message: 'Student roster import failed. No rows were imported.' })
      }
    } finally {
      client.release()
    }
  })

app.post('/api/auth/register', async (request, response) => {
  const fullName = text(request.body?.full_name)
  const email = text(request.body?.email).toLowerCase()
  const password = text(request.body?.password)
  const signupCode = text(request.body?.signup_code)
  const configuredSignupCode = process.env.ADMIN_BOOTSTRAP_CODE ?? process.env.STAFF_SIGNUP_CODE ?? ''
  const suppliedCode = Buffer.from(signupCode)
  const expectedCode = Buffer.from(configuredSignupCode)
  if (!configuredSignupCode || suppliedCode.length !== expectedCode.length || !timingSafeEqual(suppliedCode, expectedCode)) {
    response.status(403).json({ message: 'Enter the administrator bootstrap code configured by the database owner.' })
    return
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    response.status(400).json({ message: 'Enter a valid email address.' })
    return
  }
  if (!fullName || fullName.length > 120) {
    response.status(400).json({ message: 'Enter a staff name up to 120 characters.' })
    return
  }
  if (password.length < 12 || password.length > 128) {
    response.status(400).json({ message: 'Password must be between 12 and 128 characters.' })
    return
  }

  const client = await pool.connect().catch(() => null)
  if (!client) {
    response.status(503).json({ message: 'The academic database is unavailable.' })
    return
  }
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(731942, 1)')
    const existing = await client.query('SELECT 1 FROM staff_accounts LIMIT 1')
    if (existing.rowCount) {
      await client.query('ROLLBACK')
      response.status(409).json({ message: 'Staff registration is closed. Sign in with your staff account.' })
      return
    }
    const passwordHash = await makePasswordHash(password)
    const account = await client.query<{ staff_id: number; full_name: string; email: string; role: string }>(
      "INSERT INTO staff_accounts(full_name, email, password_hash, role) VALUES($1, $2, $3, 'admin') RETURNING staff_id, full_name, email, role",
      [fullName, email, passwordHash],
    )
    await client.query('COMMIT')
    response.status(201).json({ account_created: true, role: account.rows[0].role })
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') {
      response.status(409).json({ message: 'A staff account with that email already exists.' })
    } else {
      console.error('Staff registration failed:', error)
      response.status(503).json({ message: 'Could not create the staff account.' })
    }
  } finally {
    client.release()
  }
})

app.post('/api/auth/login', staffLoginLimiter, async (request, response) => {
  const email = text(request.body?.email).toLowerCase()
  const password = text(request.body?.password)
  const code = text(request.body?.authenticator_code)
  if (!email || !password || password.length > 128 || (code && !/^\d{6}$/.test(code))) {
    response.status(400).json({ message: 'Enter your email, password, and a six-digit authenticator code.' })
    return
  }
  const client = await pool.connect().catch(() => null)
  if (!client) {
    response.status(503).json({ message: 'The academic database is unavailable.' })
    return
  }
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const result = await client.query<{
      staff_id: number
      full_name: string
      email: string
      role: 'admin' | 'staff'
      password_hash: string
      totp_secret_encrypted: string | null
      totp_pending_secret_encrypted: string | null
      totp_last_time_step: number | string | null
    }>(
      `SELECT staff_id, full_name, email, role, password_hash,
              totp_secret_encrypted, totp_pending_secret_encrypted, totp_last_time_step
      FROM staff_accounts WHERE email=$1 AND role='admin' FOR UPDATE`, [email],
    )
    const account = result.rows[0]
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      await client.query('ROLLBACK')
      transactionOpen = false
      response.status(401).json({ message: 'Email or password is incorrect.' })
      return
    }
    const keyHex = process.env.TOTP_ENCRYPTION_KEY ?? ''
    const epoch = Math.floor(Date.now() / 1000)
    let verifiedStep: number

    if (!account.totp_secret_encrypted) {
      let pendingEncrypted = account.totp_pending_secret_encrypted
      if (!pendingEncrypted) {
        pendingEncrypted = encryptTotpSecret(createTotpSecret(), keyHex)
        await client.query('UPDATE staff_accounts SET totp_pending_secret_encrypted=$1 WHERE staff_id=$2', [pendingEncrypted, account.staff_id])
      }
      const secret = decryptTotpSecret(pendingEncrypted, keyHex)
      if (!code) {
        const provisioningUri = generateURI({
          issuer: 'Student Lifecycle OS',
          label: account.email,
          secret,
          period: authenticatorPeriodSeconds,
          digits: 6,
          algorithm: 'sha1',
        })
        const qrCode = await QRCode.toDataURL(provisioningUri, { width: 240, margin: 1 })
        await client.query('COMMIT')
        transactionOpen = false
        response.json({ authenticator_setup_required: true, qr_code: qrCode, period_seconds: authenticatorPeriodSeconds })
        return
      }
      const verification = await verifyAuthenticatorCode(secret, code, epoch)
      if (!verification.valid) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(401).json({ message: 'Authenticator code is incorrect or expired.' })
        return
      }
      verifiedStep = Math.floor(epoch / authenticatorPeriodSeconds)
      await client.query(
        `UPDATE staff_accounts SET totp_secret_encrypted=$1,
         totp_pending_secret_encrypted=NULL, totp_last_time_step=$2 WHERE staff_id=$3`,
        [pendingEncrypted, verifiedStep, account.staff_id],
      )
    } else {
      if (!code) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(400).json({ message: 'Enter the six-digit code from your authenticator app.' })
        return
      }
      const secret = decryptTotpSecret(account.totp_secret_encrypted, keyHex)
      const lastTimeStep = account.totp_last_time_step === null ? undefined : Number(account.totp_last_time_step)
      const verification = await verifyAuthenticatorCode(secret, code, epoch, lastTimeStep)
      if (!verification.valid) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(401).json({ message: 'Authenticator code is incorrect, expired, or already used.' })
        return
      }
      verifiedStep = Math.floor(epoch / authenticatorPeriodSeconds)
      await client.query('UPDATE staff_accounts SET totp_last_time_step=$1 WHERE staff_id=$2', [verifiedStep, account.staff_id])
    }

    const sessionToken = await createSession(account.staff_id, response, client)
    await client.query('COMMIT')
    transactionOpen = false
    const user = { staff_id: account.staff_id, full_name: account.full_name, email: account.email, role: account.role }
    response.json({ user, session_token: request.body?.client === 'native' ? sessionToken : undefined })
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    console.error('Staff authentication failed:', error)
    response.status(503).json({ message: 'The academic database is unavailable.' })
  } finally {
    client.release()
  }
})

app.post('/api/auth/logout', async (request, response) => {
  const token = readSessionToken(request)
  if (token) {
    try {
      await pool.query('DELETE FROM staff_sessions WHERE token_hash=$1', [hashToken(token)])
    } catch {
      response.status(503).json({ message: 'Could not close the database session.' })
      return
    }
  }
  writeSessionCookie(response, '', 0)
  response.status(204).end()
})

app.post('/api/student/auth/login', studentLoginLimiter, async (request, response) => {
  const usn = text(request.body?.usn).toUpperCase()
  const password = text(request.body?.password)
  const code = text(request.body?.authenticator_code)
  if (!usn || usn.length > 40 || !password || password.length > 128 || (code && !/^\d{6}$/.test(code))) {
    response.status(400).json({ message: 'Enter your USN, password, and a six-digit authenticator code.' })
    return
  }
  const client = await pool.connect().catch(() => null)
  if (!client) {
    response.status(503).json({ message: 'The academic database is unavailable.' })
    return
  }
  let transactionOpen = false
  try {
    await client.query('BEGIN')
    transactionOpen = true
    const result = await client.query<{
      student_id: number
      roll_number: string
      institution_student_id: string
      full_name: string
      password_hash: string
      totp_secret_encrypted: string | null
      totp_pending_secret_encrypted: string | null
      totp_last_time_step: number | string | null
    }>(
      `SELECT student.student_id, student.roll_number, student.institution_student_id,
              student.first_name || ' ' || student.last_name AS full_name, account.password_hash,
              account.totp_secret_encrypted, account.totp_pending_secret_encrypted, account.totp_last_time_step
       FROM students student JOIN student_accounts account USING(student_id)
      WHERE student.institution_student_id=$1 AND student.status='active'
       FOR UPDATE OF account`,
          [usn],
    )
    const account = result.rows[0]
    if (!account || !(await verifyPassword(password, account.password_hash))) {
      await client.query('ROLLBACK')
      transactionOpen = false
      response.status(401).json({ message: 'USN or password is incorrect.' })
      return
    }
    const keyHex = process.env.TOTP_ENCRYPTION_KEY ?? ''
    const epoch = Math.floor(Date.now() / 1000)
    let verifiedStep: number

    if (!account.totp_secret_encrypted) {
      let pendingEncrypted = account.totp_pending_secret_encrypted
      if (!pendingEncrypted) {
        pendingEncrypted = encryptTotpSecret(createTotpSecret(), keyHex)
        await client.query('UPDATE student_accounts SET totp_pending_secret_encrypted=$1 WHERE student_id=$2', [pendingEncrypted, account.student_id])
      }
      const secret = decryptTotpSecret(pendingEncrypted, keyHex)
      if (!code) {
        const provisioningUri = generateURI({
          issuer: 'Student Lifecycle OS',
          label: account.institution_student_id,
          secret,
          period: authenticatorPeriodSeconds,
          digits: 6,
          algorithm: 'sha1',
        })
        const qrCode = await QRCode.toDataURL(provisioningUri, { width: 240, margin: 1 })
        await client.query('COMMIT')
        transactionOpen = false
        response.json({ authenticator_setup_required: true, qr_code: qrCode, period_seconds: authenticatorPeriodSeconds })
        return
      }
      const verification = await verifyAuthenticatorCode(secret, code, epoch)
      if (!verification.valid) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(401).json({ message: 'Authenticator code is incorrect or expired.' })
        return
      }
      verifiedStep = Math.floor(epoch / authenticatorPeriodSeconds)
      await client.query(
        `UPDATE student_accounts SET totp_secret_encrypted=$1,
         totp_pending_secret_encrypted=NULL, totp_last_time_step=$2 WHERE student_id=$3`,
        [pendingEncrypted, verifiedStep, account.student_id],
      )
    } else {
      if (!code) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(400).json({ message: 'Enter the six-digit code from your authenticator app.' })
        return
      }
      const secret = decryptTotpSecret(account.totp_secret_encrypted, keyHex)
      const lastTimeStep = account.totp_last_time_step === null ? undefined : Number(account.totp_last_time_step)
      const verification = await verifyAuthenticatorCode(secret, code, epoch, lastTimeStep)
      if (!verification.valid) {
        await client.query('ROLLBACK')
        transactionOpen = false
        response.status(401).json({ message: 'Authenticator code is incorrect, expired, or already used.' })
        return
      }
      verifiedStep = Math.floor(epoch / authenticatorPeriodSeconds)
      await client.query('UPDATE student_accounts SET totp_last_time_step=$1 WHERE student_id=$2', [verifiedStep, account.student_id])
    }

    const sessionToken = await createStudentSession(account.student_id, response, client)
    await client.query('COMMIT')
    transactionOpen = false
    const user = { student_id: account.student_id, institution_student_id: account.institution_student_id, full_name: account.full_name }
    response.json({ user, session_token: request.body?.client === 'native' ? sessionToken : undefined })
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK')
    console.error('Student authentication failed:', error)
    response.status(503).json({ message: 'The academic database is unavailable.' })
  } finally {
    client.release()
  }
})

app.get('/api/student/auth/session', requireStudent, (_request, response) => {
  response.json({ user: response.locals.student })
})

app.post('/api/student/auth/logout', async (request, response) => {
  const token = readSessionToken(request, studentSessionCookie)
  if (token) {
    try {
      await pool.query('DELETE FROM student_sessions WHERE token_hash=$1', [hashToken(token)])
    } catch {
      response.status(503).json({ message: 'Could not close the student session.' })
      return
    }
  }
  response.setHeader('Set-Cookie', `${studentSessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`)
  response.status(204).end()
})

app.get('/api/students', requireStaff, async (_request, response) => {
  try {
    const result = await pool.query(
      `SELECT student.student_id, student.roll_number, student.institution_student_id,
              student.first_name, student.last_name,
              student.email, student.admission_date, student.current_semester, student.program_id,
          program.program_code,
              EXISTS(SELECT 1 FROM student_accounts account WHERE account.student_id=student.student_id) AS has_account
        FROM students student LEFT JOIN programs program USING(program_id)
        ORDER BY student.student_id DESC LIMIT 100`,
    )
    response.json({ students: result.rows })
  } catch {
    response.status(503).json({ message: 'Could not load student records.' })
  }
})

app.post('/api/students', requireStaff, async (request, response) => {
  const rollNumber = text(request.body?.roll_number)
  const institutionStudentId = text(request.body?.institution_student_id)
  const firstName = text(request.body?.first_name)
  const lastName = text(request.body?.last_name)
  const email = text(request.body?.email).toLowerCase() || null
  const admissionDate = text(request.body?.admission_date) || null
  const semesterValue = text(request.body?.current_semester)
  const programCode = text(request.body?.program_code) || null
  const accountPassword = text(request.body?.account_password)

  if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
    response.status(400).json({ message: 'First and last names are required and must be at most 80 characters.' })
    return
  }
  if (!rollNumber) {
    response.status(400).json({ message: 'Application number is required.' })
    return
  }
  if (rollNumber.length > 24) {
    response.status(400).json({ message: 'Application number must be at most 24 characters.' })
    return
  }
  if (!institutionStudentId || institutionStudentId.length > 40) {
    response.status(400).json({ message: 'A USN is required and must be at most 40 characters.' })
    return
  }
  if (accountPassword && (!rollNumber || accountPassword.length < 12 || accountPassword.length > 128)) {
    response.status(400).json({ message: 'A student login needs a student ID and a password between 12 and 128 characters.' })
    return
  }
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    response.status(400).json({ message: 'Enter a valid email address.' })
    return
  }
  if (admissionDate) {
    const parsedDate = new Date(`${admissionDate}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(admissionDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== admissionDate) {
      response.status(400).json({ message: 'Admission date must be a real date in YYYY-MM-DD format.' })
      return
    }
  }
  const semester = Number(semesterValue)
  if (!/^\d+$/.test(semesterValue) || !Number.isInteger(semester) || semester < 1 || semester > 32767) {
    response.status(400).json({ message: 'Semester must be a positive whole number.' })
    return
  }

  const client = await pool.connect().catch(() => null)
  if (!client) {
    response.status(503).json({ message: 'Could not save the student record.' })
    return
  }
  try {
    await client.query('BEGIN')
    let programId: number | null = null
    if (programCode) {
      const program = await client.query<{ program_id: number }>(
        'SELECT program_id FROM programs WHERE program_code=$1', [programCode],
      )
      if (!program.rows[0]) {
        await client.query('ROLLBACK')
        response.status(400).json({ message: 'That program code is not in the database. Leave it blank or choose an existing code.' })
        return
      }
      programId = program.rows[0].program_id
    }
    const passwordHash = accountPassword ? await makePasswordHash(accountPassword) : null
    const result = await client.query(
      `INSERT INTO students(program_id, roll_number, institution_student_id,
                first_name, last_name, email, admission_date, current_semester)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING student_id, roll_number, institution_student_id, first_name,
             last_name, email, admission_date, current_semester, program_id`,
      [programId, rollNumber, institutionStudentId, firstName, lastName, email, admissionDate, semester],
    )
    if (passwordHash) {
      await client.query('INSERT INTO student_accounts(student_id, password_hash) VALUES($1, $2)', [result.rows[0].student_id, passwordHash])
    }
    await client.query('COMMIT')
    response.status(201).json({ student: result.rows[0], account_created: Boolean(passwordHash) })
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') {
      response.status(409).json({ message: 'That student number is already assigned to another student.' })
      return
    }
    console.error('Student creation failed:', error)
    response.status(503).json({ message: 'Could not save the student record.' })
  } finally {
    client.release()
  }
})

app.put('/api/students/:studentId', requireStaff, async (request, response) => {
  const studentId = Number(request.params.studentId)
  const rollNumber = text(request.body?.roll_number)
  const institutionStudentId = text(request.body?.institution_student_id)
  const firstName = text(request.body?.first_name)
  const lastName = text(request.body?.last_name)
  const email = text(request.body?.email).toLowerCase() || null
  const admissionDate = text(request.body?.admission_date) || null
  const semesterValue = text(request.body?.current_semester)
  const programCode = text(request.body?.program_code) || null

  if (!Number.isInteger(studentId) || studentId < 1) {
    response.status(400).json({ message: 'Choose a valid student record.' })
    return
  }
  if (!rollNumber || rollNumber.length > 24) {
    response.status(400).json({ message: 'Application number is required and must be at most 24 characters.' })
    return
  }
  if (!institutionStudentId || institutionStudentId.length > 40) {
    response.status(400).json({ message: 'USN is required and must be at most 40 characters.' })
    return
  }
  if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
    response.status(400).json({ message: 'First and last names are required and must be at most 80 characters.' })
    return
  }
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) {
    response.status(400).json({ message: 'Enter a valid email address.' })
    return
  }
  if (admissionDate) {
    const parsedDate = new Date(`${admissionDate}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(admissionDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== admissionDate) {
      response.status(400).json({ message: 'Admission date must be a real date in YYYY-MM-DD format.' })
      return
    }
  }
  const semester = Number(semesterValue)
  if (!/^\d+$/.test(semesterValue) || !Number.isInteger(semester) || semester < 1 || semester > 32767) {
    response.status(400).json({ message: 'Semester must be a positive whole number.' })
    return
  }
  if (programCode && programCode.length > 16) {
    response.status(400).json({ message: 'Program code must be at most 16 characters.' })
    return
  }

  const client = await pool.connect().catch(() => null)
  if (!client) {
    response.status(503).json({ message: 'Could not update the student record.' })
    return
  }
  try {
    await client.query('BEGIN')
    let programId: number | null = null
    if (programCode) {
      const program = await client.query<{ program_id: number }>(
        'SELECT program_id FROM programs WHERE program_code=$1', [programCode],
      )
      if (!program.rows[0]) {
        await client.query('ROLLBACK')
        response.status(400).json({ message: 'That program code is not in the database.' })
        return
      }
      programId = program.rows[0].program_id
    }
    const result = await client.query(
      `UPDATE students
       SET program_id=$1, roll_number=$2, institution_student_id=$3,
           first_name=$4, last_name=$5, email=$6, admission_date=$7,
           current_semester=$8
       WHERE student_id=$9
       RETURNING student_id, roll_number, institution_student_id, first_name,
                 last_name, email, admission_date, current_semester, program_id`,
      [programId, rollNumber, institutionStudentId, firstName, lastName, email, admissionDate, semester, studentId],
    )
    if (!result.rowCount) {
      await client.query('ROLLBACK')
      response.status(404).json({ message: 'Student record not found.' })
      return
    }
    await client.query('COMMIT')
    response.json({ student: result.rows[0] })
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '23505') {
      response.status(409).json({ message: 'That application number or USN is already assigned to another student.' })
      return
    }
    console.error('Student update failed:', error)
    response.status(503).json({ message: 'Could not update the student record.' })
  } finally {
    client.release()
  }
})

app.put('/api/students/:studentId/account', requireStaff, async (request, response) => {
  const studentId = Number(request.params.studentId)
  const password = text(request.body?.password)
  if (!Number.isInteger(studentId) || studentId < 1 || password.length < 12 || password.length > 128) {
    response.status(400).json({ message: 'Enter a valid student and a password between 12 and 128 characters.' })
    return
  }
  try {
    const student = await pool.query<{ institution_student_id: string | null }>('SELECT institution_student_id FROM students WHERE student_id=$1', [studentId])
    if (!student.rows[0]) {
      response.status(404).json({ message: 'Student record not found.' })
      return
    }
    if (!student.rows[0].institution_student_id) {
      response.status(400).json({ message: 'Add the student USN before creating a student login.' })
      return
    }
    const passwordHash = await makePasswordHash(password)
    await pool.query(
      `INSERT INTO student_accounts(student_id, password_hash) VALUES($1, $2)
       ON CONFLICT(student_id) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
      [studentId, passwordHash],
    )
    response.json({ account_created: true })
  } catch {
    response.status(503).json({ message: 'Could not provision the student account.' })
  }
})

app.get('/api/health', async (_request, response) => {
  try {
    const result = await pool.query('SELECT current_database() AS database, now() AS checked_at')
    response.json({ status: 'connected', ...result.rows[0] })
  } catch {
    response.status(503).json({ status: 'disconnected', message: 'PostgreSQL is not available.' })
  }
})

app.post('/api/assistant/chat', geminiRateLimiter, requireAssistantUser, async (request, response) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) {
    response.status(503).json({ message: 'Gemini is not configured. Add GEMINI_API_KEY to .env and restart the API.' })
    return
  }
  let messages
  try {
    messages = validateGeminiMessages(request.body?.messages)
  } catch (error) {
    response.status(400).json({ message: error instanceof Error ? error.message : 'Invalid conversation.' })
    return
  }
  try {
    const answer = await askGemini(messages, {
      apiKey,
      model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    })
    response.json({ answer })
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Gemini took too long to respond. Try again.'
      : error instanceof Error ? error.message : 'Gemini could not complete the request.'
    response.status(502).json({ message })
  }
})

async function sendDashboard(usn: string, response: Response) {
  if (!usn) {
    response.status(400).json({ message: 'A student USN is required.' })
    return
  }

  try {
    const studentResult = await pool.query(
            `SELECT summary.student_id, summary.roll_number, student.institution_student_id,
              summary.first_name, summary.last_name,
              summary.program_name, summary.current_semester,
              (SELECT term.term_name
               FROM enrollments enrollment
               JOIN course_sections section USING(section_id)
               JOIN academic_terms term USING(term_id)
               WHERE enrollment.student_id=summary.student_id AND enrollment.status='enrolled'
               ORDER BY term.starts_on DESC LIMIT 1) AS term_name
      FROM student_lifecycle_summary summary
      JOIN students student USING(student_id)
      WHERE student.institution_student_id=$1`, [usn],
    )
    const student = studentResult.rows[0]
    if (!student) { response.status(404).json({ message: 'Student record not found.' }); return }

    const [coursesResult, assignmentsResult, announcementsResult, gradesResult, creditsResult, materialsResult] = await Promise.all([
      pool.query(
        `SELECT c.course_code AS code,c.course_name AS name,
                f.title || ' ' || f.first_name || ' ' || f.last_name AS faculty,cs.room,
                string_agg(DISTINCT CASE sm.day_of_week WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
                  WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat' ELSE 'Sun' END,
                  ' · ' ORDER BY CASE sm.day_of_week WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
                  WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat' ELSE 'Sun' END) AS days,
                string_agg(DISTINCT to_char(sm.starts_at,'HH24:MI') || '–' || to_char(sm.ends_at,'HH24:MI'),
                  ' · ' ORDER BY to_char(sm.starts_at,'HH24:MI') || '–' || to_char(sm.ends_at,'HH24:MI')) AS time,
                json_agg(json_build_object('day',sm.day_of_week,'startsAt',to_char(sm.starts_at,'HH24:MI'),
                  'endsAt',to_char(sm.ends_at,'HH24:MI')) ORDER BY sm.day_of_week,sm.starts_at) AS meetings,
                COALESCE(ar.attendance_percent,0) AS attendance,e.final_grade AS grade,
                CASE mod(c.course_id,4) WHEN 0 THEN 'mint' WHEN 1 THEN 'blue'
                  WHEN 2 THEN 'orange' ELSE 'rose' END AS color
         FROM enrollments e JOIN course_sections cs USING(section_id)
         JOIN courses c USING(course_id) JOIN faculty f USING(faculty_id)
         JOIN section_meetings sm USING(section_id)
         LEFT JOIN attendance_register ar USING(enrollment_id)
         WHERE e.student_id=$1 AND e.status='enrolled'
         GROUP BY c.course_id,c.course_code,c.course_name,f.title,f.first_name,f.last_name,cs.room,ar.attendance_percent,e.final_grade
         ORDER BY c.course_code`, [student.student_id],
      ),
      pool.query(
        `SELECT a.title,c.course_code || ' · ' || c.course_name AS course,
                to_char(a.due_at AT TIME ZONE 'Asia/Kolkata','DD Mon, HH12:MI PM') AS due,
                CASE WHEN r.result_id IS NOT NULL THEN 'Submitted' ELSE 'In progress' END AS status
         FROM enrollments e JOIN course_sections cs USING(section_id) JOIN courses c USING(course_id)
         JOIN assessments a USING(section_id)
         LEFT JOIN assessment_results r ON r.assessment_id=a.assessment_id AND r.enrollment_id=e.enrollment_id
         WHERE e.student_id=$1 AND a.due_at >= now()-interval '1 day'
         ORDER BY a.due_at LIMIT 5`, [student.student_id],
      ),
      pool.query(
        `SELECT a.title,a.body,to_char(a.published_at,'DD Mon') AS date,
                upper(CASE WHEN a.audience='campus' THEN 'CAMPUS' ELSE c.course_code || ' · ' || c.course_name END) AS category,
                CASE WHEN a.audience='campus' THEN 'coral' ELSE 'green' END AS color
         FROM announcements a LEFT JOIN course_sections cs USING(section_id) LEFT JOIN courses c USING(course_id)
         WHERE a.audience='campus' OR a.section_id IN
           (SELECT section_id FROM enrollments WHERE student_id=$1 AND status='enrolled')
         ORDER BY a.published_at DESC LIMIT 4`, [student.student_id],
      ),
      pool.query(
        `SELECT round(avg(CASE WHEN score_percent>=90 THEN 4.0 WHEN score_percent>=85 THEN 3.7
          WHEN score_percent>=80 THEN 3.3 WHEN score_percent>=75 THEN 3.0 WHEN score_percent>=70 THEN 2.7
          WHEN score_percent>=65 THEN 2.3 WHEN score_percent>=60 THEN 2.0 ELSE 0 END),2) AS gpa
         FROM course_gradebook WHERE roll_number=$1 AND score_percent IS NOT NULL`, [student.roll_number],
      ),
      pool.query(
        `SELECT COALESCE(sum(c.credits),0) AS credits FROM enrollments e
         JOIN course_sections cs USING(section_id) JOIN courses c USING(course_id)
         WHERE e.student_id=$1 AND e.status='enrolled'`, [student.student_id],
      ),
      pool.query(
        `SELECT material.title, c.course_code || ' · ' || c.course_name AS course,
                material.material_type AS type, material.resource_url AS url,
                to_char(material.published_at,'DD Mon') AS date
         FROM enrollments e JOIN course_sections cs USING(section_id)
         JOIN courses c USING(course_id) JOIN course_materials material USING(section_id)
         WHERE e.student_id=$1 AND e.status='enrolled'
         ORDER BY material.published_at DESC LIMIT 30`, [student.student_id],
      ),
    ])
    const attendanceValues = coursesResult.rows.map((course) => Number(course.attendance))
    const attendance = attendanceValues.length ? Math.round(attendanceValues.reduce((sum, value) => sum + value, 0) / attendanceValues.length) : 0
    response.json({
      student: { name: `${student.first_name} ${student.last_name}`, usn: student.institution_student_id,
        program: student.program_name ?? 'Program not assigned',
        semester: `Semester ${student.current_semester}${student.term_name ? ` · ${student.term_name}` : ''}` },
      attendance, gpa: Number(gradesResult.rows[0]?.gpa ?? 0), credits: Number(creditsResult.rows[0]?.credits ?? 0),
      courses: coursesResult.rows.map((course) => ({ ...course, attendance: Number(course.attendance) })),
      assignments: assignmentsResult.rows, announcements: announcementsResult.rows,
      materials: materialsResult.rows, database: 'connected',
    })
  } catch (error) {
    console.error('Dashboard query failed:', error)
    response.status(503).json({ message: 'The academic database is unavailable.' })
  }
}

app.get('/api/dashboard', requireStaff, async (request, response) => {
  await sendDashboard(String(request.query.usn ?? '').trim().toUpperCase(), response)
})

app.get('/api/student/dashboard', requireStudent, async (_request, response) => {
  const student = response.locals.student as { institution_student_id: string }
  await sendDashboard(student.institution_student_id, response)
})

if (process.env.NODE_ENV === 'production') {
  const clientBuild = resolve(process.cwd(), 'dist')
  app.use(express.static(clientBuild, {
    index: false,
    setHeaders(response, path) {
      response.setHeader('Cache-Control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
    },
  }))
  app.get('/{*path}', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next()
      return
    }
    response.sendFile(resolve(clientBuild, 'index.html'))
  })
}

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
app.listen(port, '0.0.0.0', () => console.log(`Student Lifecycle API listening on port ${port}`))
