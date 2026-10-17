import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { generateSecret, verify } from 'otplib'

export const authenticatorPeriodSeconds = 60

function encryptionKey(keyHex: string): Buffer {
  if (!/^[\da-f]{64}$/i.test(keyHex)) {
    throw new Error('TOTP_ENCRYPTION_KEY must contain 64 hexadecimal characters.')
  }
  return Buffer.from(keyHex, 'hex')
}

export function encryptTotpSecret(secret: string, keyHex: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyHex), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

export function decryptTotpSecret(encrypted: string, keyHex: string): string {
  const [ivText, tagText, ciphertextText] = encrypted.split('.')
  if (!ivText || !tagText || !ciphertextText) throw new Error('Stored authenticator secret is invalid.')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyHex), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function createTotpSecret(): string {
  return generateSecret()
}

export async function verifyAuthenticatorCode(secret: string, token: string, epoch: number, afterTimeStep?: number) {
  return verify({
    secret,
    token,
    epoch,
    period: authenticatorPeriodSeconds,
    epochTolerance: 0,
    ...(afterTimeStep === undefined ? {} : { afterTimeStep }),
  })
}