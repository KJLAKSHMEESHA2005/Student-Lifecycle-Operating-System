import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askGemini, validateGeminiMessages } from './gemini.ts'

test('validates chat shape, bounds, and final user message', () => {
  assert.throws(() => validateGeminiMessages([]), /between 1 and 20/)
  assert.throws(() => validateGeminiMessages([{ role: 'system', content: 'x' }]), /Message 1 is invalid/)
  assert.throws(() => validateGeminiMessages([{ role: 'user', content: 'x'.repeat(4001) }]), /exceeds 4,000/)
  assert.throws(() => validateGeminiMessages([{ role: 'model', content: 'answer' }]), /latest message must be from you/)
  assert.deepEqual(validateGeminiMessages([{ role: 'user', content: '  Help me plan study time.  ' }]), [
    { role: 'user', content: 'Help me plan study time.' },
  ])
})

test('sends the API key in a header and extracts Gemini response text', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const fetcher: typeof fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Study in focused blocks.' }] } }] }), { status: 200 })
  }
  const answer = await askGemini([{ role: 'user', content: 'How should I study?' }], {
    apiKey: 'test-secret', model: 'gemini-test', fetcher,
  })
  assert.equal(answer, 'Study in focused blocks.')
  assert.match(capturedUrl, /models\/gemini-test:generateContent$/)
  assert.equal(new Headers(capturedInit?.headers).get('x-goog-api-key'), 'test-secret')
  const payload = JSON.parse(String(capturedInit?.body)) as { contents: { role: string; parts: { text: string }[] }[] }
  assert.deepEqual(payload.contents, [{ role: 'user', parts: [{ text: 'How should I study?' }] }])
})

test('maps quota and API-key failures without exposing provider response bodies', async () => {
  const makeFetcher = (status: number): typeof fetch => async () =>
    new Response('sensitive provider payload', { status })
  await assert.rejects(
    askGemini([{ role: 'user', content: 'Hi' }], { apiKey: 'test-secret', model: 'test', fetcher: makeFetcher(403) }),
    (error: Error) => error.message.includes('rejected the API key') && !error.message.includes('sensitive'),
  )
  await assert.rejects(
    askGemini([{ role: 'user', content: 'Hi' }], { apiKey: 'test-secret', model: 'test', fetcher: makeFetcher(429) }),
    /quota or rate limit/,
  )
})

test('reports empty successful response', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
  await assert.rejects(askGemini([{ role: 'user', content: 'Hi' }], {
    apiKey: 'test-secret', model: 'test', fetcher,
  }), /returned no response/)
})