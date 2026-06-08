import { useEffect, useState } from 'react'
import { Builder } from './builder/Builder'
import { Settings } from './Settings'
import { Home } from './Home'
import { isConfigured } from './provider'
import { setPending } from './pending'
import { createProject } from './builder/db'
import { getFramework } from './builder/frameworks'

const LAST_KEY = 'fag-builder-last' // matches Builder's project key

function deriveName(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim()
  if (!t) return 'Untitled app'
  const words = t.split(' ').slice(0, 6).join(' ')
  return words.length > 42 ? words.slice(0, 42) + '…' : words
}

// The open project lives in the URL (?p=<id>) so a refresh stays in the
// workspace and back/forward navigates between Home and a project.
const urlProject = () => { try { return new URLSearchParams(location.search).get('p') } catch { return null } }

export function App() {
  const [configured, setConfigured] = useState(isConfigured())
  const [editing, setEditing] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(urlProject())

  // Keep the project in LAST_KEY for the Builder on first load, and sync state
  // with browser back/forward.
  useEffect(() => {
    if (projectId) localStorage.setItem(LAST_KEY, projectId)
    const onPop = () => setProjectId(urlProject())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  if (!configured) return <Settings onSaved={() => setConfigured(true)} />

  const open = (id: string) => {
    localStorage.setItem(LAST_KEY, id)
    history.pushState({ p: id }, '', '?p=' + encodeURIComponent(id))
    setProjectId(id)
  }
  const startFromPrompt = async (prompt: string, frameworkId: string) => {
    const fw = getFramework(frameworkId)
    const p = await createProject(deriveName(prompt), { ...fw.files }, fw.id)
    // Hand the prompt off via the pending store (reload-safe, no URL/props).
    setPending(p.id, { prompt })
    open(p.id)
  }
  const goHome = () => { history.pushState({}, '', location.pathname); setProjectId(null) }

  const settingsModal = editing && (
    // Provider/model changes take effect on reload (the agent reads the model at
    // boot), so reload after saving.
    <Settings onSaved={() => location.reload()} onClose={() => setEditing(false)} />
  )

  if (!projectId) {
    return (
      <>
        <Home onStart={startFromPrompt} onOpen={(id) => open(id)} onEditProvider={() => setEditing(true)} />
        {settingsModal}
      </>
    )
  }
  return (
    <>
      <Builder key={projectId} onHome={goHome} onEditProvider={() => setEditing(true)} />
      {settingsModal}
    </>
  )
}
