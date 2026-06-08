# AI App Builder (standalone)

A provider-agnostic, prompt-to-app builder that runs **entirely in your browser**
via [WebContainer](https://webcontainer.io). Describe an app in chat; an agent
writes the code, runs it in an in-browser Vite + React + Tailwind sandbox, and
you get a live preview, a real editor, a terminal, and full DOM automation —
powered by **any OpenAI-compatible API and model you plug in**.

It's the same builder that ships inside FreeAIGateway, extracted to stand alone
with **zero server dependency** (no gateway needed).

## Bring your own model

On first run you pick a provider: enter a **Base URL**, an **API key**, and a
**model**. Presets included for Kilo (free/anonymous), OpenAI, OpenRouter, Groq,
and Together — or point it at anything OpenAI-compatible (LM Studio, vLLM,
llama.cpp, your own gateway). Config is stored locally in the browser.

Optional (Advanced):
- **Fallback model** — retried if the primary fails.
- **Vision model** — used for screenshot turns (image input); defaults to the main model.
- **Image model** — enables the `generate_image` tool (OpenAI `/images` shape).

> The agent uses tool calling, so pick a **tool-capable** model.

## What the agent can do

Read/write/edit files · run shell commands · generate images (if configured) ·
read console logs · **screenshot** and **inspect** the live preview · a
**Playwright-style accessibility snapshot** with refs, then **click / fill /
press_key / scroll / evaluate** the running app (each interaction returns the
fresh page state) · web search & fetch.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (dev server sets the COOP/COEP headers)
```

Production:

```bash
npm run build
npm start          # serves dist/ with the required cross-origin-isolation headers
```

## Requirements

WebContainer needs a **cross-origin isolated** context (COOP `same-origin` +
COEP `credentialless`) and a Chromium-based browser. The included dev server,
`vite preview`, and `npm start` all set these headers. If you host the built
`dist/` elsewhere, your host **must** send them too.

## Stack

React 18-in-the-sandbox · React 19 shell · Vite · Tailwind v4 · Dexie
(IndexedDB) · RxJS · xterm.js · CodeMirror · WebContainer API.
