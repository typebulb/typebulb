# typebulb

**Typebulb** runs apps in markdown files called **bulbs**. Perfect for tools, visualizations & experiments. A bulb is a single self-contained file, so an agent can inline a working app right into its reply, and the same file can be published as a stand-alone web app. The *"markdown with code blocks"* format is one LLMs find natural to write.

Two ways to create and run bulbs:

* **typebulb CLI**: Lets a coding agent (Claude Code, Codex, or Pi) build and run bulbs locally. Local bulbs can also call Node.js via a secure bridge.
* **typebulb.com**: Share and publish bulbs. Also the quickest way to test AI models (BYOK) with zero setup. See [FAQ](https://typebulb.com/faq).

One API runs everywhere: the same bulb works locally and in typebulb.com's sandbox, and can call AI models at runtime.

This document is dedicated to the typebulb CLI. At its core, it compiles and serves hot-reloadable bulbs locally. A `.bulb.md` file bundles code, styles, data, and config in one file.

>This document doubles as a skill: it is written so an LLM agent can read it and successfully write and run bulbs with the typebulb CLI.

## Features

- **Server-side code** — Add a `**server.ts**` section; exported functions become callable from the browser via `tb.server.<name>()` (e.g., `export async function query(...)` → `await tb.server.query(...)`). An `export async function*` **streams**: consume it with `for await (const chunk of tb.server.gen())`. Requires `--trust`.
- **CLI logging** — `tb.log(...)` prints to the CLI's stdout, from `code.tsx` and `server.ts` alike (no trust needed)
- **Wake-on-event** — `typebulb wait <file|agent>` blocks until the target server logs a new line, prints it, and exits. Run in the background, that exit *is* an agent's wake-up: a user action a bulb logs, or an inline bulb's render outcome — no polling.
- **Env files** — `.env` / `.env.local` load from cwd, `.env.local` overriding `.env` (an exported shell var wins over both). `--mode <name>` adds `.env.<name>` to switch environments (local/staging/prod); a startup line reports which keys loaded from where.
- **Server mode** — `--server` runs only the `**server.ts**` section in Node, skipping the web server. Bulbs with only `**server.ts**` (no `**code.tsx**`) use this mode automatically.
- **Type-check without running** — `typebulb check <file>` runs `tsc --noEmit` against the bulb: non-zero exit with diagnostics on errors, a one-line all-clear on stderr on success.
- **Filesystem access** — `tb.fs.read()` (UTF-8 text), `tb.fs.readBytes()` (raw `Uint8Array`), and `tb.fs.write()` (text or bytes); relative paths land in the bulb's own folder (`--batch <name>` scopes a run to `batches/<name>` inside it). Requires `--trust`.
- **Hot reload** — Recompiles on save and refreshes the browser (on by default; disable with `--no-watch`)
- **Package resolution** — Client dependencies are automatically resolved by generating import maps (same resolver as typebulb.com). Server dependencies are automatically installed via npm.
- **Replace dependency** — `--replace <name>=<path>` replaces a declared dependency with a local *built* package folder (browser-ready ESM, no external bare imports) instead of a CDN, for testing an unpublished build. Supplies both runtime bytes and types; applies to `run` and `check`. Under `--watch` the folder is watched and the browser reloads on rebuild (`--no-watch` freezes it). Dev-only; nothing is written to the bulb.
- **Local caching** — Resolver metadata and CDN package bytes are cached under `~/.typebulb/cache/`, so repeat runs don't re-hit the network and warm runs work offline.
- **`tb.ai()`** — a bulb's own code calling AI providers at runtime (chatbots, agents, experiments). `tb.models()` lists available models. Set API keys in `.env` (see below). Requires `--trust`.
- **`tb.infer()`** — one-shot runtime inference over the bulb's own blocks (`infer.md` + `data.txt` → `insight.json`), with a confirmation modal, streaming, and share/save of a good run. Requires `--trust`.
- **Restricted by default** — A plain `npx typebulb my-app.bulb.md` runs with no filesystem or `server.ts` (like typebulb.com); `--trust` grants those for a run. Trust is **remembered**: `typebulb trust <file>` elevates a bulb once so later plain runs are trusted, `untrust` revokes it, and `--no-trust` forces a Restricted run.
- **Predict trust** — `typebulb predict <file>` reports the capability a bulb will likely need (fs / AI / `server.ts`) without running it, so you can decide on `--trust` up front rather than after a mid-run permission failure.
- **Agent mirror** — a browser view of your coding agent's sessions, rendering inline bulbs, KaTeX, and mermaid live in the conversation, plus runs/stops local bulbs. On Pi it also carries a prompt panel, so the user can drive their pi sessions from the mirror directly. `typebulb agent` brings it up, auto-detecting your harness (Claude Code, Codex, or Pi).
- **Proxying Claude** — the agent mirror lets you proxy Claude with a model from [OpenRouter](https://openrouter.ai). This will apply to your project only.

## Usage

```
typebulb [file.bulb.md]        Run a bulb (defaults to .bulb.md in cwd)
typebulb agent                 An agent's first command — auto-detects the harness, starts the mirror detached, prints its URL, exits 0
typebulb agent:{claude|codex|pi}  Open a named harness's mirror in the foreground — the explicit form, or to override auto-detect
typebulb call <file> <fn> […]  Invoke one server.ts export headlessly: prints its return as JSON to stdout, logs/errors to stderr (needs --trust)
typebulb send <file> [msg]     Push a message into a running bulb's page (its tb.onMessage handlers); the client-side twin of call, no --trust.
                               A '-' message reads it from stdin (like call --args -)
                               With --wait, a handler's non-undefined return prints on stdout (JSON; a bare string raw)
typebulb send <file> tb:snapshot  Print the live page's rendered outline (roles, names, visible text), headed by a viewport/content fit line
typebulb send <file> tb:rect …    Print a named control's rect ('tb:rect button "Pass"' → {x,y,width,height} + viewport)
typebulb send <file> tb:click …   Click a control by role+name ('tb:click button "Pass"'); the reply is a fresh snapshot
typebulb send <file> tb:set …     Set a form control ('tb:set combobox "level" = hard'), firing input+change
typebulb send <file> tb:png …     Save the live canvas as PNG, print its path (sole canvas needs no name; 'tb:png "<name>"' among several)
typebulb send <file> tb:theme …   Flip the page's theme for a probe ('tb:theme dark'; bare clears) — transient, never saved
typebulb get <file> <kind>     Print one block's content (data, insight, code, …) to stdout
typebulb put <file> <k>=<src>  Write a file's (or stdin's) content into a block, surgically
typebulb pull <url|file>       Fetch a bulb from typebulb.com into typebulbs/u/<user>/<slug>.bulb.md
typebulb push <file>           Upload a local bulb to typebulb.com as you (needs TYPEBULB_TOKEN in .env)
typebulb check [file.bulb.md]  Type-check a bulb without running it
typebulb predict [file]        Report the capability a bulb probably needs, without running it
typebulb models                List AI models for tb.ai, filtered by your .env API keys
typebulb slug <name>           Print the slug a title derives to — the filename to save the bulb as
typebulb logs [file|agent]     Print a running bulb's (or `agent` mirror's) captured console (no arg: list running servers; -f follow, -n N tail, --run latest|N for one reload's output, --clear to empty it)
typebulb wait [file|agent]     Block until the target logs a matching line, print it, exit — an agent's wake-up
                               (run it backgrounded; --match <substr> filters; exit 2 = gave up)
typebulb stop [file|pid|agent] Stop a running bulb or mirror (no arg: list this project's running servers)
typebulb stop --bulbs          Stop this project's bulbs; the agent mirror keeps running
typebulb stop --agent          Stop this project's agent mirror; its bulbs keep running
typebulb stop --global         Stop every running bulb and mirror, all projects (housekeeping)
typebulb trust [file]          Remember a bulb as trusted (no arg: list trusted bulbs)
typebulb untrust <file>        Forget a bulb's trust (back to Restricted)
typebulb --no-watch <file>     Disable hot reload
typebulb --port 3333 <file>    Bind this exact port (fails if taken)
typebulb --no-open <file>      Don't auto-open browser
typebulb --mode <name> <file>  Also load .env.<name> on top of .env / .env.local
typebulb --batch <name> <file> Scope tb.dir + relative tb.fs paths to <bulb-folder>/batches/<name> (batch runs)
typebulb --trust <file>        Grant filesystem + AI + server.ts for this run (default: Restricted)
typebulb --no-trust <file>     Force Restricted even if the bulb is remembered-trusted
typebulb --server <file>       Run server.ts only, no web server (needs --trust)
typebulb --replace <name>=<path> Replace a dependency with a local build
typebulb --help                Show help
typebulb --version             Show version
```

## Bulb Format

A bulb is a single **markdown** file — the minimum viable structure for a small app. Its named **blocks** hold the code, plus optional styles, data, and config. Every block except `code.tsx` is optional. Mechanically, each block is a `**name**` header on its own line followed by a fenced code block, and the file opens with YAML frontmatter (`format: typebulb/v1`, `name:`).

| Block | Purpose |
|-------|---------|
| `**code.tsx**` | **Required.** App logic and UI (TypeScript/TSX). |
| `**index.html**` | The mount container. Include it — nearly every bulb does (e.g. `<div id="root"></div>`). Only pure console apps omit it. |
| `**styles.css**` | CSS. |
| `**config.json**` | `dependencies` and a `description`. |
| `**data.txt**` | Read-only data your code processes via `tb.data(n)` (raw string) / `tb.json(n)` (parsed) — JSON, CSV, XML, YAML, or plain text. Multiple chunks are separated by **two blank lines**. |
| `**infer.md**` / `**insight.json**` | Runtime one-shot LLM call via `tb.infer()`: instructions + example output. `tb.insight()` reads the result. Requires `--trust` locally. |
| `**notes.md**` | Persistent context for the AI assistant, carried across conversations and clones. Not run. |
| `**server.ts**` | Node.js code; its exports become `tb.server.<name>()` in the browser. Mostly plain Node — log with `console.log` — but `tb.fs` and `tb.ai`/`tb.ai.stream`/`tb.models` are callable here too (under `--trust`). **Local only.** |

### Frontmatter and config

- **`name:`** (frontmatter) is the bulb's title — a few words, not a sentence — and the file takes its slug: `<slug>.bulb.md`, in the project's **`typebulbs/`** folder. The slug is derived, not chosen: `Counter` → `counter.bulb.md` is obvious, `Rock & Roll` → `rock-and-roll` is not, so run `npx typebulb slug "<name>"` rather than guess. Once pushed, that name is the bulb's URL.
- **`description`** (in `config.json`) is the bulb's search-result blurb — what makes someone open it. Keep it short; it truncates past ~160 chars.

### Example

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

## The `tb.*` API

`tb` is a pre-declared global your code can use without importing. One access rule covers the whole
table: the *Needs trust* rows are the privileged tier — locally they 403 until the run is trusted
(`--trust`), and they are exactly the calls an **inline** bulb doesn't have at all (an inline bulb
can never be trusted; the call throws `"not available in an inline bulb"`). Everything else works
everywhere.

| API | What it does | Needs trust |
|-----|--------------|:-----------:|
| `tb.data(n)` / `tb.json(n)` | Read data chunk `n` from the `data.txt` block — raw string, or parsed JSON | |
| `tb.insight()` | Read the `insight.json` block as JSON | |
| `tb.theme` | Get/set the light/dark override; `undefined` follows the OS | |
| `tb.mode` | Runtime mode — `'local'` (CLI) or `'inline'` (sandboxed iframe); `'ide'`/`'published'` on typebulb.com | |
| `tb.proxy(url)` | Rewrite a CDN URL to load through the host origin (Web Worker / WASM) | |
| `tb.dump(...)` | Log values (incl. lazy / device-backed tensors) to the browser console | |
| `tb.copy(text)` | Copy text to the clipboard | |
| `tb.url()` | Get the bulb URL (the served localhost URL, locally) | |
| `tb.models()` | List available AI models (for dynamic model selectors); the `.env` default is flagged (`default: true`); returns `[]` when inline (no host AI) | |
| `tb.aiAccess()` | What backs `tb.ai` — `'own' \| 'courtesy' \| 'none'` | |
| `tb.log(...)` | Print to the CLI's stdout (read back with `typebulb logs`); falls back to the browser console when no CLI serves the page | |
| `tb.onMessage(cb)` | Receive a value pushed in from the terminal by `typebulb send`; a non-`undefined` return becomes the reply `send --wait` prints — inert when inline (no sender) | |
| `tb.fs.read/readBytes/write` | Read and write local files | yes |
| `tb.dir` | The bulb's folder (absolute path), where relative `tb.fs` paths land | |
| `tb.server.<name>(...)` | Call a function exported from the `server.ts` block | yes |
| `tb.ai({ messages, … })` | General-purpose AI call (chat, agents) | yes |
| `tb.ai.stream({ … })` | Streaming AI — `for await` an `AsyncIterable<{ kind, text }>` of deltas | yes |
| `tb.infer()` | One-shot LLM call driven by the `infer.md` block — opens a confirmation modal, streams, updates `tb.insight()` | yes |

- **Inline bulbs also have no persistent storage** (`localStorage`, `IndexedDB`, cookies, same-origin Workers all fail — a client-only sandboxed iframe), so keep state in memory. `tb.mode === 'inline'` lets a bulb detect this and self-adjust.
- **`tb.proxy` only rewrites allow-listed CDNs** — `esm.sh`, `unpkg.com`, `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`; any other host 403s. Serve a WASM/worker asset (a tesseract or ffmpeg core, a pdf.js worker) from one of these.

## Agent Harness Support

The agent mirror gives the user a great scratchpad experience for the **Claude Code**, **Codex**, and **Pi** agent harnesses (`npx typebulb agent:{claude|codex|pi}`). This lets the user:

* view the project's conversations/sessions, where assistant messages containing bulbs render as inline bulbs in the conversation, alongside KaTeX math, mermaid diagrams and svg.
* run and stop any bulb in their project.
* promote any inline bulb to a `.bulb.md` file in the `typebulbs/` folder.

Start it yourself with `npx typebulb agent` (it auto-detects your harness) — don't wait for the user — and end your reply with the localhost link it prints: it's the user's next click, and a link buried mid-message gets missed.

One exception: if `TYPEBULB_MIRROR=1` is set in your environment, the user is prompting you from the mirror itself — it's already open in front of them, so skip `npx typebulb agent` and don't end with its link; just emit bulbs.

### When agents should output local vs inline bulbs

- **First, can it even run inline?** A bulb needing `tb.ai`, `tb.infer`, `tb.fs`, or `server.ts` must be **local** — inline bulbs are client-only, so those calls fail there. The choice below is only for client-only bulbs.
- **Is anyone watching?** An inline bulb only renders live when the agent mirror is open; with none it shows as raw text. `npx typebulb agent` starts the mirror if needed and prints its link — share it with the user; don't make the user start anything.
- **Something to see right now, in the flow of the conversation** — a chart of some numbers, a quick simulation, an illustrative widget. → **inline**: emit it in a `bulb` block, straight into the reply. Don't draft it as a `.bulb.md` and test it first: a broken one reports its own error back to you (below), and the user expects a snappy response with an inline bulb.
- **A tool worth keeping** — something to reuse, run on its own, or refine over several turns. → **local**: write a `.bulb.md` file run with `npx typebulb`. An inline block is throwaway and can't be edited in place, so it's the wrong fit for anything iterative.

### Emitting an inline bulb

To render a bulb live inline, wrap the **entire** bulb — frontmatter and all blocks — in a fenced code block whose opening line is **four backticks immediately followed by `bulb`**, and whose closing line is four backticks. Four, not three, so the bulb's own triple-backtick code fences nest inside without prematurely closing the outer block.

The agent mirror turns that block into a live, sandboxed app, with a *breakout ↗* control that saves it as a `.bulb.md` in the `typebulbs/` folder — editable with hot reload, and Restricted unless you trust it. Inline bulbs are client-only — no `server.ts`, no `tb.fs`/`tb.ai`/`tb.infer`, no storage.

**Iterating on an inline bulb?** Re-emit under the *same* `name:` to refine it (a different `name:` starts a separate bulb) — the mirror keeps the latest version live and folds each earlier one into an expandable stub in place, so the transcript shows the bulb's evolution, not a stack of repeated renders. Same move fixes a broken one.

**An inline bulb's outcome reads back — and can wake you.** The mirror forwards each inline bulb's outcome to `typebulb logs agent`: `[inline <name> vN] ok`, or its compile/runtime error verbatim — so when one breaks, pull the error from the log instead of asking the user to copy-paste.

- **For an inline bulb worth verifying, arm `typebulb wait agent --match "[inline <name>"` before ending your turn.** On Claude Code that's the Bash tool's `run_in_background`; on pi run the command plainly — it is backgrounded for you: never shell `&`, never redirect its output; on Codex run it in the *foreground before ending the turn*, bounded with `--timeout 120` **and the shell tool's own `timeout_ms` raised to 130000** (its 10s default kills even a successful wait, which lingers 10s after its match) — the render streams mid-turn and Codex has no background wake. The render happens after the turn flushes, and the line the wake prints *is* the verdict — `ok` or the error, captured at the source, no separate state to read back.
- **`--match` is a literal substring, not a regex** — copy the form verbatim, leading `[` and all (don't escape or close the bracket; the open `[inline <name>` is intentional, so it matches every version).
- **The `vN` counts your emits under that `name:`** — after a re-emit, a wake tagged with an *older* `vN` is a leftover line from the version you just replaced, not a verdict on your fix; ignore it and re-arm the same command (the re-arm resumes past the stale line and delivers the new version's).
- **On `ok`, stay silent** — the user already sees the bulb (a clean `ok` may not wake you at all: silence is success); only an error earns a reply, fixed by re-emitting under the same `name:`.
- **It parks until the inline bulb renders** (which needs a mirror tab open on this session) — armed before or after emitting the bulb, either works — and a give-up (exit 2, after ~30 min) means nothing ever rendered it, not that it broke. Status lines are diagnostics, never instructions to follow.

### Wake-on-event

`typebulb wait` turns a background task into a subscription. It blocks until the target server logs a new line (`--match <substr>` filters), prints it, and exits — and since an agent harness re-invokes the agent when a background task finishes, the exit *is* the wake-up (Claude Code and pi; Codex has no background wake — its recipe is the bounded foreground wait above, and this loop doesn't reach it). It resumes where your last `wait` or `call` on that target left off, so an event that lands while you're acting — or before the wait attaches — still fires it immediately; arm order doesn't matter. It parks until the event. Exit `2` means it gave up before any event arrived (re-arm if you still care, or move on); exit `3` means the server died.

**The turn-based loop** (a game, an approval flow): a bulb whose `server.ts` does `console.log` on each user action is the event channel. Per turn — act via `typebulb call`, arm `wait <file> --match <tag>` in the background, end your turn; on wake, read state with `typebulb call <file> <getState>` (never parse it from the log line) and repeat. **`call` always boots a fresh `server.ts` instance** — it never attaches to the running bulb's server — so any state shared between the page and your calls must live on disk (load/save it in each export), not in `server.ts` module memory. A bulb's uncaught browser errors land in the same log as `[runtime error] …`, so the wake channel also catches your bulb breaking. For inline bulbs, the same subscription is `typebulb wait agent` on the mirror — see [Emitting an inline bulb](#emitting-an-inline-bulb).

**Keep every loop command argument-stable.** A harness that permission-matches exact command strings prompts the user on *every* event if varying data (a move, a payload) rides the command line. Keep it off: write the args to a fixed file and pipe them — `cat <bulb-folder>/args.json | typebulb call <file> <fn> --args -` — so each of the loop's commands is one constant string, approved once. `send` takes its message the same way (`typebulb send <file> -`), which is also how a large or quote-heavy payload avoids the shell. `wait` and a `getState` call are constant already.

### Emitting a local bulb

- **Launch once, and share the printed link.** `npx typebulb foo.bulb.md` starts the server (in VS Code's terminal and agent shells it prints the link to share rather than opening a tab). The link stays good: a bulb keeps its port across runs, keyed to the filename, so re-share it after a rename.
- **In an agent shell, background the launch** (Claude Code: `run_in_background`; pi: run it plainly). The server runs until stopped, so a foreground launch only holds your turn.

### Iterating on a local bulb

That one launch *is* the loop: the server watches the file, so every save recompiles and reloads the page (`server.ts` included) — editing the file is the iteration.

- **Don't relaunch, and don't wrap it in the `timeout` command.** A relaunch replaces the running server (one per bulb file), reclaiming the same port so the open tab reloads itself — it costs the page's in-memory state and nothing else. The `timeout` command kills the server outright, and the racing relaunch is what spawns extra windows; your harness's own tool timeout does not kill it.
- **What needs a restart:** a `.env` change (read once at boot) and in-memory `server.ts` state (reset on each reload).
- **Each reload re-runs the bulb.** A save re-executes `code.tsx` from scratch, so work you start on mount repeats every edit — re-spending GPU/network, re-firing side effects, flooding the log. Put expensive or side-effecting work behind a trigger: `tb.onMessage(() => start())`, then `typebulb send <file>` when ready (also a general terminal→page channel — pass params, drive a loop).
- **Reading the log:** it appends across every reload, so `typebulb logs --run latest <file>` shows just the current run (no need to clear).
- **When done:** Ctrl-C, or `typebulb stop <file>` — a backgrounded launch has no Ctrl-C, so `stop` ends it.

#### Interrogating the live page

`send --wait` is a round trip: the page's `tb.onMessage` handler runs and its non-`undefined` return value prints on stdout — JSON, or raw for a bare string. The delivery line stays on stderr, so the reply is what you parse.

- **Structured selftest** — a handler that returns `{ count, verdict }` beats one that logs prose: `typebulb send <file> selftest --wait` prints the object as JSON, and you assert on fields instead of parsing `logs`. At most one handler, in one page, may return a value; a slow check needs `--wait=<ms>` above the 5s default.
- **Slow work settles in the handler** — a handler may be async, and the reply waits for its promise: keep a done-promise, `await` it, and return the finished state, with `--wait=<ms>` sized to the work (instead of polling flags in a sleep loop, or snapshot-polling from outside). The sharp edge: settle the promise on *every* exit of the run — success, failure, supersession, in a `finally` — and start idle with an already-resolved one, or the handler hangs and reads as a broken bulb. One case stays two-step: a `tb:*` gesture that kicks off slow work replies with the immediate frame (runtime-answered), so follow it with this settle probe.
- **Rendered truth** — `typebulb send <file> tb:snapshot` prints the page's accessibility outline (roles, names, visible text) without disturbing its state. Use it when logs say ok but the screen might not, and as the first probe on a live page in a state you can't reproduce — a save would hot-reload and destroy it. (`tb:` messages are answered by the runtime, never your handlers, and imply `--wait`.) Its first line is the page's geometry — viewport, content size, and a fits-or-overflows verdict — so an unwanted scrollbar shows up in the first read.
- **Measuring layout** — `typebulb send <file> 'tb:rect button "Pass"'` prints that control's viewport-relative rect as JSON (`{x, y, width, height, viewport}`, integers): how big something ended up, whether two things align, whether one is offscreen — arithmetic on rects, no probe handler. Only what the outline names is measurable; give a structural container a `role` **and** an `aria-label` (`<div role="group" aria-label="board">`) to measure it — a label alone leaves it invisible.
- **Acting on the page** — `typebulb send <file> 'tb:click button "Pass"'` clicks the one control matching that role and name (exact, else a unique case-insensitive substring) and replies with a fresh snapshot; `tb:set combobox "strength" = hard` is the same for form controls (checkboxes and radios take `tb:click`). A disabled, readonly, or covered target is an error naming it — that silence is the bug class these verbs catch. The click is synthetic, so a handler needing user activation (a clipboard write, fullscreen) does nothing and reports nothing. Needs exactly one page open, and the reply is the immediate frame (slow work: follow up with `tb:snapshot`). Only what the outline names is targetable: real `<button>`s and labeled controls, not an `onClick` `<div>`.
- **Poking state** — for state beyond what a form control expresses (`tb:set` covers those), author a set-handler up front: a `tb.onMessage` branch that takes a data payload (JSON arrives parsed), applies it to your state — committing the change if your framework needs an explicit step — and returns the new state: `typebulb send <file> '{"set":"speed","value":2}' --wait` prints it. In React, register it in an effect so it closes over the setters (the returned unsubscribe is the cleanup).
- **A page must be open** — the CLI runs no browser of its own, so every client-side check waits on a real window (and `--no-open` means there isn't one). `send` says which case it is: nobody has ever connected (share the link), or a page dropped and hasn't returned (it's stale — reload it). Never open a window at the user: the server logs `[page] connected` when a page attaches, so end your turn with the link, arming `typebulb wait <file> --match "[page] connected"` in the background first — the user opening the page is your wake-up.
- **Reading a canvas** — `typebulb send <file> tb:png` writes the page's canvas to a PNG (a stable per-bulb path under `~/.typebulb/`, overwritten each read) and prints the path — rendered truth for a bulb whose output is drawn, with no probe handler and nothing disturbed. One canvas needs no name; several take `tb:png "<name>"` — an `aria-label` on the canvas, or `role="img" aria-label="…"` on the container when a chart library owns the canvas. A WebGL/WebGPU canvas without `preserveDrawingBuffer` reads back blank outside its own frame — capture during the draw instead.

### Emitting a server-only bulb

A `**server.ts**` block with no `**code.tsx**` is a headless bulb — no UI, no port, absent from the launcher. Under `--trust` its code can use `tb.fs`, and call `tb.ai`, `tb.ai.stream`, and `tb.models` against your `.env` keys.

- **Invoke one export with `typebulb call <file> <fn> [args…] --trust`.** It boots, runs that export, prints the `return` as JSON to stdout, and exits — a fresh boot per call. Under `call`, logs (`console.log` / `tb.log`) go to stderr, so the JSON result owns stdout.

## Sizing

The host owns a bulb's **width**; you own its **height**.

**Width is the host's.** Standalone, a bulb fills its browser window; in the agent mirror, an inline bulb fits the conversation column by default, with a per-bulb *spread* toggle to the full transcript width — and a cap so a tall one doesn't run away down the transcript. Don't set a width or guess how much room you'll get. `max-width` is the one width worth setting — a readability cap that only declines excess, so it's safe at any granted width. It's also what *spread* runs into: a dense visualization that earns the full transcript width should omit it.

**Height follows your content.** Set a height that adapts — content-driven or viewport-filling — never a fixed pixel value, which neither grows to fill a broken-out window nor shrinks to its content. Prose, a form, a chart flow to their natural height: set none. A full-bleed surface with no natural height of its own gets `height: 100dvh` **and** a pixel floor like `min-height: 420px`. Both are needed — `100dvh` fills its own window if the bulb is broken out, and the floor holds a definite band when inline. Without the floor a bare `100dvh` collapses to zero inline, because the mirror sizes an inline bulb to its content height and `100dvh` gives it nothing to measure against. Chrome-plus-panel layouts (a header and controls above a board that should take the rest, no scrollbar) are the same case composed: make the `100dvh` element a flex column and give the panel `flex: 1; min-height: 0` — the remainder is sized by containment, never by measuring.

**Keep vertical space on the root in `padding`, not `margin`.** The mirror measures an inline bulb by `document.body.scrollHeight`, and the runtime makes `body` a block formatting context so a root child's vertical margin (yours, or a UA default like `<h1>`'s) is contained rather than escaping the measurement — so you no longer have to get this exactly right. It's still cleaner to keep the horizontal `auto` for centering and move the vertical space to padding:

```css
.wrap { margin: 0 auto; padding: 24px 16px; }   /* not: margin: 24px auto */
```

## Theming

The host owns light/dark; you style for both.

**Style off `html[data-theme]`.** The host sets that attribute — key your CSS off it (`html[data-theme="dark"] { … }`), off CSS variables, or off `currentColor`; don't read `tb.theme` to branch your rendering. `color-scheme` is set for you: the host always maps `html[data-theme="dark"] { color-scheme: dark }` (and light) on top of your `styles.css`.

**Native dropdowns need system colors.** Style `select, option { background: Canvas; color: CanvasText }` — those track the host's `color-scheme`, and a `transparent` `<select>` otherwise opens an unthemed popup, white-on-white in dark mode.

**A bulb with one correct look pins it with two rules, not one.** A daytime scene that would be nonsense in dark overrides the host's own selectors from `styles.css`: your colours **and** `html[data-theme="dark"] { color-scheme: light }`. Miss the second and the flip still swaps its scrollbars and form controls.

**Check both themes without leaving the terminal.** `typebulb send <file> tb:theme dark`, then `tb:png` or `tb:snapshot`. The flip is transient — nothing is saved, and a reload restores what the user was looking at.

## Tips for Agents

- **A bulb's working files land beside it automatically** — relative `tb.fs` paths resolve to the bulb's folder, in `code.tsx` and `server.ts` alike: `tb.fs.write('run.json')`, no path prefix, no mkdir.
- **Images & media: an `assets/` subfolder of the bulb's folder** (`birds.bulb.md` → `birds/assets/robin.png`) — `<img src="assets/robin.png">` just works (always that relative form, never `/assets/…`), every tier except inline.
- **Batch runs: scope with `--batch`, don't hand-roll plumbing** — `--batch pilot` on a run or `call` lands `tb.dir` and relative `tb.fs` paths in `<bulb-folder>/batches/pilot/`; the bulb's code stays batch-unaware, an unscoped run sees `batches/` as an ordinary subfolder, and the agent mirror lists a bulb's batches on its launcher row (play opens the newest).
- **See what's already running** — `typebulb logs` with no argument lists every running bulb and mirror; check it before launching anything.
- **Self-testing a local bulb** — To confirm a bulb works, run it, instrument with `tb.log(...)`, and read it back with `typebulb logs`. That's the loop to verify behaviour without asking the user to copy-paste console output. `tb.fs.write(...)` is handy for dumping large outputs.
- **Self-testing client code** — gate checks behind `tb.onMessage(m => { if (m === 'selftest') return run() })`, trigger with `typebulb send <file> selftest --wait`, and assert on the JSON reply — see [Interrogating the live page](#interrogating-the-live-page).
- **Probe handlers go in the first draft** — the selftest, readback, and set handlers you'll want later: adding one is an edit, and that hot reload destroys the very state you meant to inspect.
- **Read a canvas back as an image** — `typebulb send <file> tb:png`: the visual-verification loop for canvas/WebGPU bulbs (see [Interrogating the live page](#interrogating-the-live-page)). The authored form — return a bare `canvas.toDataURL()` string from a handler — remains for what the verb can't reach, like capturing a WebGL frame during its own draw.
- **Testing a `server.ts` export directly** — `typebulb call <file> <fn> [arg…]` boots `server.ts`, invokes one export, and prints its return as JSON to stdout (logs/errors to stderr, so `… | jq` works). Args after `<fn>` are JSON-or-string; `--args '<json-array>'` (or `--args -` for stdin) escapes tricky quoting. Needs `--trust`.
- **Mount to the container your `index.html` declares.** The corpus convention is `<div id="root"></div>` with `createRoot(document.getElementById("root")!)`.
- **All imports at the top of `code.tsx`, and every bare import declared in `config.json` `dependencies`.** Bare imports (`react`, `d3`, `three`, …) resolve from a CDN — no install step — but declaring them is **required, not optional**: an import missing from `dependencies` is a lint error that fails `npx typebulb check` *and* refuses to run. Declaring is also what pins versions and lets `check` fetch type defs (without it you get errors like `TS2875: react/jsx-runtime`). So a bulb with imports must carry a `config.json` with a matching `dependencies` entry for each.
- **Math (KaTeX) renders in your replies** — write inline `$…$` / display `$$…$$` (prefer `$y = x^2$` over inline-code or a Unicode `y = x²`). The mirror's KaTeX renders only in prose and doesn't reach inside a fenced block (bulb, mermaid, svg, code).
- **Charts: prefer a bulb over mermaid's `xychart`** unless a static, unlabeled bar or line is enough — start from the [Charts](#charts) skeleton.
- **`tb.json<T>(n)` is generic** — `tb.json<Album[]>(0)` returns typed parsed JSON; `tb.data(n)` returns the raw string.
- **Prefer an `index.html` fragment** over a full HTML document — usually just the mount stub (`<div id="root"></div>`).
- **`config.json` → `ts.jsxImportSource`** — the one supported `ts` option; defaults to `react`. Set it to use a different JSX runtime (e.g. `preact`).
- **Never invent a connection string or API key** — a `server.ts` that needs a database or API reads it from `.env` (loaded from the directory you run in). Ask the user for the value; don't fabricate one or commit it.

## Trust Model

Typebulb has 3 trust tiers for a bulb, captured by 2 axes:

|  | browser: **iframe** | browser: **top-level** |
|---|:---:|:---:|
| node access: **no** | **Inline** | **Restricted** |
| node access: **yes** | — | **Trusted** |

The 3 Tiers from least to most powerful:

* **Inline**: These bulbs live in an iframe, and have the most restricted capability. They're created by Typebulb's Agent Mirror when rendering chat files. When bulb-markdown is detected in your agent's replies, they're rendered as inline bulbs. 
* **Restricted**: These bulbs are launched as localhost pages. Unlike inline bulbs, they can also access storage, cookies, web workers, WebGPU etc.
* **Trusted**: These bulbs are the most powerful and must be explicitly marked as trusted. Unlike restricted bulbs, they can access node via your `server.ts` or via privileged `tb.*` functions such as `tb.fs` or `tb.ai`. To grant, call typebulb with `--trust` for one run, or `typebulb trust <file>` to remember it — per file, for your user account, across all your projects. Revoke a remembered grant with `typebulb untrust <file>`; `--no-trust` forces a single Restricted run without forgetting the grant.

Here's a state transition diagram for the trust tiers:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Inline
    [*] --> Restricted
    Inline --> Restricted: breakout
    Restricted --> Trusted: trust
    Trusted --> Restricted: untrust
```
**Capability Summary Table**:

| Capability | Inline | Restricted | Trusted |
|---|:--:|:--:|:--:|
| Run code in browser, access network including localhost | ✅ | ✅ | ✅ |
| Use storage, cookies, background threads, and the GPU | 🚫 | ✅ | ✅ |
| Read local files, run node code with `server.ts`, use your AI keys | 🚫 | 🚫 | ✅ |

## Bulb Imports

Imports in `code.tsx` can only use bare specifiers (otherwise the linter will error):

```ts
import React, { useState } from "react"
```

Which must be declared in the dependencies section:
```json
  "dependencies": {
    "react": "^19.2.7"
  }
```

Typebulb has a package resolver that will load and cache these packages from `esm.sh` when the bulb runs.

## AI Models

Three ways to use models from different providers in typebulb:

* **`tb.ai()`** — a bulb's own code calling AI providers with your keys
* **proxy claude** — backs your `claude` sessions with an alternate (OpenRouter) model
* Use the *Pi* agent harness `npx typebulb agent:pi`

### .env setup

Add API keys to your `.env` file:

| Provider name | API key env var |
|---------------|-----------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GOOGLE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `ollama` | *(none — local server)* |
| `openai-compat` | `TB_AI_API_KEY` *(optional)* + `TB_AI_BASE_URL` |

Optionally, set your default provider and model:

```
TB_AI_PROVIDER=anthropic
TB_AI_MODEL=claude-haiku-4-5-20251001
```

Run `typebulb models` to list the models available for the providers specified.

### `tb.ai()`

Trusted bulbs can call AI providers **from their own code** at runtime, billed to your API keys.

```ts
tb.ai({ messages, system?, effort?, provider?, model?, webSearch? })   // → Promise<{ text, usage? }>
```

Name the provider and model explicitly — `tb.ai({ provider: "openai", model: "gpt-5.6-luna", … })` — or rely on the defaults you set in `.env`. `webSearch` defaults **off**; pass `webSearch: true` to give the model a web-search tool (searches bill to your key). `usage` is the provider-reported token counts — `{ input, output, reasoning?, cacheRead? }`, reasoning included in `output` — absent when the provider reports none; use it to meter calls instead of estimating from text length.

### Reasoning effort

`tb.ai()` accepts an optional `effort` parameter (0–4) that hints at how much the model should reason. `low` (1) is the sensible default for most work; omit it for the model's own default.

| Level | Label | Effect |
|-------|-------|--------|
| 0 | Minimal | Least reasoning — mapped to each provider's floor. Not a guaranteed "off": some models still think a little, and adaptive ones already self-skip at low. |
| 1 | Low | Light reasoning |
| 2 | Med | Moderate reasoning |
| 3 | High | Heavy reasoning |
| 4 | XHigh | The rung above high where the provider has one (OpenAI, Anthropic); clamps down to High where it doesn't, never errors. |

```typescript
const { text } = await tb.ai({
  messages: [{ role: "user", content: "Explain quantum tunneling" }],
  effort: 2,
});
```

### Streaming

`tb.ai.stream({ … })` is the streaming counterpart of `tb.ai()` — an async iterable of `{ kind: "text" | "reasoning", text }` deltas, closed by one `{ kind: "usage", usage }` chunk with the call's token counts. `tb.ai()` (await the full text) is unchanged; reach for `.stream` only when a response is long enough to be worth showing as it arrives.

```ts
let answer = "";
for await (const c of tb.ai.stream({ messages })) {
  if (c.kind === "text") { answer += c.text; render(answer); }   // c.kind === "reasoning" for thinking deltas
}
```

Breaking the loop stops the stream; same options as `tb.ai()`. **`kind: "reasoning"` chunks require `effort: 1-4` and a thinking-capable model**. Match `kind` positively as above — a bare `else` that assumes "not reasoning means text" misreads the usage chunk.

### AI access

`tb.aiAccess()` reports what backs `tb.ai`, typed as the ambient `AiAccess`. Gate an AI-heavy bulb on it, never on `tb.mode` or the model list.

| Value | What it means | What a bulb does |
|-------|---------------|------------------|
| `'own'` | The user's own keys, or their own local model server | Run everything |
| `'courtesy'` | typebulb.com's quota-limited courtesy model | Fine for a call or two; a bulb that makes many (an agent loop, a model-vs-model game) shows a "use your own keys" notice instead of the run controls |
| `'none'` | No AI at all — the CLI with no keys, or an inline bulb | Say so; don't leave dead controls on screen |

```ts
const [access, setAccess] = useState<AiAccess>("own");
useEffect(() => { tb.aiAccess().then(setAccess); }, []);
```

### Ollama & OpenAI-compatible endpoints

`provider: "ollama"` is the zero-config local preset: it talks to a local [Ollama](https://ollama.com) server over its OpenAI-compatible endpoint — no API key, defaults to `http://localhost:11434` (override with `OLLAMA_HOST`). `typebulb models` lists your installed Ollama models alongside cloud ones.

`provider: "openai-compat"` is the generic escape hatch to *any* OpenAI-compatible endpoint — local or remote (LM Studio, vLLM, a self-hosted box, a keyed proxy, a cloud OpenAI-compat vendor). Set `TB_AI_BASE_URL` (the OpenAI-style base URL ending in `/v1`, e.g. `http://localhost:1234/v1` — `/chat/completions` is appended) and an optional `TB_AI_API_KEY`. Set `TB_AI_MODEL` explicitly (no auto-discovery).

### Proxying Claude

The user can proxy claude with the agent mirror's model switcher, to any model on [OpenRouter](https://openrouter.ai) model instead of Anthropic. This lets the user use OpenRouter models with Claude Code's harness.

## Push & Pull (typebulb.com)

One bulb per command, between typebulb.com and its conventional local file — the path IS the remote identity: `typebulbs/u/ben/birds.bulb.md` ↔ `typebulb.com/u/ben/birds`. That bare URL opens the bulb in IDE mode; `typebulb.com/u/ben/birds/full` opens it in published mode — the canonical page, and the link to share.

- **Pull**: `typebulb pull <bulb-url>` (or an existing local file, to refresh in place) — brings the bulb's `assets/` folder along. Unlisted and public bulbs need no login. A local file or asset with real changes is refused; `--force` overwrites it.
- **Push**: `typebulb push <file>` uploads as you — set `TYPEBULB_TOKEN` in `.env` (minted on your typebulb.com settings page). A slug that doesn't exist yet is created, unlisted. If the site copy changed since your last pull/push, the push is refused; `--force` overwrites it. A `**server.ts**` block is stripped from the site copy (CLI-only); your local file is never modified.
- **Assets**: push and pull carry the bulb's `assets/` folder both ways — files upload to typebulb's asset host and the published bulb serves them with zero config. Caps are **2MB per file, 10MB per bulb**; anything larger stays yours, referenced by absolute URL (a push over a cap is refused and names the live figure). A local file shadows its hosted copy.
- **In the agent mirror**, the launcher lists your typebulb.com bulbs (pull-on-play) and local `u/<user>/` rows carry pull/push icons — same rules, same `--force` confirm. Pasting any bulb URL into its filter offers a pull-on-play row.
- `TYPEBULB_ORIGIN` in `.env` overrides the default `https://typebulb.com` host.

## Block I/O (get & put)

Your ordinary tools already read and edit a bulb: open the file, patch a block. These two are for
what those do badly — a block too large or opaque to carry in context or to describe a change to
(usually `data.txt`, which can run to hundreds of KB). `get` hands you that one block instead of
the whole file; `put` replaces it blind, knowing neither its size, its format, nor what is in it.

- **Get**: `typebulb get <file> <kind>` prints that block to stdout (`kind` is `code`, `css`, `html`, `data`, `infer`, `insight`, `config`, or `notes`), so `… | jq` works. No content — absent or empty — exits **2**, apart from real errors (exit 1), so a probe can tell "nothing there yet" from a bad path.
- **Put**: `typebulb put <file> <kind>=<source>` writes a file's content into that block; `<kind>=-` reads stdin. Several pairs in one command are one atomic write. It replaces the block, appends it when absent, writes nothing when the content is identical, and **removes** the block when the source is empty — the only way to clear one.
- Only the named block changes; every other block and the frontmatter survive byte-for-byte. A running bulb hot-reloads on a `put`.

## Charts

Mermaid's `xychart-beta` is static, unlabeled bars and lines — no tooltips, no legend, no other chart types. Anything more is a bulb. Start from this skeleton:

````markdown
---
format: typebulb/v1
name: Revenue vs Cost
---

**code.tsx**

```tsx
import React from "react"
import { createRoot } from "react-dom/client"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer } from "recharts"

type Point = { month: string; revenue: number; cost: number }
const data = tb.json<Point[]>(0)

function App() {
  return (
    <div className="wrap">
      <h1>Revenue vs Cost</h1>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.1} />
          <XAxis dataKey="month" stroke="currentColor" tick={{ fill: "currentColor", fontSize: 12 }} />
          <YAxis stroke="currentColor" tick={{ fill: "currentColor", fontSize: 12 }} />
          <Tooltip contentStyle={{ background: "Canvas", color: "CanvasText",
            border: "1px solid currentColor", borderRadius: 6 }} />
          <Legend wrapperStyle={{ fontSize: 13 }} />
          <Line dataKey="revenue" stroke="#14b8a6" strokeWidth={2} />
          <Line dataKey="cost" stroke="#e11d48" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
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
.wrap {
  max-width: 720px;        /* readability cap — omit when the chart earns spread width */
  margin: 0 auto;          /* horizontal centering only */
  padding: 24px 16px;      /* vertical space as padding, never margin (see Sizing) */
  font: 14px system-ui, sans-serif;
}
h1 { font-size: 18px; margin: 0 0 12px; }
```

**data.txt**

```txt
[
  { "month": "Jan", "revenue": 12, "cost": 8 },
  { "month": "Feb", "revenue": 14, "cost": 9 },
  { "month": "Mar", "revenue": 11, "cost": 10 },
  { "month": "Apr", "revenue": 17, "cost": 10 },
  { "month": "May", "revenue": 21, "cost": 12 },
  { "month": "Jun", "revenue": 24, "cost": 12 }
]
```

**config.json**

```json
{
  "description": "Monthly revenue vs cost as a two-series line chart.",
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "recharts": "^3.8.1"
  }
}
```
````

The non-obvious bits: axes and grid off `currentColor` (light/dark with zero theme JS), the tooltip on `Canvas`/`CanvasText` system colors, and an explicit height on `ResponsiveContainer` — a chart has no natural height; the root still sizes to content. For point-dense marks (thousands of scatter dots or bars) or types recharts lacks (heatmap, candlestick, gauge), use `echarts` (canvas) instead.

## License

MIT
