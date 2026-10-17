import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const migrationFiles = (await readdir(resolve('database/migrations')))
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const version = file.replace(/\.sql$/, '')
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])
    if (applied.rowCount) {
      console.log(`Migration ${version} already applied.`)
      continue
    }

    const sql = await readFile(resolve('database/migrations', file), 'utf8')
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version])
      await client.query('COMMIT')
      console.log(`Migration ${version} applied.`)
    } catch (error) { await client.query('ROLLBACK'); throw error }
  }
} finally { client.release(); await pool.end() }
