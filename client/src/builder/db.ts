import Dexie, { type Table } from 'dexie'

// Local-only project store (IndexedDB via Dexie). Everything the builder makes
// lives in the browser — projects (their file snapshots) and chat history — so a
// reload or crash resumes where you left off, no server state.

export interface Project {
  id: string
  name: string
  files: Record<string, string>
  assets?: Record<string, Uint8Array> // generated binary assets (images)
  createdAt: number
  updatedAt: number
}

// A compact record of a tool action, persisted so the chat's action pills
// survive a reload.
export interface StoredAction { kind: string; label: string; path?: string }

export interface Message {
  id?: number
  projectId: string
  role: 'user' | 'assistant'
  content: string
  actions?: StoredAction[]
  createdAt: number
}

// Handoff record: the (isolated) builder writes the built dist/ here, then opens
// the non-isolated /deploy page which reads it by id and uploads to Puter.
// Same-origin IndexedDB is shared across tabs regardless of COOP isolation.
export interface Deploy {
  id: string
  name: string
  files: Record<string, Uint8Array>
  createdAt: number
}

class BuilderDB extends Dexie {
  projects!: Table<Project, string>
  messages!: Table<Message, number>
  deploys!: Table<Deploy, string>
  constructor() {
    super('fag-builder')
    this.version(1).stores({
      projects: 'id, updatedAt',
      messages: '++id, projectId, createdAt',
    })
    this.version(2).stores({
      projects: 'id, updatedAt',
      messages: '++id, projectId, createdAt',
      deploys: 'id, createdAt',
    })
  }
}

export const db = new BuilderDB()

const uid = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

export async function createProject(name: string, files: Record<string, string>): Promise<Project> {
  const now = Date.now()
  const project: Project = { id: uid(), name, files, createdAt: now, updatedAt: now }
  await db.projects.put(project)
  return project
}

export async function saveFiles(id: string, files: Record<string, string>): Promise<void> {
  await db.projects.update(id, { files, updatedAt: Date.now() })
}

export async function saveAssets(id: string, assets: Record<string, Uint8Array>): Promise<void> {
  await db.projects.update(id, { assets, updatedAt: Date.now() })
}

export async function renameProject(id: string, name: string): Promise<void> {
  await db.projects.update(id, { name, updatedAt: Date.now() })
}

export async function listProjects(): Promise<Project[]> {
  return db.projects.orderBy('updatedAt').reverse().toArray()
}

export async function getProject(id: string): Promise<Project | undefined> {
  return db.projects.get(id)
}

export async function deleteProject(id: string): Promise<void> {
  await db.transaction('rw', db.projects, db.messages, async () => {
    await db.messages.where('projectId').equals(id).delete()
    await db.projects.delete(id)
  })
}

export async function addMessage(m: Omit<Message, 'id' | 'createdAt'>): Promise<number> {
  return db.messages.add({ ...m, createdAt: Date.now() })
}

export async function getMessages(projectId: string): Promise<Message[]> {
  return db.messages.where('projectId').equals(projectId).sortBy('createdAt')
}

export async function saveDeploy(name: string, files: Record<string, Uint8Array>): Promise<string> {
  const id = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  await db.deploys.put({ id, name, files, createdAt: Date.now() })
  // Keep the store tidy — drop handoffs older than an hour.
  const cutoff = Date.now() - 3600_000
  await db.deploys.where('createdAt').below(cutoff).delete().catch(() => {})
  return id
}

export async function getDeploy(id: string): Promise<Deploy | undefined> {
  return db.deploys.get(id)
}
