<div align="center">

<img src="repo-assets/logo.png" alt="FreeAIGateway" height="96" onerror="this.style.display='none'" />

# FreeAIGateway

### One gateway. Two protocols. Sixteen free LLM providers. ~1.7B tokens/month.

A single self-hosted server that aggregates the free tiers of **16 major LLM providers** behind **one unified API key** — speaking **both** the OpenAI wire format (`/v1/chat/completions`, `/v1/responses`) **and** the Anthropic Messages format (`/v1/messages`). Point an OpenAI client, the Anthropic SDK, or Claude Code at the same base URL. A smart router picks the best available model per request, fails over when one is rate-limited, and tracks per-key usage so you never blow a free-tier cap.

<br/>

[![CI](https://github.com/Hansade2005/FreeAIGateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Hansade2005/FreeAIGateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-freellmapi-2496ED?logo=docker&logoColor=white)](https://github.com/Hansade2005/FreeAIGateway/pkgs/container/freellmapi)
[![Node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](#quick-start)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

<br/>

[**Quick start**](#quick-start) · [**Providers**](#supported-providers) · [**API docs**](#using-the-api) · [**How it works**](#how-it-works) · [**Contributing**](#contributing)

<br/>

![Fallback chain with per-provider token budget](repo-assets/fallback-chain.png)

</div>

---

## Contents

| | | |
|---|---|---|
| [Why this exists](#why-this-exists) | [Quick start](#quick-start) | [How it works](#how-it-works) |
| [At a glance](#at-a-glance) | [Docker](#docker) | [Limitations](#limitations) |
| [Supported providers](#supported-providers) | [Desktop app](#desktop-app) | [Contributing](#contributing) |
| [Features](#features) | [Using the API](#using-the-api) | [Terms of Service review](#terms-of-service-review) |
| [Not yet supported](#not-yet-supported) | [Screenshots](#screenshots) | [Disclaimer](#disclaimer) |

---

## Why this exists

Every serious AI lab now ships a free tier — a few million tokens a month, a few thousand requests a day. On its own, each one is a toy. **Stacked together, they add up to roughly 1.7 billion tokens per month** of working inference, across 100+ models from small-and-fast to genuinely capable.

The catch is that stacking them by hand is miserable: sixteen SDKs, sixteen rate limits, sixteen places a request can fail. FreeAIGateway collapses all of that into **one gateway that speaks two protocols** — OpenAI (`/v1/chat/completions`, `/v1/responses`) **and** Anthropic Messages (`/v1/messages`). Point any compatible client at a single base URL, and the gateway routes transparently across whichever providers you've added keys for — with optional prompt caching and built-in web-search, web-extract, and image-generation tools layered on top.

> **TL;DR** — A drop-in, self-hosted, OpenAI **and** Anthropic-compatible proxy that turns 16 free tiers into one reliable endpoint with automatic failover, encrypted key storage, and a full admin dashboard.

---

## At a glance

| | |
|---|---|
| **Protocols** | OpenAI (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/images/generations`) · Anthropic Messages (`/v1/messages`) |
| **Providers** | 16 free tiers + any custom OpenAI-compatible endpoint |
| **Capacity** | ~1.7B tokens/month aggregate · 100+ models |
| **Routing** | Priority-based with health checks, rate-limit ledger, automatic failover (up to 20 attempts) |
| **Auth** | One unified `freellmapi-…` key for apps · email + password for the dashboard |
| **Security** | AES-256-GCM encrypted key storage in SQLite |
| **Footprint** | Node 20+ · multi-arch Docker (`amd64` + `arm64`, Raspberry Pi ready) · ~40 MB RSS at idle |
| **Extras** | Prompt cache · built-in agent tools · streaming · tool calling · vision input · embeddings |
| **License** | MIT |

---

## Supported providers

<table>
<tr>
<td align="center" width="180"><a href="https://ai.google.dev"><b>Google</b><br/>Gemini 2.5 Flash · 3.x previews</a></td>
<td align="center" width="180"><a href="https://groq.com"><b>Groq</b><br/>Llama 3.3, Llama 4, GPT-OSS, Qwen3</a></td>
<td align="center" width="180"><a href="https://cerebras.ai"><b>Cerebras</b><br/>Qwen3 235B</a></td>
<td align="center" width="180"><a href="https://cloud.sambanova.ai"><b>SambaNova</b><br/>DeepSeek V3.x · Llama 4 · Gemma 3</a></td>
</tr>
<tr>
<td align="center"><a href="https://mistral.ai"><b>Mistral</b><br/>Large 3 · Medium 3.5 · Codestral · Devstral</a></td>
<td align="center"><a href="https://openrouter.ai"><b>OpenRouter</b><br/>21 free-tier models</a></td>
<td align="center"><a href="https://github.com/marketplace/models"><b>GitHub Models</b><br/>GPT-4.1 · GPT-4o</a></td>
<td align="center"><a href="https://developers.cloudflare.com/workers-ai"><b>Cloudflare</b><br/>Kimi K2 · GLM-4.7 · GPT-OSS · Granite 4</a></td>
</tr>
<tr>
<td align="center"><a href="https://cohere.com"><b>Cohere</b><br/>Command R+ · Command-A (trial)</a></td>
<td align="center"><a href="https://docs.z.ai"><b>Z.ai (Zhipu)</b><br/>GLM-4.5 · GLM-4.7 Flash</a></td>
<td align="center"><a href="https://build.nvidia.com"><b>NVIDIA</b><br/>NIM (disabled by default)</a></td>
<td align="center"><a href="https://huggingface.co/docs/inference-providers"><b>HuggingFace</b><br/>Router → DeepSeek V4 · Kimi K2.6 · Qwen3</a></td>
</tr>
<tr>
<td align="center"><a href="https://ollama.com"><b>Ollama Cloud</b><br/>GLM-4.7 · Kimi K2 · gpt-oss · Qwen3</a></td>
<td align="center"><a href="https://kilo.ai"><b>Kilo Gateway</b><br/>:free routes (anon ok)</a></td>
<td align="center"><a href="https://pollinations.ai"><b>Pollinations</b><br/>GPT-OSS 20B (anon ok)</a></td>
<td align="center"><a href="https://llm7.io"><b>LLM7</b><br/>GPT-OSS · Llama 3.1 · GLM (anon ok)</a></td>
</tr>
</table>

> **➕ Custom provider** — point at any OpenAI-compatible endpoint (llama.cpp, LM Studio, vLLM, a local Ollama, or a remote gateway) directly from the **Keys** page.

---

## Features

#### 🔌 Compatibility

- **OpenAI-compatible** — `POST /v1/chat/completions` and `GET /v1/models` work with the official OpenAI SDKs and any OpenAI-compatible client (LangChain, LlamaIndex, Continue, Hermes, …). Just change `base_url`.
- **Anthropic-compatible** — `POST /v1/messages` (plus `POST /v1/messages/count_tokens`) speaks the native Claude Messages wire format, so Claude Code, the Anthropic SDKs, and any Messages-API client point straight at the gateway and get answered by any free provider behind it. Full SSE streaming (`message_start` → `content_block_delta` → `message_stop`), tool use (`tool_use` / `tool_result`), system prompts, and image blocks are translated over the same router. Authenticates via `x-api-key` or `Authorization: Bearer`. Unknown Claude model ids (e.g. `claude-sonnet-4-5`) transparently fall through to auto-routing.
- **Responses API** — `POST /v1/responses` (the wire format current Codex CLI versions require) is a translating shim over the same router, with full streaming events and tool calls.

#### 🧠 Routing & reliability

- **Automatic failover** — on a 429, 5xx, or timeout the router skips the provider, puts the key on a short cooldown, and retries the next model in your fallback chain (up to 20 attempts).
- **Per-key rate tracking** — RPM, RPD, TPM, and TPD counters per `(platform, model, key)`, so the router always picks a key that's under its caps.
- **Sticky sessions** — multi-turn conversations keep talking to the same model for 30 minutes, avoiding the hallucination spike from mid-conversation model switches.
- **Health checks** — periodic probes mark keys `healthy`, `rate_limited`, `invalid`, or `error` so dead keys are skipped automatically.

#### ⚡ Performance & cost

- **Prompt cache** — opt-in in-memory TTL cache. An identical request returns the stored completion with `X-Cache: HIT` and **no provider call** — saving free-tier quota and answering instantly. Works for streaming (replayed as SSE) and non-streaming; bypass per-request with `x-cache: no-store`. Live hit-rate/entries stats in the dashboard.
- **Streaming & non-streaming** — Server-Sent Events for `stream: true`, JSON otherwise. Every provider adapter implements both.

#### 🛠️ Capabilities

- **Built-in agent tools** — the gateway can run tools itself, turning auto-routed chat into a lightweight agent: **web_search** (live web via r.jina.ai over DuckDuckGo), **web_extract** (URL → clean markdown), and **generate_image** (text → PNG saved server-side and appended as an inline markdown image). On by default, individually toggleable in Settings; applied only to auto-routed, tool-free, non-streaming requests, and bypassable with `x-builtin-tools: off`.
- **Tool calling** — OpenAI-style `tools` / `tool_choice` requests pass through, and assistant `tool_calls` + `tool`-role follow-ups round-trip across providers.
- **Vision input** — standard OpenAI `image_url` blocks restrict routing to vision-capable models automatically.
- **Image generation** — `POST /v1/images/generations` (OpenAI Images shape) backed by a0.dev's keyless text-to-image endpoint. No provider key needed.
- **Embeddings** — `/v1/embeddings` with family-based routing: failover only happens between providers serving the *same* model, never across models.

#### 🔐 Security & operations

- **Encrypted key storage** — provider keys are AES-256-GCM encrypted before hitting SQLite; decryption happens in-memory just before a request.
- **Unified API key** — clients authenticate with a single `freellmapi-…` bearer token. Upstream provider keys are never exposed to your apps.
- **Dashboard login** — the admin UI and `/api/*` routes are gated behind an email + password account (scrypt-hashed, session-token auth), set on first run.
- **Admin dashboard** — React + Vite UI to manage keys, reorder the fallback chain, inspect analytics, and run prompts in a playground. Dark mode included.
- **Analytics** — per-request logging with latency, token counts, success rate, and per-provider breakdowns.
- **Runs anywhere Node 20+ runs** — Windows, macOS, Linux, or an ARM SBC (Raspberry Pi included). ~40 MB RSS at idle behind PM2 / systemd / any supervisor.

---

## Not yet supported

The scope is deliberately narrow. If a feature isn't listed above and isn't here, assume it isn't there yet — **PRs welcome** (see [Contributing](#contributing)).

- Audio / speech (`/v1/audio/*`)
- Legacy completions (`/v1/completions`) — only the chat endpoint is implemented
- Moderation (`/v1/moderations`)
- `n > 1` for chat — supported on `/v1/images/generations`, not on chat
- Per-user billing / multi-tenant auth — single-user by design

---

## Quick start

> **Recommended:** Docker Compose. Runs the API and dashboard together on port `3001` and persists SQLite in a named volume.
>
> **Prerequisites:** Docker, Docker Compose, OpenSSL.

```bash
git clone https://github.com/Hansade2005/FreeAIGateway.git
cd FreeAIGateway

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d
```

Open **http://localhost:3001**, add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI or Anthropic SDK at.

> **Reaching it from another machine?** By default the container is published only on `127.0.0.1`, so `http://<server-ip>:3001` won't load from another device. To expose it on your LAN — e.g. a Raspberry Pi at `http://192.168.1.x:3001` — start it with `HOST_BIND=0.0.0.0`:
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d
> ```
>
> Only do this on a trusted network: the proxy is single-user and guarded only by the unified API key.

<details>
<summary><b>Local development (Node.js)</b></summary>

<br/>

**Prerequisites:** Node.js 20+, npm.

```bash
git clone https://github.com/Hansade2005/FreeAIGateway.git
cd FreeAIGateway
npm install
cp .env.example .env
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
npm run dev
```

`ENCRYPTION_KEY` is required for startup. The server only falls back to a database-stored development key when `DEV_MODE=true` and `NODE_ENV` is not `production`; do not use that fallback with real provider keys.

Request analytics are retained for 90 days or 100,000 request rows by default, whichever prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or `REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either limit.

Open **http://localhost:5173** (the Vite dev UI) and configure as above.

</details>

<details>
<summary><b>Production build without Docker</b></summary>

<br/>

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

</details>

---

## Docker

FreeAIGateway publishes a single production image containing the Express server and the built React dashboard:

```bash
docker pull ghcr.io/Hansade2005/FreeAIGateway:latest   # or pin a release, e.g. :v1.2.3
```

The image is **multi-arch** (`linux/amd64` + `linux/arm64`, so it runs on a Raspberry Pi). Published tags: `latest` (default branch), `v*.*.*` (git release tags), and `sha-<commit>`.

The included `docker-compose.yml` is the recommended install path:

```bash
docker compose up -d
docker compose logs -f freellmapi
```

By default the container's port binds to `127.0.0.1` (localhost only). To reach the dashboard/API from another machine, publish on all interfaces with `HOST_BIND=0.0.0.0 docker compose up -d` — only on a trusted LAN, since the proxy is single-user.

SQLite data lives in the `freellmapi-data` volume at `/app/server/data`. Keep the same `.env` `ENCRYPTION_KEY` and volume when upgrading, because provider keys are encrypted at rest.

More Docker operations and examples live in [docker/README.md](./docker/README.md).

---

## Desktop app

A native menu-bar app lives in [`desktop/`](./desktop): the entire router + dashboard running locally from your tray, with a glass popover showing live request stats.

![FreeAIGateway desktop app](repo-assets/desktop.png)

No published binaries — it builds from this repo in a few minutes:

```bash
npm install
npm run desktop:dist        # macOS: desktop/dist-electron/FreeAIGateway-…-arm64.dmg
npm run desktop:dist:win    # Windows installer
```

> **Windows:** the build config is in place but not yet tested — a quick report (working or not) in an issue would be much appreciated.

Locally built apps launch without Gatekeeper/SmartScreen warnings — no code signing involved. Full instructions in [desktop/README.md](./desktop/README.md).

---

## Using the API

Any OpenAI-compatible client works — just change the `base_url`.

<details open>
<summary><b>OpenAI · Python</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="freellmapi-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or specify e.g. "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

</details>

<details>
<summary><b>OpenAI · curl</b></summary>

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

</details>

<details>
<summary><b>OpenAI · streaming</b></summary>

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

</details>

### Anthropic-compatible endpoint

The same server speaks the native Anthropic Messages wire format at `POST /v1/messages`, so Claude-native clients work unchanged — just point the base URL at the gateway. The router still picks whichever free provider is available; the `model` field is accepted but real Claude ids fall through to auto-routing.

<details open>
<summary><b>Anthropic Python SDK</b></summary>

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3001",
    api_key="freellmapi-your-unified-key",
)

msg = client.messages.create(
    model="claude-sonnet-4-5",  # accepted; routed to a free model
    max_tokens=256,
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(msg.content[0].text)
```

</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
export ANTHROPIC_BASE_URL="http://localhost:3001"
export ANTHROPIC_API_KEY="freellmapi-your-unified-key"
claude
```

</details>

<details>
<summary><b>Anthropic · curl</b></summary>

```bash
curl http://localhost:3001/v1/messages \
  -H "x-api-key: freellmapi-your-unified-key" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

</details>

Streaming (`"stream": true`) emits the full Anthropic SSE sequence — `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` — and tool use round-trips via `tool_use` / `tool_result` blocks. `POST /v1/messages/count_tokens` returns an `input_tokens` estimate for context sizing.

### Image generation

```bash
curl http://localhost:3001/v1/images/generations \
  -H "Authorization: Bearer freellmapi-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "a neon city skyline at dusk", "size": "1792x1024" }'
# → { "data": [{ "url": "https://api.a0.dev/assets/image?text=...&aspect=16:9" }] }
```

Works with the OpenAI Images SDK (`client.images.generate(...)`). `size` maps to an aspect ratio, or pass `"aspect": "16:9" | "9:16" | "1:1"` directly; `"response_format": "b64_json"` inlines the bytes.

### Tool calling

Pass OpenAI-style `tools` and `tool_choice`; the assistant response round-trips back through the proxy exactly like the OpenAI API. Multi-step flows (assistant `tool_calls` → `tool`-role follow-up → final answer) work across every provider the router can reach.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1. Model asks for a tool call
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. You execute the tool, feed the result back
final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)
print(final.choices[0].message.content)
```

Works with `stream=True` too — you'll get `delta.tool_calls` chunks followed by a `finish_reason: "tool_calls"` close. Under the hood, OpenAI-compatible providers get the request passed through; Gemini requests are translated into Google's `functionDeclarations` / `functionResponse` shape and back.

### Vision / image input

Send images with standard OpenAI `image_url` content blocks (base64 `data:` URLs or `http(s)` URLs). When a request contains an image, the router restricts itself to **vision-capable models** and ignores text-only ones (tagged with a **Vision** badge on the Fallback Chain page — currently Gemini 2.5/3.x, Llama 4 Scout/Maverick on Groq/NVIDIA/SambaNova, and GitHub's GPT-4o / GPT-4.1).

```python
resp = client.chat.completions.create(
    model="auto",  # auto-routes to a vision model
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

If no vision-capable model is enabled, an image request returns a clear `422` (`code: "no_vision_model"`) rather than silently dropping the image. (Image input on `/v1/responses` isn't supported yet — use `/v1/chat/completions`.)

> Every response carries an `X-Routed-Via: <platform>/<model>` header so you can see which provider served each call. If a request fell over between providers, you'll also see `X-Fallback-Attempts: N`.

### Embeddings

`/v1/embeddings` is OpenAI-compatible with one deliberate difference: **failover never crosses models.** Vectors from different models live in incompatible spaces — silently switching models would corrupt any vector store built on top. So embeddings route by **family** (one model identity + dimension), and failover only walks the providers serving that same family.

```python
resp = client.embeddings.create(
    model="auto",          # default family; or a family name like "bge-m3"
    input=["the quick brown fox", "pack my box with five dozen liquor jugs"],
)
print(len(resp.data), "vectors of", len(resp.data[0].embedding), "dims")
```

| Family (`model`) | Dims | Providers (failover order) |
| --- | --- | --- |
| `gemini-embedding-001` *(default)* | 3072 | Google |
| `text-embedding-3-large` | 3072 | GitHub Models |
| `text-embedding-3-small` | 1536 | GitHub Models |
| `embed-v4.0` | 1536 | Cohere |
| `bge-m3` | 1024 | Cloudflare → Hugging Face |
| `qwen3-embedding-0.6b` | 1024 | Cloudflare |
| `nv-embedqa-e5-v5` | 1024 | NVIDIA |
| `llama-nemotron-embed-1b-v2` | 2048 | NVIDIA |
| `llama-nemotron-embed-vl-1b-v2` | 2048 | NVIDIA → OpenRouter |
| `embeddinggemma-300m` | 768 | Cloudflare |

`model` accepts `auto` (configured default), a family name, or a provider-specific model id (resolved to its family). Defaults and per-provider priorities live on the dashboard's **Models → Embeddings** page. Pick a family once and stick with it for a given vector store — that's the whole point.

---

## Screenshots

<table>
<tr>
<td width="50%" valign="top">

**Models & routing** — tune the routing strategy or drag a manual fallback order, watch live reliability / speed / intelligence scores, and track the per-provider monthly token budget.

![Models and fallback chain](repo-assets/fallback-chain.png)

</td>
<td width="50%" valign="top">

**Settings** — your unified key, the OpenAI **and** Anthropic endpoints, the prompt cache (toggle / TTL / live stats), and the built-in tools, all in one place.

![Settings page](repo-assets/settings.png)

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Playground** — a pro console: switch between OpenAI and Anthropic protocols, stream responses, compare models side by side, generate images, and read per-turn route / cache / latency / token badges.

![Playground page](repo-assets/playground.png)

</td>
<td width="50%" valign="top">

**Analytics** — request volume, success rate, tokens, estimated savings, latency percentiles (p50/p95/p99 + TTFB), prompt-cache hit-rate, per-model breakdown, and a live request log.

![Analytics page](repo-assets/analytics.png)

</td>
</tr>
</table>

---

## How it works

```
┌──────────────────┐   Bearer / x-api-key    ┌─────────────────────────┐
│  OpenAI SDK or   │ ──────────────────────▶ │  Express proxy (:3001)  │
│  Anthropic SDK / │                         │  /v1/chat/completions   │
│  Claude Code /   │ ◀────────────────────── │  /v1/responses          │
│  curl / any      │      streamed tokens    │  /v1/messages           │
└──────────────────┘                         └────────────┬────────────┘
                                                          │
                                          (Anthropic & Responses requests are
                                           translated to the internal chat
                                           format, then share the router below)
                                                          ▼
                             ┌────────────────────────────────────────────────┐
                             │  Router                                        │
                             │   1. Pick highest-priority model that          │
                             │      (a) has a healthy key and                 │
                             │      (b) is under all its rate limits.         │
                             │   2. Decrypt key, call provider SDK.           │
                             │   3. On 429/5xx → cooldown + retry next model. │
                             └────────────────────────────────────────────────┘
                                          │
   ┌──────────────┬────────────┬──────────┴─────────┬─────────────┬──────────┐
   ▼              ▼            ▼                    ▼             ▼          ▼
 Google         Groq        Cerebras           OpenRouter        HF       …10 more
```

| Component | Path | Role |
|---|---|---|
| **Router** | `server/src/services/router.ts` | Picks a model per request |
| **Rate-limit ledger** | `server/src/services/ratelimit.ts` | In-memory RPM/RPD/TPM/TPD counters backed by SQLite, with cooldowns on 429s |
| **Provider adapters** | `server/src/providers/*.ts` | One file per provider implementing `chatCompletion()` and `streamChatCompletion()` |
| **Health service** | `server/src/services/health.ts` | Periodic probe keeps key status fresh |
| **Dashboard** | `client/` | React + Vite + shadcn/ui admin surface |
| **Storage** | SQLite (`better-sqlite3`) | AES-256-GCM envelope encryption for keys |

---

## Limitations

Stacking free tiers has real trade-offs. Be honest with yourself about them:

- **No frontier models.** The free-tier catalog tops out around Llama 3.3 70B, GLM-4.5, Qwen 3 Coder, and Gemini 2.5 Pro. You will not get GPT-5 or Claude Opus-class reasoning through this. For hard problems, pay for a real API.
- **Intelligence degrades through the day.** Your top-ranked models have the lowest daily caps; once they hit them, the router falls down the chain to smaller models. Expect effective intelligence to drop in the late hours of each day, then reset at UTC midnight.
- **Latency is highly variable.** Cerebras and Groq are extremely fast; others are not. You get whichever one is available.
- **Free tiers change without notice.** Providers tighten, loosen, or remove free tiers regularly. When that happens you'll see 429s or auth errors until you update the catalog. Re-seed scripts live in `server/src/scripts/`.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract.
- **Local-first.** No multi-tenant auth. Run this for yourself; don't expose it to the internet.

---

## Contributing

Contributors very welcome! Good first PRs:

- **Add a provider** — copy `server/src/providers/openai-compat.ts` as a template, wire it into `server/src/providers/index.ts`, seed its models in `server/src/db/index.ts`, add a test in `server/src/__tests__/providers/`.
- **Add an endpoint** — images, moderations, audio. The provider base class can grow new methods; adapters declare which they support.
- **Improve the router** — cost-aware routing, latency-weighted priority, regional pinning.
- **Dashboard polish** — Analytics charts, key rotation UX, batch import of keys from `.env`.
- **Docs** — more examples, client snippets for Go/Rust, deployment recipes.

**Development loop:**

```bash
npm install
npm run dev      # server on :3001, dashboard on :5173, both with HMR
npm test         # server vitest; also runs client tests if the workspace adds them
npm run build    # compile server and dashboard
```

PRs should include a test, keep the suite green, and match the `.editorconfig` / tsconfig defaults already in the repo. Issues and discussions are open.

### Contributors

<a href="https://github.com/moaaz12-web"><img src="https://images.weserv.nl/?url=github.com/moaaz12-web.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@moaaz12-web" /></a>
<a href="https://github.com/lukasulc"><img src="https://images.weserv.nl/?url=github.com/lukasulc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@lukasulc" /></a>
<a href="https://github.com/VinhPhamAI"><img src="https://images.weserv.nl/?url=github.com/VinhPhamAI.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@VinhPhamAI" /></a>
<a href="https://github.com/deadc"><img src="https://images.weserv.nl/?url=github.com/deadc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@deadc" /></a>
<a href="https://github.com/zhangyu1324"><img src="https://images.weserv.nl/?url=github.com/zhangyu1324.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@zhangyu1324" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/hodlmybeer69-bit"><img src="https://images.weserv.nl/?url=github.com/hodlmybeer69-bit.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@hodlmybeer69-bit" /></a>
<a href="https://github.com/phoenixikkifullstack"><img src="https://images.weserv.nl/?url=github.com/phoenixikkifullstack.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@phoenixikkifullstack" /></a>
<a href="https://github.com/jtbrennan-git"><img src="https://images.weserv.nl/?url=github.com/jtbrennan-git.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jtbrennan-git" /></a>
<a href="https://github.com/praveenkumarpranjal"><img src="https://images.weserv.nl/?url=github.com/praveenkumarpranjal.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@praveenkumarpranjal" /></a>
<a href="https://github.com/nordbyte"><img src="https://images.weserv.nl/?url=github.com/nordbyte.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nordbyte" /></a>
<a href="https://github.com/mybropro"><img src="https://images.weserv.nl/?url=github.com/mybropro.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@mybropro" /></a>
<a href="https://github.com/danscMax"><img src="https://images.weserv.nl/?url=github.com/danscMax.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@danscMax" /></a>
<a href="https://github.com/jhash"><img src="https://images.weserv.nl/?url=github.com/jhash.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jhash" /></a>
<a href="https://github.com/JammyJames1234"><img src="https://images.weserv.nl/?url=github.com/JammyJames1234.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@JammyJames1234" /></a>
<a href="https://github.com/Sumit4codes"><img src="https://images.weserv.nl/?url=github.com/Sumit4codes.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Sumit4codes" /></a>
<a href="https://github.com/meliani"><img src="https://images.weserv.nl/?url=github.com/meliani.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@meliani" /></a>
<a href="https://github.com/thedavidweng"><img src="https://images.weserv.nl/?url=github.com/thedavidweng.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@thedavidweng" /></a>
<a href="https://github.com/bharvey42"><img src="https://images.weserv.nl/?url=github.com/bharvey42.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@bharvey42" /></a>
<a href="https://github.com/yuvrxj-afk"><img src="https://images.weserv.nl/?url=github.com/yuvrxj-afk.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@yuvrxj-afk" /></a>
<a href="https://github.com/Tushar49"><img src="https://images.weserv.nl/?url=github.com/Tushar49.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tushar49" /></a>
<a href="https://github.com/nicyoong"><img src="https://images.weserv.nl/?url=github.com/nicyoong.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nicyoong" /></a>
<a href="https://github.com/Aldo-f"><img src="https://images.weserv.nl/?url=github.com/Aldo-f.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Aldo-f" /></a>
<a href="https://github.com/m1nuzz"><img src="https://images.weserv.nl/?url=github.com/m1nuzz.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@m1nuzz" /></a>
<a href="https://github.com/LoneRifle"><img src="https://images.weserv.nl/?url=github.com/LoneRifle.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@LoneRifle" /></a>

---

## Terms of Service review

A self-hosted, single-user, personal-use setup was re-reviewed against each provider's ToS (**May 2026**). Summary:

| Provider | Verdict | Notes |
|---|---|---|
| Google Gemini | ⚠️ Caution | March 2026 ToS narrows scope to *"professional or business purposes, not for consumer use"* — a self-hosted dev proxy is still defensible, but the clause is new. |
| Groq | ✅ Likely OK | GroqCloud Services Agreement permits Customer Application integration. |
| Cerebras | ✅ Likely OK | Permitted; explicitly forbids selling/transferring API keys. |
| Mistral | ✅ Likely OK | APIs allowed for personal/internal business use. |
| OpenRouter | ✅ Likely OK | April 2026 ToS sharpens the no-resale clause; private single-user proxy still fine. |
| SambaNova | ⚠️ Ambiguous | EULA §1.5(c) blocks resale and "service bureau" use; single-user with no third-party access is fine. |
| Cloudflare Workers AI | ⚠️ Ambiguous | No anti-proxy clause; covered by general Self-Serve Subscription Agreement. |
| NVIDIA NIM | ⚠️ Caution | Trial ToS §1.2 / §1.4: *"evaluation only, not production."* Disabled in default catalog. |
| GitHub Models | ⚠️ Caution | Free tier explicitly scoped to *"experimentation"* and *"prototyping."* |
| Cohere | ❌ Avoid | Terms §14 still forbids *"personal, family or household purposes."* |
| Zhipu (open.bigmodel.cn) | ✅ Likely OK | Personal/non-commercial research carve-out still in the platform docs. |
| Z.ai (api.z.ai) | ⚠️ Caution | Singapore entity (distinct from Zhipu CN). §III.3(l) anti-traffic-redirect clause could be read against a proxy; no explicit personal-use carve-out. |
| Ollama Cloud | ✅ Likely OK | Free plan permits cloud-model access (1 concurrent, 5-hour session caps). No anti-proxy / anti-resale clauses found. *(Integration tracked in #14.)* |

**Rules of thumb that keep most providers happy:** one account per provider · no reselling · no sharing your endpoint with other humans · don't hammer a free tier as a paid production backend. *This is informational, not legal advice — read each provider's ToS and make your own call.*

> Removed since the April 2026 review: Hugging Face, Moonshot, and MiniMax direct integrations were dropped (HF — tool-call format issues; Moonshot — paid only; MiniMax — superseded by the OpenRouter `minimax/minimax-m2.5:free` route).

---

## Disclaimer

**This project is for personal experimentation and learning, not production.** Free tiers exist so developers can prototype against them; they aren't a stable, supported inference substrate. If you build something real on top of FreeAIGateway, swap in a paid API before you ship. Your relationship with each upstream provider is governed by the terms you accepted when you created your account — those terms still apply when traffic is proxied through this project, and you're responsible for complying with them.

---

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=Hansade2005/FreeAIGateway&type=date&legend=top-left)](https://www.star-history.com/?repos=Hansade2005%2FFreeAIGateway&type=date&legend=top-left)

---

## License

[MIT](./LICENSE) © [Hans Ade](https://github.com/Hansade2005)

<div align="center">

<br/>

**If FreeAIGateway saves you a few API bills, consider leaving a ⭐ — it genuinely helps.**

</div>
