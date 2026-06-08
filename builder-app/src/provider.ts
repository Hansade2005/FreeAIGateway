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

// Built-in default: a free, keyless OpenAI-compatible Kilo proxy. The app works
// out of the box with no setup; users can change it in Settings → Provider.
export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: 'https://the3rdacademy.com/api/v1',
  apiKey: '',
  model: 'kilo-auto/free',
  visionModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
}

export interface Preset { label: string; baseUrl: string; model: string; keyless?: boolean; note?: string }
export const PRESETS: Preset[] = [
  { label: 'Default (free, no key)', baseUrl: 'https://the3rdacademy.com/api/v1', model: 'kilo-auto/free', keyless: true, note: 'Free Kilo proxy — works out of the box, no key' },
  { label: 'Kilo (free, anonymous)', baseUrl: 'https://api.kilo.ai/api/gateway/v1', model: 'kilo-auto/free', keyless: true, note: 'No key — free auto-router, rate-limited per IP' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { label: 'Custom', baseUrl: '', model: '' },
]

// Returns the user's saved provider, or the built-in default so the app is
// usable immediately with no configuration.
export function getProvider(): ProviderConfig {
  try { const r = localStorage.getItem(KEY); if (r) return JSON.parse(r) as ProviderConfig } catch { /* ignore */ }
  return DEFAULT_PROVIDER
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
  return (getProvider().baseUrl || '').replace(/\/+$/, '')
}
