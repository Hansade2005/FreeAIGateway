import Dexie, { type Table } from 'dexie'

// Local-only project store (IndexedDB via Dexie). Everything the builder makes
// lives in the browser — projects (their file snapshots) and chat history — so a
// reload or crash resumes where you left off, no server state.

// State of a single integration/connector for a project. Config (keys, urls) is
// kept LOCAL in IndexedDB — the builder never ships it to a server.
export interface IntegrationState {
  connected: boolean
  config?: Record<string, string>
  connectedAt?: number
}

// Per-app settings: free-form metadata plus the integrations/feature config that
// the Settings view manages. Designed to grow — add fields here and a section in
// the Settings view; existing projects just read the defaults.
export interface ProjectSettings {
  description?: string
  integrations?: Record<string, IntegrationState>
  features?: Record<string, boolean>
}

export interface Project {
  id: string
  name: string
  files: Record<string, string>
  assets?: Record<string, Uint8Array> // generated binary assets (images)
  settings?: ProjectSettings
  leafId?: number | null // active conversation branch tip (last message shown)
  createdAt: number
  updatedAt: number
}

// A compact record of a tool action, persisted so the chat's action pills
// survive a reload.
export interface StoredAction { kind: string; label: string; path?: string; output?: string; image?: string }

// An assistant turn is an ordered timeline of text and tool actions, so the UI
// can render each tool pill inline at the exact point it happened.
export type MessagePart = { type: 'text'; text: string } | { type: 'action'; action: StoredAction }

// Snapshot of the project taken when a user message is sent (BEFORE the agent
// runs), so the user can roll the codebase back to that point.
export interface Checkpoint { files: Record<string, string>; assets?: Record<string, Uint8Array> }

export interface Message {
  id?: number
  projectId: string
  role: 'user' | 'assistant'
  content: string
  actions?: StoredAction[]
  parts?: MessagePart[]
  checkpoint?: Checkpoint
  // Conversation tree: the message this one follows. null = a root message.
  // Editing a user message creates a sibling (same parentId) → a new branch.
  parentId?: number | null
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

// A cached binary snapshot of node_modules, keyed by a hash of the lockfile, so
// a reload can restore deps instead of re-running npm install over the network.
export interface Snapshot {
  hash: string
  data: Uint8Array
  createdAt: number
}

class BuilderDB extends Dexie {
  projects!: Table<Project, string>
  messages!: Table<Message, number>
  deploys!: Table<Deploy, string>
  snapshots!: Table<Snapshot, string>
  constructor() {
    super('fag-builder')
    this.version(1).stores({ projects: 'id, updatedAt', messages: '++id, projectId, createdAt' })
    this.version(2).stores({ projects: 'id, updatedAt', messages: '++id, projectId, createdAt', deploys: 'id, createdAt' })
    this.version(3).stores({ projects: 'id, updatedAt', messages: '++id, projectId, createdAt', deploys: 'id, createdAt', snapshots: 'hash, createdAt' })
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

export async function saveProjectSettings(id: string, settings: ProjectSettings): Promise<void> {
  await db.projects.update(id, { settings, updatedAt: Date.now() })
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

export async function deleteMessage(id: number): Promise<void> {
  await db.messages.delete(id)
}

export async function deleteMessages(ids: number[]): Promise<void> {
  await db.messages.bulkDelete(ids)
}

// Persist the active conversation branch tip for a project.
export async function saveLeaf(projectId: string, leafId: number | null): Promise<void> {
  await db.projects.update(projectId, { leafId })
}

// Set a message's parent (used to back-fill links on legacy linear chats).
export async function setMessageParent(id: number, parentId: number | null): Promise<void> {
  await db.messages.update(id, { parentId })
}

// Delete every message in the project newer than `createdAt` (used by restore).
export async function deleteMessagesAfter(projectId: string, createdAt: number): Promise<void> {
  await db.messages.where('projectId').equals(projectId).and((m) => m.createdAt > createdAt).delete()
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

// node_modules snapshot cache (keep the few most recent to bound storage).
export async function getSnapshot(hash: string): Promise<Uint8Array | undefined> {
  return (await db.snapshots.get(hash))?.data
}

export async function saveSnapshot(hash: string, data: Uint8Array): Promise<void> {
  await db.snapshots.put({ hash, data, createdAt: Date.now() })
  const all = await db.snapshots.orderBy('createdAt').reverse().toArray()
  for (const s of all.slice(3)) await db.snapshots.delete(s.hash)
}
