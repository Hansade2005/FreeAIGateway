// Standalone provider config. The builder is provider-agnostic: point it at any
// OpenAI-compatible API by setting a base URL + key + model. Stored locally in
// the browser (never sent anywhere but the provider you configure).

export interface ProviderConfig {
  baseUrl: string        // e.g. https://api.openai.com/v1  (no trailing /chat/completions)
  apiKey: string         // bearer key; may be empty for keyless/anon providers
  model: string          // primary chat/agent model id
  fallbackModel?: string // optional model to retry with on failure
  visionModel?: string   // model used for image (screenshot) turns; defaults to `model`
  imageModel?: string    // enables the generate_image tool (OpenAI /images shape) when set
}

const KEY = 'fag-builder-provider'

export interface Preset { label: string; baseUrl: string; model: string; keyless?: boolean; note?: string }
export const PRESETS: Preset[] = [
  { label: 'Kilo (free, anonymous)', baseUrl: 'https://api.kilo.ai/api/gateway/v1', model: 'kilo-auto/free', keyless: true, note: 'No key — free auto-router, rate-limited per IP' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { label: 'Custom', baseUrl: '', model: '' },
]

export function getProvider(): ProviderConfig | null {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as ProviderConfig) : null } catch { return null }
}
export function setProvider(c: ProviderConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c))
}
export function isConfigured(): boolean {
  const p = getProvider()
  return !!(p && p.baseUrl.trim() && p.model.trim())
}
// Normalize the base URL (strip a trailing slash) for endpoint concatenation.
export function apiBase(): string {
  return (getProvider()?.baseUrl || '').replace(/\/+$/, '')
}
