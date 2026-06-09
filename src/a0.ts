// Free a0.dev LLM — used to generate fresh prompt-idea suggestions for the Home
// screen (cached for the day; static fallback on any failure).

export interface A0Message { role: 'system' | 'user' | 'assistant'; content: string }

export async function callA0LLM(messages: A0Message[]): Promise<string> {
  const res = await fetch('https://api.a0.dev/ai/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!res.ok) throw new Error(`a0 LLM request failed: ${res.status}`)
  const data = (await res.json()) as { completion?: string }
  return data.completion ?? ''
}

export const FALLBACK_SUGGESTIONS = [
  'A minimal habit tracker with streaks',
  'Pomodoro timer with ambient sounds',
  'Markdown notes app with tags',
  'A landing page for a coffee brand',
  'A kanban board with drag and drop',
  'A weather dashboard with animated cards',
]

export async function fetchPromptSuggestions(): Promise<string[]> {
  try {
    const completion = await callA0LLM([
      {
        role: 'system',
        content:
          'You generate short app idea prompts for an AI app builder. Respond with ONLY a JSON array of 6 strings. Each string is one short app idea prompt (max 10 words). No prose, no markdown fences.',
      },
      { role: 'user', content: 'Give me 6 fresh, creative app ideas a developer might want to build today.' },
    ])
    const cleaned = completion.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, 6).map(String)
    return FALLBACK_SUGGESTIONS
  } catch {
    return FALLBACK_SUGGESTIONS
  }
}

// Daily cache in localStorage (no server / db.settings table here).
const CACHE_KEY = 'fag-prompt-suggestions'
export async function getDailySuggestions(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as { day: string; list: string[] } | null
    if (cached && cached.day === today && cached.list?.length) return cached.list
  } catch { /* ignore */ }
  const list = await fetchPromptSuggestions()
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ day: today, list })) } catch { /* ignore */ }
  return list
}
