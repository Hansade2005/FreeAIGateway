import { useState } from 'react'
import { Sparkles, Check, X } from 'lucide-react'
import { getProvider, setProvider, PRESETS, type Preset } from './provider'

// First-run / change-provider screen. Plug in ANY OpenAI-compatible API.
export function Settings({ onSaved, onClose }: { onSaved: () => void; onClose?: () => void }) {
  const cur = getProvider()
  const [baseUrl, setBaseUrl] = useState(cur?.baseUrl ?? PRESETS[0].baseUrl)
  const [apiKey, setApiKey] = useState(cur?.apiKey ?? '')
  const [model, setModel] = useState(cur?.model ?? PRESETS[0].model)
  const [fallbackModel, setFallbackModel] = useState(cur?.fallbackModel ?? '')
  const [visionModel, setVisionModel] = useState(cur?.visionModel ?? '')
  const [imageModel, setImageModel] = useState(cur?.imageModel ?? '')
  const [advanced, setAdvanced] = useState(false)

  const applyPreset = (p: Preset) => { if (p.baseUrl) setBaseUrl(p.baseUrl); if (p.model) setModel(p.model); if (p.keyless) setApiKey('') }
  const valid = baseUrl.trim() && model.trim()
  const save = () => {
    if (!valid) return
    setProvider({
      baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(),
      fallbackModel: fallbackModel.trim() || undefined,
      visionModel: visionModel.trim() || undefined,
      imageModel: imageModel.trim() || undefined,
    })
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur">
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border bg-surface-1 p-6 shadow-2xl">
        {onClose && <button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground"><X className="size-4" /></button>}
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="size-5 text-signal" />
          <h1 className="font-display text-lg font-semibold">Connect a model</h1>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">Plug in any OpenAI-compatible API. Stored only in this browser.</p>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => applyPreset(p)} className="rounded-lg border px-2.5 py-1 text-xs text-muted-foreground hover:bg-surface-2 hover:text-foreground" title={p.note}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          <Field label="Base URL" hint="OpenAI-compatible endpoint root (no /chat/completions)">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="inp" />
          </Field>
          <Field label="API key" hint="Leave empty for keyless/anonymous providers">
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-…" className="inp" />
          </Field>
          <Field label="Model" hint="The agent/chat model id">
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" className="inp" />
          </Field>

          <button onClick={() => setAdvanced((a) => !a)} className="text-xs font-medium text-signal hover:underline">
            {advanced ? 'Hide' : 'Show'} advanced (fallback, vision, image models)
          </button>
          {advanced && (
            <div className="space-y-3 rounded-xl border bg-surface-2/40 p-3">
              <Field label="Fallback model" hint="Retried if the primary model fails (optional)">
                <input value={fallbackModel} onChange={(e) => setFallbackModel(e.target.value)} placeholder="(none)" className="inp" />
              </Field>
              <Field label="Vision model" hint="Used for screenshot turns; defaults to the main model">
                <input value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="(defaults to model)" className="inp" />
              </Field>
              <Field label="Image model" hint="Enables the generate_image tool (OpenAI /images). Leave empty to disable.">
                <input value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder="(disabled)" className="inp" />
              </Field>
            </div>
          )}
        </div>

        <button onClick={save} disabled={!valid} className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-signal px-4 py-2.5 text-sm font-semibold text-signal-foreground disabled:opacity-50">
          <Check className="size-4" /> Save & start building
        </button>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium">{label}</div>
      {hint && <div className="mb-1 text-[11px] text-muted-foreground">{hint}</div>}
      {children}
    </label>
  )
}
