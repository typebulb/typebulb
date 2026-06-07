# typebulb

**Typebulb** runs apps in markdown files called **bulbs**. To run bulbs:

* `npx typebulb`. When you want a quick local app or tool where the overhead of an entire npm project is overkill *(trivial for your LLM to convert to when you actually need to)*. Can be entirely client code, or both client and nodejs code that talk via a secure bridge.
* `npx typebulb agent:claude`. When you want to view Claude Code conversations with embedded bulbs in the agent messages.
* **[typebulb.com](https://typebulb.com)**. When you want to share tools, visualizations, experiments etc. See [FAQ](https://typebulb.com/faq).

The `typebulb` CLI enables the first two cases, by compiling and serving hot-reloadable bulbs locally.

A `.bulb.md` file bundles code, styles, data, and config in one file.

>This document doubles as a skill: it is written so an LLM agent can read it and successfully write and run bulbs with the typebulb CLI.

## Features

- **Server-side code** — Add a `**server.ts**` section; exported functions become callable from the browser via `tb.server.<name>()` (e.g., `export async function query(...)` → `await tb.server.query(...)`). Requires `--trust`.
- **CLI logging** — `tb.server.log(...)` prints to the CLI's stdout
- **Env files** — `.env` / `.env.local` load from cwd, `.env.local` overriding `.env` (an exported shell var wins over both). `--mode <name>` adds `.env.<name>` to switch environments (local/staging/prod); a startup line reports which keys loaded from where.
- **Server mode** — `--server` runs only the `**server.ts**` section in Node, skipping the web server. Bulbs with only `**server.ts**` (no `**code.tsx**`) use this mode automatically.
- **Type-check without running** — `typebulb check <file>` runs `tsc --noEmit` against the bulb and exits non-zero on errors. Useful for AI editors / CI.
- **Filesystem access** — `tb.fs.read()` (UTF-8 text), `tb.fs.readBytes()` (raw `Uint8Array`), and `tb.fs.write()` (text or bytes) for local files. Requires `--trust`.
- **Hot reload** — Recompiles on save and refreshes the browser (on by default; disable with `--no-watch`)
- **Package resolution** — Client dependencies are automatically resolved by generating import maps (same resolver as typebulb.com). Server dependencies are automatically installed via npm.
- **Replace dependency** — `--replace <name>=<path>` replaces a declared dependency with a local *built* package folder (browser-ready ESM, no external bare imports) instead of a CDN, for testing an unpublished build. Supplies both runtime bytes and types; applies to `run` and `check`. Under `--watch` the folder is watched and the browser reloads on rebuild (`--no-watch` freezes it). Dev-only; nothing is written to the bulb.
- **Local caching** — Resolver metadata and CDN package bytes are cached under `~/.typebulb/cache/`, so repeat runs don't re-hit the network and warm runs work offline.
- **AI calls** — `tb.ai()` for general-purpose AI (chatbots, agents, experiments). `tb.models()` lists available models. Set API keys in `.env` (see below). Requires `--trust`.
- **Sandboxed by default** — A plain `npx typebulb my-app.bulb.md` runs with no filesystem or `server.ts` (like typebulb.com); `--trust` grants those for a run. Trust is **remembered**: `typebulb trust <file>` elevates a bulb once so later plain runs are trusted, `untrust` revokes it, and `--no-trust` forces sandboxed for a single run.
- **Predict trust** — `typebulb predict <file>` reports the capability a bulb will likely need (fs / AI / `server.ts`) without running it, so you can decide on `--trust` up front rather than after a mid-run permission failure.
- **Agent viewer** — `typebulb agent:claude` opens the agent viewer, a browser view over a Claude Code session that renders embedded bulbs, KaTeX, and mermaid live inline, plus runs/stops local bulbs (see [Claude](#claude)). `typebulb agent` (no target) is the first command an agent runs: it tells the agent how to show a bulb inline or build one locally. `typebulb skill` prints this whole README as an Agent Skill the agent can read and save.

## Quick Start

A bulb is a markdown file with named code blocks:

````markdown
---
format: typebulb/v1
name: Counter
---

**code.tsx**

```tsx
import React, { useState } from "react"
import { createRoot } from "react-dom/client"

function App() {
  const [n, setN] = useState(0)
  return (
    <div className="card">
      <h1>Count: {n}</h1>
      <button onClick={() => setN(n + 1)}>increment</button>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<App />)
```

**index.html**

```html
<div id="root"></div>
```

**styles.css**

```css
.card {
  max-width: 360px;
  margin: 0 auto;          /* horizontal centering only */
  padding: 24px 16px;      /* vertical space as padding, never margin (see Sizing) */
  font: 14px system-ui, sans-serif;
  display: grid;
  gap: 12px;
  text-align: center;
}
h1 { font-size: 20px; margin: 0; }
button {
  font: inherit;
  padding: 6px 14px;
  border: 1px solid currentColor;   /* theme-aware: inherits light/dark */
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
```

**config.json**

```json
{
  "description": "A button that increments a counter.",
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  }
}
```
````

Run it:

```
npx typebulb my-app.bulb.md
```

Or install globally:

```
npm install -g typebulb
```

## Usage

```
typebulb [file.bulb.md]        Run a bulb (defaults to .bulb.md in cwd)
typebulb agent:claude          Open the agent viewer (a Claude Code session)
typebulb agent                 Start here — how to show a bulb inline or build one locally
                               (prints the viewer URL when one is up); always exits 0
typebulb skill                 Print this README as an Agent Skill on stdout
typebulb check [file.bulb.md]  Type-check a bulb without running it
typebulb predict [file]        Report the capability a bulb probably needs, without running it
typebulb models                List AI models for tb.ai, filtered by your .env API keys
typebulb logs [file|pid]       Print a running bulb's captured console (no arg: list running servers; -f follow, -n N tail)
typebulb stop [file|pid]       Stop a running bulb (no arg: list this project's running servers)
typebulb stop --bulbs          Stop this project's bulbs; the agent viewer keeps running
typebulb stop --agent          Stop this project's agent viewer; its bulbs keep running
typebulb stop --global         Stop every running bulb and viewer, all projects (housekeeping)
typebulb trust [file]          Remember a bulb as trusted (no arg: list trusted bulbs)
typebulb untrust <file>        Forget a bulb's trust (back to sandboxed)
typebulb --no-watch <file>     Disable hot reload
typebulb --port 3333 <file>    Custom port
typebulb --no-open <file>      Don't auto-open browser
typebulb --mode <name> <file>  Also load .env.<name> on top of .env / .env.local
typebulb --trust <file>        Grant filesystem + AI + server.ts for this run (default: sandboxed)
typebulb --no-trust <file>     Force sandboxed even if the bulb is remembered-trusted
typebulb --server <file>       Run server.ts only, no web server (needs --trust)
typebulb --replace <name>=<path> Replace a dependency with a local build
typebulb --help                Show help
typebulb --version             Show version
```

## AI API Setup

Bulbs can call AI providers via `tb.ai()`. Add API keys to your `.env` file:

| Provider name | API key env var |
|---------------|-----------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GOOGLE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |

Set your default provider and model:

```
TB_AI_PROVIDER=anthropic
TB_AI_MODEL=claude-haiku-4-5-20251001
```

Both can be overridden per-call: `tb.ai({ provider: "gemini", model: "gemini-3.1-flash-lite", ... })`.

Run `typebulb models` to list the available model ids instead of guessing one.

### Reasoning

`tb.ai()` accepts an optional `reasoning` parameter (0–3) that hints at how much extended thinking the model should use:

| Level | Label | Effect |
|-------|-------|--------|
| 0 | Min | No extended reasoning (default) |
| 1 | Low | Light reasoning |
| 2 | Med | Moderate reasoning |
| 3 | Max | Maximum reasoning |

```typescript
const { text } = await tb.ai({
  messages: [{ role: "user", content: "Explain quantum tunneling" }],
  reasoning: 2,
});
```

Provider support varies — the level is mapped to provider-specific parameters (e.g. Anthropic's adaptive thinking, OpenAI's reasoning effort).

## Blocks

A bulb is a single **markdown** file — the minimum viable structure for a small sandboxed app. Its named **blocks** hold the code, plus optional styles, data, and config. Every block except `code.tsx` is optional. Mechanically, each block is a `**name**` header on its own line followed by a fenced code block, and the file opens with YAML frontmatter (`format: typebulb/v1`, `name:`).

| Block | Purpose |
|-------|---------|
| `**code.tsx**` | **Required.** App logic and UI (TypeScript/TSX). |
| `**index.html**` | The mount container. Include it — nearly every bulb does (e.g. `<div id="root"></div>`). Only pure console apps omit it. |
| `**styles.css**` | CSS. |
| `**config.json**` | `dependencies` and a `description`. |
| `**data.txt**` | Read-only data your code processes via `tb.data(n)` (raw string) / `tb.json(n)` (parsed) — JSON, CSV, XML, YAML, or plain text. Multiple chunks are separated by **two blank lines**. |
| `**infer.md**` / `**insight.json**` | Runtime one-shot LLM call via `tb.infer()` — a typebulb.com feature; not supported locally. |
| `**notes.md**` | Persistent context for the AI assistant, carried across conversations and clones. Not run. |
| `**server.ts**` | Node.js code; its exports become `tb.server.<name>()` in the browser. **Local only.** |

## The `tb.*` API, by target

`tb` is a pre-declared global your code can use without importing. What each call does, and where it works:

| API | What it does | Local | Embedded |
|-----|--------------|:-----:|:--------:|
| `tb.data(n)` / `tb.json(n)` | Read data chunk `n` from the `data.txt` block — raw string, or parsed JSON | ✅ | ✅ |
| `tb.insight()` | Read the `insight.json` block as JSON | ✅ | ✅ |
| `tb.theme` | Get/set the light/dark override; `undefined` follows the OS | ✅ | ✅ |
| `tb.mode` | Runtime mode — `'local'` (CLI) or `'embedded'` (sandboxed iframe); `'editor'`/`'published'` on typebulb.com | ✅ | ✅ |
| `tb.proxy(url)` | Rewrite a CDN URL to load through the host origin (Web Worker / WASM) | ✅ | ✅ |
| `tb.dump(...)` | Log values (incl. lazy / device-backed tensors) to the browser console | ✅ | ✅ |
| `tb.copy(text)` | Copy text to the clipboard | ✅ | ✅ |
| `tb.url()` | Get the bulb URL (the served localhost URL, locally) | ✅ | ✅ |
| `tb.models()` | List available AI models (for dynamic model selectors); returns `[]` when embedded (no host AI) | ✅ | ✅ |
| `tb.fs.read/readBytes/write` | Read and write local files | ✅ `--trust` | ❌ |
| `tb.server.<name>(...)` | Call a function exported from the `server.ts` block | ✅ `--trust` | ❌ |
| `tb.ai({ messages, … })` | General-purpose AI call (chat, agents) | ✅ `--trust` | ❌ |
| `tb.infer()` | One-shot LLM call driven by the `infer.md` block | ❌ | ❌ |

- **❌ (embedded):** the call throws `"not available in an embedded bulb"` — an embed is a client-only sandboxed iframe with **no persistent storage** either (`localStorage`, `IndexedDB`, cookies, same-origin Workers all fail), so keep state in memory. `tb.mode === 'embedded'` lets a bulb detect this and self-adjust.

## Portability back to typebulb.com

A local `.bulb.md` can be re-imported into typebulb.com. If it has a `**server.ts**` block you'll be warned on import, since `server.ts` is only meaningful locally.

## Claude

The agent viewer currently supports Claude Code only. `npx typebulb agent:claude` gives the user a great scratchpad experience:

* a view over the Claude Code session, where assistant messages containing bulbs render as sandboxed embedded bulbs inline in the conversation, alongside KaTeX math, mermaid diagrams and svg.
* run and stop any bulb in their project.
* promote any embedded bulb to a `.bulb.md` file in the `typebulbs/` folder.

It opens a browser window outside VS Code, so start it yourself with `npx typebulb agent:claude --no-open` and give the user the localhost link to open in VS Code — don't wait for the user to run it.

To keep this skill on hand across sessions, run `npx typebulb skill` and copy its output into your skills folder (for Claude Code, `.claude/skills/typebulb/SKILL.md`) — only if the user asks.

### When Claude should output local vs embedded bulbs

- **First, can it even embed?** A bulb needing `tb.ai`, `tb.fs`, or `server.ts` must be **local** — embeds are client-only, so those calls fail there. The choice below is only for client-only bulbs.
- **Is anyone watching?** An embed only renders live when the agent viewer is open; with none it shows as raw text. `typebulb agent` tells you which case you're in. If no viewer is up and you want to show something inline, start it yourself — `npx typebulb agent:claude --no-open` — and share the link; don't make the user do it.
- **Something to see right now, in the flow of the conversation** — a chart of some numbers, a quick simulation, an illustrative widget. → **embedded**: emit it in a `bulb` block so it renders live inline.
- **A tool worth keeping** — something to reuse, run on its own, or refine over several turns. → **local**: write a `.bulb.md` file run with `npx typebulb`. An embedded block is throwaway and can't be edited in place, so it's the wrong fit for anything iterative.

### Emitting an embedded bulb

To render a bulb live inline, wrap the **entire** bulb — frontmatter and all blocks — in a fenced code block whose opening line is **four backticks immediately followed by `bulb`**, and whose closing line is four backticks. Four, not three, so the bulb's own triple-backtick code fences nest inside without prematurely closing the outer block.

The agent viewer turns that block into a live, sandboxed app, with a *breakout ↗* control that saves it as a `.bulb.md` in the `typebulbs/` folder — editable with hot reload, and sandboxed unless you trust it. Embedded bulbs are client-only — no `server.ts`, no `tb.fs`/`tb.ai`, no storage.

**Fixing a broken embed?** Re-emit it under the *same* `name:` — the viewer folds the old version into a stub and keeps your fix as the live one. (A rename is treated as a new bulb.)

**A broken embed reads back.** Emit it and move on; embeds usually just work. If the user says one broke, the viewer has already forwarded its compile/runtime error to `typebulb logs claude`, name-tagged (`[embed <name>]`) — pull it from there and fix, instead of asking the user to copy-paste.

## Sizing

The host owns a bulb's **width**; you own its **height**.

**Width is the host's.** Standalone, a bulb fills its browser window; in the agent viewer, an embed fits the conversation column by default, with a per-embed *spread* toggle to the full transcript width — and a cap so a tall embed doesn't run away down the transcript. Don't set a width or guess how much room you'll get.

**Height follows your content.** Prose, a form, a chart flow to their natural height — set none. A full-bleed canvas has no natural height: give its root `height: 100dvh` **and** a pixel floor like `min-height: 420px`. Both are needed — `100dvh` fills its own window if the bulb is broken out, and the floor holds a definite band when embedded. Without the floor a bare `100dvh` collapses to zero embedded, because the viewer sizes an embed to its content height and `100dvh` gives it nothing to measure against.

**When embedded, keep vertical space on the root in `padding`, not `margin`.** The viewer measures an embed by `document.body.scrollHeight`, and the runtime makes `body` a block formatting context so a root child's vertical margin (yours, or a UA default like `<h1>`'s) is contained rather than escaping the measurement — so you no longer have to get this exactly right. It's still cleaner to keep the horizontal `auto` for centering and move the vertical space to padding:

```css
.wrap { margin: 0 auto; padding: 24px 16px; }   /* not: margin: 24px auto */
```

## Tips for Agents

- **`config.json` `description`** is the bulb's SEO meta description — keep it to one or two plain sentences (~150–160 chars), or it gets truncated.
- **The frontmatter `name:` is the bulb's title** — a few words, not a sentence — and the filename should be its slug (`name: Counter` → `counter.bulb.md`).
- **Self-testing a local bulb** — To confirm a bulb works, run it, instrument with `tb.server.log(...)` (prints to the server's stdout, captured in the log — and works **even on a sandboxed bulb**), and read it back with `typebulb logs`. That's the loop to verify behaviour without asking the user to copy-paste console output. `tb.fs.write(...)` is handy for dumping large outputs.
- **Mount to the container your `index.html` declares.** The corpus convention is `<div id="root"></div>` with `createRoot(document.getElementById("root")!)`.
- **All imports at the top of `code.tsx`.** Bare imports (`react`, `d3`, `three`, …) auto-resolve from a CDN — no install step. Declare them in `config.json` `dependencies` anyway: that's what lets `npx typebulb check` fetch type defs (without it you get errors like `TS2875: react/jsx-runtime`) and pins versions.
- **Theme-aware styling.** Style off CSS variables / `currentColor` so the bulb reads correctly in both light and dark; the host sets the theme.
- **`tb.ai()` takes more than the basics** — the full shape is `tb.ai({ messages, system?, reasoning?, provider?, model?, webSearch? })` → `Promise<{ text }>` (non-streaming). `webSearch` defaults **on** in the CLI (you supply your own key); pass `webSearch: false` to turn it off.
- **`tb.theme` drives the `html[data-theme]` attribute** — style off that selector (`html[data-theme="dark"] { … }`); don't read `tb.theme` to branch your rendering.
- **`color-scheme` is set for you** — the host always applies `html[data-theme="dark"] { color-scheme: dark }` / `html[data-theme="light"] { color-scheme: light }` on top of your `styles.css`.
- **Math renders live in the viewer** — write inline math as `$…$` and display math as `$$…$$` (the viewer renders KaTeX; a plain terminal chat doesn't, so reach for real math here). Prefer `$y = x^2$` over inline-code or a Unicode superscript (`y = x²`).
- **`tb.json<T>(n)` is generic** — `tb.json<Album[]>(0)` returns typed parsed JSON; `tb.data(n)` returns the raw string.
- **`tb.proxy()` is for same-origin Web Worker / WASM loads** — e.g. ffmpeg or tesseract: `tb.proxy("https://unpkg.com/...")` routes the CDN URL through the local server's origin.
- **Prefer an `index.html` fragment** over a full HTML document — usually just the mount stub (`<div id="root"></div>`).
- **`config.json` → `ts.jsxImportSource`** — the one supported `ts` option; defaults to `react`. Set it to use a different JSX runtime (e.g. `preact`).
- **Never invent a connection string or API key** — a `server.ts` that needs a database or API reads it from `.env` (loaded from the directory you run in). Ask the user for the value; don't fabricate one or commit it.

## License

MIT
