// Hand off the Home prompt (and future attachments) to the workspace WITHOUT
// passing it through the URL or React props — survives a reload during the
// redirect and keeps long prompts / attachments off the URL entirely.
// Keyed per project; the workspace consumes (reads + clears) it once on boot.

const PREFIX = 'fag-pending-prompt:'

export interface PendingPrompt {
  prompt: string
  // Reserved for future use (data-URL or asset refs). Not yet wired into the agent.
  attachments?: { name: string; type: string; dataUrl: string }[]
}

export function setPending(projectId: string, data: PendingPrompt): void {
  try { localStorage.setItem(PREFIX + projectId, JSON.stringify(data)) } catch { /* quota / disabled */ }
}

// Read AND remove — a one-shot handoff so it never re-runs on a later visit.
export function takePending(projectId: string): PendingPrompt | null {
  try {
    const raw = localStorage.getItem(PREFIX + projectId)
    if (!raw) return null
    localStorage.removeItem(PREFIX + projectId)
    return JSON.parse(raw) as PendingPrompt
  } catch { return null }
}
