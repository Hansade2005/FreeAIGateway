import { useState, type ReactNode } from 'react'
import { Settings, X, Info, Plug, SlidersHorizontal, AlertTriangle, Check, ExternalLink, Trash2, Copy } from 'lucide-react'
import type { Project, ProjectSettings, IntegrationState } from './db'
import { CONNECTORS, type Connector } from './connectors'

type Section = 'details' | 'integrations' | 'features' | 'danger'

function timeStr(t: number): string {
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Per-app settings: project metadata + the surface where integrations and
// feature flags are managed. New connectors come from connectors.ts; new
// sections slot into the left nav.
export function SettingsModal({ project, onClose, onSave, onRename, onDelete }: {
  project: Project
  onClose: () => void
  onSave: (settings: ProjectSettings) => void
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [section, setSection] = useState<Section>('details')
  const [settings, setSettings] = useState<ProjectSettings>(project.settings ?? {})
  const [name, setName] = useState(project.name)

  // Persist a settings patch immediately (settings are cheap, local-only).
  function patch(next: Partial<ProjectSettings>) {
    const merged = { ...settings, ...next }
    setSettings(merged)
    onSave(merged)
  }

  const fileCount = Object.keys(project.files).filter((f) => !f.startsWith('node_modules') && f !== 'package-lock.json').length
  const assetCount = Object.keys(project.assets ?? {}).length
  const connectedCount = Object.values(settings.integrations ?? {}).filter((i) => i.connected).length

  const nav: { id: Section; label: string; icon: typeof Info }[] = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'features', label: 'Features', icon: SlidersHorizontal },
    { id: 'danger', label: 'Danger zone', icon: AlertTriangle },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-[7vh]" onClick={onClose}>
      <div className="flex max-h-[82vh] w-full max-w-3xl overflow-hidden rounded-2xl border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Left nav */}
        <div className="flex w-48 flex-none flex-col border-r bg-surface-1 p-2">
          <div className="flex items-center gap-2 px-2 py-2">
            <Settings className="size-4 text-signal" />
            <span className="font-display text-sm font-semibold">Settings</span>
          </div>
          <div className="mt-1 truncate px-2 pb-2 text-[11px] text-muted-foreground" title={project.name}>{project.name}</div>
          {nav.map((n) => (
            <button
              key={n.id}
              onClick={() => setSection(n.id)}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${section === n.id ? 'bg-signal-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-surface-2'} ${n.id === 'danger' ? 'mt-auto' : ''}`}
            >
              <n.icon className={`size-4 shrink-0 ${n.id === 'danger' ? 'text-destructive' : ''}`} />
              {n.label}
              {n.id === 'integrations' && connectedCount > 0 && (
                <span className="ml-auto rounded-full bg-signal/20 px-1.5 text-[10px] font-medium text-signal">{connectedCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h2 className="font-display text-base font-semibold capitalize">{section === 'danger' ? 'Danger zone' : section}</h2>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground"><X className="size-4" /></button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === 'details' && (
              <div className="space-y-5">
                <Field label="App name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => { const t = name.trim(); if (t && t !== project.name) onRename(t) }}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
                  />
                </Field>
                <Field label="Description" hint="A short note about what this app is. Shown only to you.">
                  <textarea
                    value={settings.description ?? ''}
                    onChange={(e) => setSettings((s) => ({ ...s, description: e.target.value }))}
                    onBlur={() => patch({ description: settings.description })}
                    rows={3}
                    placeholder="e.g. Landing page for the launch, dark theme, waitlist form."
                    className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal/40"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Meta label="App ID" value={project.id} mono copyable />
                  <Meta label="Files" value={`${fileCount}${assetCount ? ` · ${assetCount} assets` : ''}`} />
                  <Meta label="Created" value={timeStr(project.createdAt)} />
                  <Meta label="Last edited" value={timeStr(project.updatedAt)} />
                </div>
              </div>
            )}

            {section === 'integrations' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Connect services to this app. Keys are stored locally in your browser, never sent to a server.</p>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {CONNECTORS.map((c) => (
                    <ConnectorCard
                      key={c.id}
                      connector={c}
                      state={settings.integrations?.[c.id]}
                      onChange={(state) => patch({ integrations: { ...(settings.integrations ?? {}), [c.id]: state } })}
                    />
                  ))}
                </div>
              </div>
            )}

            {section === 'features' && (
              <div className="space-y-2">
                <p className="mb-3 text-sm text-muted-foreground">Toggle optional capabilities for this app.</p>
                <Toggle
                  label="Auto-fix runtime errors"
                  hint="Let the agent automatically fix errors the preview reports."
                  on={settings.features?.autoFix ?? false}
                  onToggle={(v) => patch({ features: { ...(settings.features ?? {}), autoFix: v } })}
                />
                <Toggle
                  label="Verbose agent narration"
                  hint="Show fuller step-by-step narration in chat."
                  on={settings.features?.verbose ?? false}
                  onToggle={(v) => patch({ features: { ...(settings.features ?? {}), verbose: v } })}
                />
              </div>
            )}

            {section === 'danger' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
                  <h3 className="text-sm font-semibold">Delete this app</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Permanently removes the app, its files, and its chat history from this browser. This cannot be undone.</p>
                  <button onClick={onDelete} className="mt-3 flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                    <Trash2 className="size-3.5" /> Delete app
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-foreground">{label}</div>
      {hint && <div className="mb-1.5 text-[11px] text-muted-foreground">{hint}</div>}
      {children}
    </label>
  )
}

function Meta({ label, value, mono, copyable }: { label: string; value: string; mono?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="rounded-lg border bg-surface-1 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className={`min-w-0 truncate text-xs ${mono ? 'font-mono' : ''}`} title={value}>{value}</span>
        {copyable && (
          <button
            onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }).catch(() => {}) }}
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            title="Copy"
          >
            {copied ? <Check className="size-3 text-signal" /> : <Copy className="size-3" />}
          </button>
        )}
      </div>
    </div>
  )
}

function Toggle({ label, hint, on, onToggle }: { label: string; hint?: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-surface-1 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
      <button
        onClick={() => onToggle(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-signal' : 'bg-surface-2'}`}
        role="switch"
        aria-checked={on}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
    </div>
  )
}

function ConnectorCard({ connector, state, onChange }: { connector: Connector; state?: IntegrationState; onChange: (s: IntegrationState) => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>(state?.config ?? {})
  const connected = !!state?.connected
  const soon = connector.status === 'soon'
  const Icon = connector.icon

  return (
    <div className={`rounded-xl border p-3 ${connected ? 'border-signal/50 bg-signal-muted' : 'bg-surface-1'}`}>
      <div className="flex items-start gap-2.5">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background">
          <Icon className="size-4 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{connector.name}</span>
            {connected && <span className="rounded-full bg-signal/20 px-1.5 py-0.5 text-[10px] font-medium text-signal">connected</span>}
            {soon && <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted-foreground">soon</span>}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{connector.description}</p>
        </div>
      </div>

      {!soon && (
        <div className="mt-2.5 flex items-center gap-2">
          {connected ? (
            <button onClick={() => onChange({ connected: false, config: state?.config })} className="rounded-lg border px-2.5 py-1 text-xs hover:bg-surface-2">Disconnect</button>
          ) : (
            <button onClick={() => setOpen((o) => !o)} className="rounded-lg bg-signal px-2.5 py-1 text-xs font-semibold text-signal-foreground">Connect</button>
          )}
          {connector.docsUrl && (
            <a href={connector.docsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              Docs <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {!soon && open && !connected && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {connector.fields.map((f) => (
            <label key={f.key} className="block">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">{f.label}</div>
              <input
                type={f.type === 'password' ? 'password' : 'text'}
                value={form[f.key] ?? ''}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-signal/40"
              />
            </label>
          ))}
          <button
            onClick={() => { onChange({ connected: true, config: form, connectedAt: Date.now() }); setOpen(false) }}
            className="flex items-center gap-1.5 rounded-lg bg-signal px-3 py-1.5 text-xs font-semibold text-signal-foreground"
          >
            <Check className="size-3.5" /> Save & connect
          </button>
        </div>
      )}
    </div>
  )
}
