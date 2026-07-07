/**
 * The typebulb pi extension — typebulb's general presence inside every pi session, installed as
 * `~/.pi/agent/extensions/typebulb.ts`. Two jobs today: the background-wait shim, and the
 * mirror-driven orientation block. (The patcher extension rides the same ensure call as its own
 * file, matchu-patchu.ts.)
 *
 * The wait shim: `typebulb wait` is a wake-up primitive: a process that blocks until an event, then exits, so a
 * harness that re-invokes the agent on a background task's exit turns that exit into a wake
 * (TB-Wait.md). Claude Code has `run_in_background`; **pi has no background
 * bash and no way for an external process to re-invoke the agent** (verified against
 * @earendil-works/pi-coding-agent 0.80.2 — usage.md: "intentionally does not include … background
 * bash"). So on pi a foreground `typebulb wait` would block the very turn whose flush the awaited
 * line depends on — a deadlock.
 *
 * This module ships a tiny pi **extension** that supplies the missing primitive: it intercepts any
 * `typebulb wait …` bash call, blocks the foreground execution (so the turn ends and the embed/turn
 * renders), spawns the real `typebulb wait` in the background itself, and on its exit injects the
 * outcome via `pi.sendUserMessage` — pi's own native "trigger a turn" facility, the analogue of CC's
 * process-exit notification. Because it just runs the real `typebulb wait`, pi inherits all of it for
 * free (the `--match` semantics, the from-0 offset, the 30s cap) and it generalises to BOTH the embed
 * loop and the turn-based bulb loop. The agent-facing instruction stays the one harness-agnostic line.
 *
 * The same extension also carries the composer's guaranteed-delivery orientation: on every turn of a
 * MIRROR-DRIVEN session (TYPEBULB_MIRROR=1, set by PiRpcDriver's spawn env) its before_agent_start
 * handler appends the embed-vs-local decision block — the one `typebulb agent` prints for kickoff
 * flows (commands/agent.ts) — to the system prompt. Ambient skill discovery alone demonstrably fails
 * weaker models (they plan a .bulb.md when asked to show something inline); in-context delivery is
 * what fixed it for the kickoff flow, and this is that same fix for the flow that never runs the
 * command. Terminal pi sessions carry no marker and get no block.
 *
 * typebulb writes the extension into pi's global extensions dir itself (`ensurePiExtension`), gated on pi
 * being present — Claude-Code-only users never get a byte written. pi can't be *told* to load it
 * (no `/reload` typebulb can trigger), so a freshly-placed shim activates on pi's next session start;
 * the one un-activated first session degrades to a benign 30s wait timeout.
 *
 * Lives under `agents/pi/server/` with the rest of the pi adapter — it is pi-specific, even though it's
 * called from the CLI core (`src/index.ts`, `src/commands/agent.ts`), the same src→`agents/pi/server`
 * direction `agentViewer/resolve.ts` already uses for `PiAdapter`. Imported as this bare module, not
 * the pi server barrel, so it pulls in no mirror/createMirror boot.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { bundledDescriptionPath, bundledReadmePath } from '../../../src/servers.js'

const piHome = () => path.join(homedir(), '.pi', 'agent')
const extensionPath = () => path.join(piHome(), 'extensions', 'typebulb.ts')
// The pre-generalization install name (wait-only era). MUST be removed when writing the new file:
// pi loads every file in extensions/, so a stale copy would double-register the wait interceptor
// and double-spawn every background wait.
const legacyExtensionPath = () => path.join(piHome(), 'extensions', 'typebulb-wait.ts')

// The patcher extension (TB-Agent-Pi-Patcher.md) is a BUILT asset, not a string literal — it
// carries the bundled matchu-patchu lib. At runtime this module lives inside the dist/index.js
// bundle, so the asset is a sibling under dist/agents/pi/; running from source (vitest) the path
// doesn't exist and the copy silently skips.
const patcherAssetPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents', 'pi', 'matchu-patchu.ts')
const patcherTargetPath = () => path.join(piHome(), 'extensions', 'matchu-patchu.ts')

/**
 * The shim source, written verbatim into pi's extensions dir and loaded by pi (via jiti) inside the
 * pi process — so `node:*` builtins are available and `pi`/`ctx`/`sendUserMessage` are pi's own.
 * The two `__TB_*_PATH__` placeholders are the exception to "verbatim": `piExtensionSource()` resolves
 * them to this install's absolute skill-part paths at write time (JSON-encoded, so Windows
 * backslashes survive as valid JS string escapes).
 *
 * `String.raw` so the regex backslashes (`\b`, `\s`) and the `\n` survive into the file literally
 * rather than being processed by this enclosing template. Keep this body free of backticks and `${`.
 * Everything is wrapped so a throw can NEVER break pi's startup — a future pi API change degrades the
 * loop to the optimistic tier (no wake), never "pi won't boot".
 */
