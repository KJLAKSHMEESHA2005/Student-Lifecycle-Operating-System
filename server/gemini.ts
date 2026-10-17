export type GeminiMessage = { role: 'user' | 'model'; content: string }

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

export function validateGeminiMessages(value: unknown): GeminiMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error('Send between 1 and 20 messages.')
  }
  const messages: GeminiMessage[] = []
  let totalCharacters = 0
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || !('role' in item) || !('content' in item)) {
      throw new Error(`Message ${index + 1} is invalid.`)
    }
    const { role, content } = item as { role: unknown; content: unknown }
    if ((role !== 'user' && role !== 'model') || typeof content !== 'string' || !content.trim()) {
      throw new Error(`Message ${index + 1} is invalid.`)
    }
    const trimmed = content.trim()
    if (trimmed.length > 4000) throw new Error(`Message ${index + 1} exceeds 4,000 characters.`)
    totalCharacters += trimmed.length
    messages.push({ role, content: trimmed })
  }
  if (messages[messages.length - 1].role !== 'user') throw new Error('The latest message must be from you.')
  if (totalCharacters > 20_000) throw new Error('The conversation exceeds the 20,000-character limit.')
  return messages
}

export async function askGemini(messages: GeminiMessage[], options: {
  apiKey: string
  model: string
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<string> {
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
      signal: options.signal ?? AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'You are the Student Lifecycle OS academic assistant. Help with academic planning, study strategies, and understanding records. Be clear and concise. Do not invent student records, grades, policies, or dates. Explain that the user should consult their institution for official decisions. Never request passwords, authenticator codes, or other secrets.' }],
        },
        contents: messages.map(({ role, content }) => ({ role, parts: [{ text: content }] })),
        generationConfig: { maxOutputTokens: 1200, temperature: 0.4 },
      }),
    },
  )
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Gemini rejected the API key. Check that it is valid and enabled for the Gemini API.')
    if (response.status === 429) throw new Error('Gemini quota or rate limit reached. Try again later or check your Google AI Studio quota.')
    throw new Error('Gemini could not complete the request. Try again later.')
  }
  const result = await response.json() as GeminiResponse
  const answer = result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim()
  if (!answer) throw new Error('Gemini returned no response. Rephrase the question and try again.')
  return answer
}