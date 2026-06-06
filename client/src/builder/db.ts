import Dexie, { type Table } from 'dexie'

// Local-only project store (IndexedDB via Dexie). Everything the builder makes
// lives in the browser — projects (their file snapshots) and chat history — so a
// reload or crash resumes where you left off, no server state.

export interface Project {
  id: string
  name: string
  files: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface Message {
  id?: number
  projectId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

class BuilderDB extends Dexie {
  projects!: Table<Project, string>
  messages!: Table<Message, number>
  constructor() {
    super('fag-builder')
    this.version(1).stores({
      projects: 'id, updatedAt',
      messages: '++id, projectId, createdAt',
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
