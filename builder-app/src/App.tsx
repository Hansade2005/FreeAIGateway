import { useState } from 'react'
import { Builder } from './builder/Builder'
import { Settings } from './Settings'
import { Home } from './Home'
import { isConfigured } from './provider'
import { createProject } from './builder/db'
import { STARTER_FILES } from './builder/template'

const LAST_KEY = 'fag-builder-last' // matches Builder's project key

function deriveName(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim()
  if (!t) return 'Untitled app'
  const words = t.split(' ').slice(0, 6).join(' ')
  return words.length > 42 ? words.slice(0, 42) + '…' : words
}

export function App() {
  const [configured, setConfigured] = useState(isConfigured())
  const [editing, setEditing] = useState(false)
  const [view, setView] = useState<'home' | 'builder'>('home')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>()

  if (!configured) return <Settings onSaved={() => setConfigured(true)} />

  const open = (id: string, prompt?: string) => {
    localStorage.setItem(LAST_KEY, id)
    setProjectId(id); setInitialPrompt(prompt); setView('builder')
  }
  const startFromPrompt = async (prompt: string) => {
    const p = await createProject(deriveName(prompt), { ...STARTER_FILES })
    open(p.id, prompt)
  }
  const goHome = () => { setView('home'); setInitialPrompt(undefined); setProjectId(null) }

  const settingsModal = editing && (
    // Provider/model changes take effect on reload (the agent reads the model at
    // boot), so reload after saving.
    <Settings onSaved={() => location.reload()} onClose={() => setEditing(false)} />
  )

  if (view === 'home') {
    return (
      <>
        <Home onStart={startFromPrompt} onOpen={(id) => open(id)} onEditProvider={() => setEditing(true)} />
        {settingsModal}
      </>
    )
  }
  return (
    <>
      <Builder key={projectId ?? 'builder'} initialPrompt={initialPrompt} onHome={goHome} onEditProvider={() => setEditing(true)} />
      {settingsModal}
    </>
  )
}
