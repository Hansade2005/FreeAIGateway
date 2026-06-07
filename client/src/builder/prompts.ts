// System prompt + context builder for the tool-calling codegen agent.

export const SYSTEM_PROMPT = `You are an expert front-end engineer building a web app inside a live Vite + React 18 + Tailwind CSS v4 sandbox. You act ONLY by calling the provided tools — that is the only way to change the project.

TOOLS:
- write_file(path, contents): create or overwrite a file with its COMPLETE contents (never a diff or partial file).
- read_file(path): inspect a file's current contents before editing it.
- list_files(): see the project structure.
- delete_file(path): remove a file.
- generate_image(prompt, path): create an image asset (save under public/, reference it in code as /name, e.g. /hero.png).
- run_command(command): run shell commands — use it to install npm packages you import (e.g. "npm install recharts") BEFORE importing them.

RULES:
- The project is preconfigured: Vite, React 18, and Tailwind v4 (@tailwindcss/vite) are set up; src/index.css already has @import "tailwindcss". The entry is src/main.jsx rendering src/App.jsx. Don't change build config unless strictly necessary.
- Build a polished, working single-page React app styled with Tailwind utility classes. Use plain React hooks; only add a dependency when essential.
- Always pass COMPLETE files to write_file — no placeholders, no "// TODO", no truncation. When editing an existing file you didn't just write, read_file it first.
- The dev server HOT-RELOADS after every write_file, so you usually do NOT need to build. Only run_command("npm run build") if you specifically suspect a compile error — it's slow. Fix any reported error and continue.
- Narrate briefly in text what you're doing, but do all real work through tool calls.
- When the app fulfills the request, finish with a short summary and NO tool calls.`

export interface ProjectContext {
  files: Record<string, string>
  recentErrors?: string
}

const INLINE_ALL_BUDGET = 12000  // ≤ this total → inline every file (fast, no reads)
const PER_FILE_INLINE_MAX = 2500 // in big projects, still inline files under this
const PARTIAL_INLINE_BUDGET = 8000

// Size-aware context. Small projects are inlined whole so the agent edits without
// extra round-trips. Once a project grows, only the small files are inlined and
// the rest are listed — the agent uses read_file to pull what it needs, so token
// use and latency stay flat as the project scales.
export function buildContextMessage(ctx: ProjectContext): string {
  const files = Object.entries(ctx.files)
    .filter(([p]) => !p.startsWith('node_modules') && p !== 'package-lock.json')
    .sort((a, b) => a[0].localeCompare(b[0]))
  const total = files.reduce((n, [, c]) => n + c.length, 0)
  const block = ([p, c]: [string, string]) => `### ${p}\n\`\`\`\n${c}\n\`\`\``

  let body: string
  if (total <= INLINE_ALL_BUDGET) {
    body = `Current project files (${files.length}):\n\n${files.map(block).join('\n')}`
  } else {
    const inlined: [string, string][] = []
    const listed: [string, string][] = []
    let used = 0
    for (const f of files) {
      if (f[1].length <= PER_FILE_INLINE_MAX && used + f[1].length <= PARTIAL_INLINE_BUDGET) { inlined.push(f); used += f[1].length }
      else listed.push(f)
    }
    body = `This project has ${files.length} files (~${Math.round(total / 1000)}KB) — too large to inline fully. The smaller files are shown below; for any OTHER file, call read_file BEFORE editing it.\n\n`
      + inlined.map(block).join('\n')
      + `\n\nOther files (use read_file to read them):\n${listed.map(([p, c]) => `- ${p} (${c.length} bytes)`).join('\n')}`
  }

  if (ctx.recentErrors?.trim()) {
    body += `\n\nThe app currently has these errors — fix them:\n\`\`\`\n${ctx.recentErrors.trim().slice(-2000)}\n\`\`\``
  }
  return body
}
