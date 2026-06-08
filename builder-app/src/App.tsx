import { useState } from 'react'
import { Builder } from './builder/Builder'
import { Settings } from './Settings'
import { isConfigured } from './provider'

export function App() {
  const [configured, setConfigured] = useState(isConfigured())
  const [editing, setEditing] = useState(false)

  if (!configured) return <Settings onSaved={() => setConfigured(true)} />
  return (
    <>
      <Builder onEditProvider={() => setEditing(true)} />
      {editing && (
        // Changing the provider/model takes effect on reload (the agent reads the
        // model once at boot), so reload after a save.
        <Settings onSaved={() => location.reload()} onClose={() => setEditing(false)} />
      )}
    </>
  )
}
