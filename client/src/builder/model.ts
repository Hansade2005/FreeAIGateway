// Builder agent model policy.
//
// The builder prefers Kilo's free auto-router (`kilo-auto/free`) when the user
// has Kilo configured — it's free (200/hr per IP), tool-capable, and Kilo picks
// the best free upstream itself. If Kilo isn't set up, we fall back to the
// gateway's own `auto` router across whatever providers ARE configured.
//
// We must decide client-side: pinning `kilo-auto/free` when it isn't configured
// would error (model_not_found) rather than reroute — `auto` is what reroutes.

export const BUILDER_PRIMARY_MODEL = 'kilo-auto/free'
export const BUILDER_FALLBACK_MODEL = 'auto'

const TOKEN_KEY = 'freellmapi_dashboard_token'

interface FallbackEntry { modelId: string; keyCount: number; enabled: boolean }

/** Returns `kilo-auto/free` when Kilo is configured + enabled, else `auto`. */
export async function resolveBuilderModel(): Promise<string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const res = await fetch('/api/fallback', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (res.ok) {
      const models = (await res.json()) as FallbackEntry[]
      const kilo = models.find((m) => m.modelId === BUILDER_PRIMARY_MODEL && m.keyCount > 0 && m.enabled)
      if (kilo) return BUILDER_PRIMARY_MODEL
    }
  } catch {
    /* fall through to the gateway router */
  }
  return BUILDER_FALLBACK_MODEL
}
