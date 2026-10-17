import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generate, generateSecret } from 'otplib'
import { decryptTotpSecret, encryptTotpSecret, verifyAuthenticatorCode } from './totp.ts'

const encryptionKey = Buffer.alloc(32, 7).toString('hex')

test('authenticator secrets are encrypted at rest and decrypt only with the configured key', () => {
  const secret = generateSecret()
  const encrypted = encryptTotpSecret(secret, encryptionKey)
  assert.notEqual(encrypted, secret)
  assert.equal(decryptTotpSecret(encrypted, encryptionKey), secret)
  assert.throws(() => decryptTotpSecret(encrypted, Buffer.alloc(32, 9).toString('hex')))
})

test('authenticator codes use a 60-second period and reject a reused time step', async () => {
  const secret = generateSecret()
  const epoch = 120
  const token = await generate({ secret, epoch, period: 60 })
  const verified = await verifyAuthenticatorCode(secret, token, epoch)
  const replayed = await verifyAuthenticatorCode(secret, token, epoch, verified.timeStep)
  const thirtySecondCode = await generate({ secret, epoch, period: 30 })

  assert.equal(verified.valid, true)
  assert.equal(replayed.valid, false)
  assert.notEqual(thirtySecondCode, token)
})