export const PI_EXTENSION_SOURCE = String.raw`// Generated by typebulb — do not edit; overwritten on each run.
import { spawn } from "node:child_process";

function logErr(...a) { try { console.error("[typebulb]", ...a); } catch (e) {} }

// Matches "typebulb wait", "npx typebulb wait", "/path/to/typebulb wait", "pnpm exec typebulb wait", etc.
function isWaitCommand(command) { return /\btypebulb\s+wait\b/.test(String(command || "")); }

// Resolved at shim-write time to this install's absolute skill-part paths (same files
// commands/agent.ts prints — readable without a permission prompt, unlike the npx command).
var TB_DESCRIPTION_PATH = "__TB_DESCRIPTION_PATH__";
var TB_README_PATH = "__TB_README_PATH__";

// Orientation for a MIRROR-DRIVEN session (TYPEBULB_MIRROR=1 — set only by the mirror's composer
// driver). A composer-driven agent never runs "typebulb agent", so the guaranteed-delivery block
// that command prints (commands/agent.ts) never reaches it; this re-delivers it via the system
// prompt. The wording below is copied from agent.ts, hard-won across many failed interactions —
// only the mirror-link lines differ (the user is already IN the mirror). Change it there first.
var TB_MIRROR_BLOCK = [
  "Typebulb: the user is prompting you from the typebulb agent mirror (already open in front of them).",
  "  Embedded bulbs render live in this conversation.",
  "  • do not run npx typebulb agent — the mirror is already running",
  "  • no need to end your reply with a mirror link",
  "  Reusable app/tool → write a .bulb.md",
  "  Show something inline → embed a bulb",
  "    background a wait for its render verdict:",
  '    • typebulb wait agent --match "[embed <name>"',
  "  Read the authoring skill before writing a bulb:",
  "    • npx typebulb skill — assembles one SKILL.md",
  "    • or, open its parts:",
  "        " + TB_DESCRIPTION_PATH,
  "        " + TB_README_PATH,
].join("\n");

export default function (pi) {
  try {
    const pending = new Set();

    pi.on("before_agent_start", (event) => {
      try {
        if (process.env.TYPEBULB_MIRROR !== "1") return undefined;
        return { systemPrompt: event.systemPrompt + "\n\n" + TB_MIRROR_BLOCK };
      } catch (e) { logErr("before_agent_start", e && e.message); return undefined; }
    });

    pi.on("tool_call", (event, ctx) => {
      try {
        if (!event || event.toolName !== "bash") return undefined;
        const command = event.input && event.input.command;
        if (!isWaitCommand(command)) return undefined;

        // Run the REAL typebulb wait in the background instead of foreground (which would deadlock the
        // turn). It does the mirror/registry lookup, --match and offsets itself. The marker tells it this
        // is a shim-backgrounded (non-blocking) wait, so it runs as a pure subscription: no give-up clock,
        // it waits for the event however long (bounded by the session-shutdown reap below) — an embed's
        // first paint OR a running bulb's next event line alike.
        const child = spawn(command, {
          shell: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, TYPEBULB_WAIT_SHIM: "1" },
        });
        pending.add(child);
        let out = "";
        if (child.stdout) child.stdout.on("data", (b) => { out += b.toString(); });
        child.on("error", (e) => { pending.delete(child); logErr("spawn", e && e.message); });
        child.on("exit", (code) => {
          pending.delete(child);
          try {
            const text = out.trim();
            // Exit 0 with output is a real outcome (embed ok/error, a turn-based move) -> wake the
            // agent (followUp delivers immediately when idle and queues when streaming — the same call
            // git-merge-and-resolve.ts makes from agent_end). A late wake is fine; it just reports
            // something true. Exit 2/3 (no render yet / server gone) surface passively, no turn.
            // EXCEPT an embed's clean ok verdict ("[embed <name> vN] ok" — core/client/bulbEmbed.ts):
            // the user already sees the bulb and the skill orders silence on ok, so a wake would spend
            // a whole turn saying nothing and render a noise message. Silence IS the ok. Anything else
            // (an embed error, a turn-based loop event) still wakes; an unrecognized shape wakes too.
            const embedOk = code === 0 && /^\[embed [^\n]*\] ok$/.test(text);
            if (code === 0 && text && !embedOk) {
              pi.sendUserMessage("typebulb wait result:\n" + text, { deliverAs: "followUp" });
            } else if (ctx.ui && typeof ctx.ui.notify === "function") {
              ctx.ui.notify("typebulb wait: " + (embedOk ? text : code === 2 ? "timed out, nothing to report" : "ended (code " + code + ")"), "info");
            }
          } catch (e) { logErr("exit", e && e.message); }
        });

        return {
          block: true,
          reason: "Armed in the background. You will be re-invoked automatically with the result when it is ready - do not run this command again; end your turn now and wait for the result.",
        };
      } catch (e) { logErr("tool_call", e && e.message); return undefined; }
    });

    try { pi.on("session_shutdown", () => { for (const c of pending) { try { c.kill(); } catch (e) {} } pending.clear(); }); } catch (e) {}
  } catch (e) { logErr("load", e && e.message); }
}
`

/** The extension with its path placeholders resolved — what ensurePiExtension actually writes. */
export function piExtensionSource(): string {
  return PI_EXTENSION_SOURCE
    .replace('"__TB_DESCRIPTION_PATH__"', JSON.stringify(bundledDescriptionPath()))
    .replace('"__TB_README_PATH__"', JSON.stringify(bundledReadmePath()))
}

/**
 * Write pi's `typebulb.ts` extension, gated on pi being present — NEVER throws (a best-effort side
 * task on the CLI hot path; a disk/permission error must not crash the user's actual `typebulb` command).
 * No `~/.pi/agent` → the user doesn't use pi → write nothing. Clobbers unconditionally: whatever typebulb
 * you run writes its own extension, so a downgrade lands that version's too — no stale file, no versioning.
 * The patcher extension rides the same call under the same contract; the two writes are independently
 * wrapped so one failing cannot stop the other.
 */
export function ensurePiExtension(): void {
  try {
    if (!existsSync(piHome())) return
  } catch { return }
  try {
    const target = extensionPath()
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, piExtensionSource())
    rmSync(legacyExtensionPath(), { force: true })
  } catch {}
  try {
    const asset = patcherAssetPath()
    if (!existsSync(asset)) return
    const target = patcherTargetPath()
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(asset, target)
  } catch {}
}
