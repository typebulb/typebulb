/**
 * The typebulb pi extension — typebulb's general presence inside every pi session, installed as
 * `~/.pi/agent/extensions/typebulb.ts`. Three jobs today: the background-wait shim, the
 * mirror-driven orientation block, and — in a mirror-driven session only — the inline bulb
 * session watcher, which holds the render subscription so the agent arms nothing (TB-Wait.md).
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
 * `typebulb wait …` bash call, blocks the foreground execution (so the turn ends and the inline bulb/turn
 * renders), spawns the real `typebulb wait` in the background itself, and on its exit injects the
 * outcome via `pi.sendUserMessage` — pi's own native "trigger a turn" facility, the analogue of CC's
 * process-exit notification. Because it just runs the real `typebulb wait`, pi inherits all of it for
 * free (the `--match` semantics, the from-0 offset, the no-give-up-clock subscription) and it generalises to BOTH the inline bulb
 * loop and the turn-based bulb loop. The agent-facing instruction stays the one harness-agnostic line.
 *
 * The same extension also carries the composer's guaranteed-delivery orientation: on every turn of a
 * MIRROR-DRIVEN session (TYPEBULB_MIRROR=1, set by PiRpcDriver's spawn env) its before_agent_start
 * handler appends the inline bulb-vs-local decision block — the one `typebulb agent` prints for kickoff
 * flows (commands/agent.ts) — to the system prompt. Ambient skill discovery alone demonstrably fails
 * weaker models (they plan a .bulb.md when asked to show something inline); in-context delivery is
 * what fixed it for the kickoff flow, and this is that same fix for the flow that never runs the
 * command. Terminal pi sessions carry no marker and get no block.
 *
 * typebulb writes the extension into pi's global extensions dir itself (`ensurePiExtension`), gated on pi
 * being present — Claude-Code-only users never get a byte written. pi can't be *told* to load it
 * (no `/reload` typebulb can trigger), so a freshly-placed shim activates on pi's next session start;
 * the one un-activated first session degrades to the optimistic tier (no wake).
 *
 * Lives under `agents/pi/server/` with the rest of the pi adapter — it is pi-specific, even though it's
 * called from the CLI core (`src/index.ts`, `src/commands/agent.ts`), the same src→`agents/pi/server`
 * direction `agentViewer/resolve.ts` already uses for `PiAdapter`. Imported as this bare module, not
 * the pi server barrel, so it pulls in no mirror/createMirror boot.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { bundledSkillPath, typebulbBinPath } from '../../../src/servers.js'

const piHome = () => path.join(homedir(), '.pi', 'agent')
const extensionPath = () => path.join(piHome(), 'extensions', 'typebulb.ts')
// Extensions typebulb used to install and must now REMOVE on sight — pi loads every file in
// extensions/, so a leftover keeps running forever. `typebulb-wait.ts` is the pre-generalization
// name of the file above (a stale copy double-registers the wait interceptor, double-spawning every
// background wait). `matchu-patchu.ts` was the pi patcher extension: it deleted pi's built-in `edit`
// on session_start, so leaving it behind would keep that tool gone long after we stopped shipping it.
const staleExtensionPaths = () =>
  ['typebulb-wait.ts', 'matchu-patchu.ts'].map(f => path.join(piHome(), 'extensions', f))

/**
 * The shim source, written verbatim into pi's extensions dir and loaded by pi (via jiti) inside the
 * pi process — so `node:*` builtins are available and `pi`/`ctx`/`sendUserMessage` are pi's own.
 * The `__TB_SKILL_PATH__` placeholder is the exception to "verbatim": `piExtensionSource()` resolves
 * it to this install's absolute packaged-SKILL.md path at write time (JSON-encoded, so Windows
 * backslashes survive as valid JS string escapes).
 *
 * `String.raw` so the regex backslashes (`\b`, `\s`) and the `\n` survive into the file literally
 * rather than being processed by this enclosing template. Keep this body free of backticks and `${`.
 * Everything is wrapped so a throw can NEVER break pi's startup — a future pi API change degrades the
 * loop to the optimistic tier (no wake), never "pi won't boot".
 */
export const PI_EXTENSION_SOURCE = String.raw`// Generated by typebulb — do not edit; overwritten on each run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function logErr(...a) { try { console.error("[typebulb]", ...a); } catch (e) {} }

// Matches "typebulb wait", "npx typebulb wait", "/path/to/typebulb wait", "pnpm exec typebulb wait", etc.
function isWaitCommand(command) { return /\btypebulb\s+wait\b/.test(String(command || "")); }

// The fold's key (TB-Wait.md): an INLINE render wait, never "a wait was intercepted". A local bulb's
// own wait (typebulb wait ./chess.bulb.md --match "[chess]") keeps taking the shim path untouched.
function isInlineWait(command) { return isWaitCommand(command) && String(command || "").indexOf("[inline ") >= 0; }

// One mirror status line, as logInlineStatus writes it. ANCHORED: the composer driver echoes our own
// notifies into that same log, so a tag quoted mid-line must not read as a status line.
function parseInline(line) {
  var m = /^\[inline (.+?) v(\d+)\] (.*)$/.exec(String(line || "").trim());
  return m ? { name: m[1], version: Number(m[2]), verdict: m[3] } : null;
}

// The four forwarded outcomes are ok / malformed / compile error / runtime error; all but ok cost a turn.
function isBroken(verdict) { return /^(compile error|runtime error|malformed)\b/.test(String(verdict || "")); }

// The wake decision for one status line, against the names THIS session emitted (own) and the
// per-name state (seen: the 3-wake cap plus a repeat guard, so a re-render of one version is free).
// Kept pure but for the seen map, so piDriver.test.ts can lift it out of this source and test it.
function wakeFor(line, own, seen) {
  var text = String(line || "").trim();
  var s = parseInline(text);
  if (!s || !own.has(s.name)) return null;
  var prev = seen.get(s.name) || { count: 0, last: "" };
  var skip = !isBroken(s.verdict) || prev.last === text || prev.count >= 3;
  prev.last = text;
  if (!skip) prev.count += 1;
  seen.set(s.name, prev);
  return skip ? null : { name: s.name, line: text, count: prev.count };
}

// The third wake escalates instead of asking for a fourth fix: three failed inline repairs is a
// venue error, not a bug to keep chasing (TB-Wait.md).
function wakeText(w) {
  return w.count >= 3
    ? "typebulb: " + w.line + "\nThat is three failed repairs of this inline bulb. Stop iterating inline: write it as a .bulb.md, gate it with typebulb check, and tell the user why you moved it."
    : "typebulb: " + w.line + "\nAn inline bulb you rendered is broken. Emit a same-named inline bulb with the fix. Nothing to arm: this session is watched, and a clean render stays silent.";
}

// The fold's reply. Delivered by MUTATING the bash command into an echo of it rather than blocking:
// pi renders a blocked call as an error result, which is exactly what taught a model to stop arming
// waits at all. Apostrophe-free — it rides inside single quotes.
var WATCHED_NOTE = "typebulb: this render is already watched for you. You will be woken if it breaks, and a clean render stays silent. Nothing to arm.";

// pi's bash tool runs every command under Git Bash on Windows (its getShellConfig), so the
// intercepted string is POSIX. Re-running it under node's shell:true (cmd.exe on Windows) breaks
// that syntax — cmd doesn't split on ";", so a trailing "; echo ..." rides along as extra ARGS to
// typebulb wait, which resolves a garbage target and dies code 1 before the event (field: a wait
// that resolved the target 'exit: $?'). Resolve bash the way pi does; null → shell:true (POSIX sh).
function resolveBash() {
  try {
    if (process.platform !== "win32") return existsSync("/bin/bash") ? "/bin/bash" : null;
    var dirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i] && existsSync(dirs[i] + "\\Git\\bin\\bash.exe")) return dirs[i] + "\\Git\\bin\\bash.exe";
    }
    return "bash.exe"; // PATH fallback (Cygwin/MSYS2); a spawn miss lands in the "error" handler
  } catch (e) { return null; }
}

// Resolved at shim-write time to this install's absolute packaged SKILL.md (the same path
// commands/agent.ts prints — readable without a permission prompt, and too big to emit on stdout).
var TB_SKILL_PATH = "__TB_SKILL_PATH__";

// Resolved at shim-write time to this package's own bin — the session watcher runs THIS typebulb,
// never an unpinned "npx typebulb" (a different install skews the disk state they share).
var TB_BIN = "__TB_BIN_PATH__";

// Orientation for a MIRROR-DRIVEN session (TYPEBULB_MIRROR=1 — set only by the mirror's composer
// driver). A composer-driven agent never runs "typebulb agent", so the guaranteed-delivery block
// that command prints (commands/agent.ts) never reaches it; this re-delivers it via the system
// prompt. The wording below is copied from agent.ts, hard-won across many failed interactions —
// change it there first. Two divergences: the mirror-link lines (the user is already IN the
// mirror), and the arming lines, dropped because the session watcher holds that wait (TB-Wait.md).
var TB_MIRROR_BLOCK = [
  "Typebulb: the user is prompting you from the typebulb agent mirror (already open in front of them).",
  "  Inline bulbs render live in this conversation.",
  "  • do not run npx typebulb agent — the mirror is already running",
  "  • no need to end your reply with a mirror link",
  "  Reusable app/tool → write a .bulb.md",
  "  Show something inline → emit an inline bulb",
  "  Read the authoring skill before writing a bulb:",
  "    • " + TB_SKILL_PATH,
].join("\n");

export default function (pi) {
  try {
    const pending = new Set();

    // ── the session watcher: typebulb holds the subscription, the agent arms nothing (TB-Wait.md) ──
    var watcher = null;            // the standing follow-mode typebulb wait child
    var stopping = false;          // set at session_shutdown, so a reaped watcher never respawns
    var ownNames = new Set();      // bulb names THIS session emitted — the wake gate
    var seen = new Map();          // name -> { count, last }

    function onStatusLine(line) {
      try {
        var w = wakeFor(line, ownNames, seen);
        if (w) pi.sendUserMessage(wakeText(w), { deliverAs: "followUp" });
      } catch (e) { logErr("status", e && e.message); }
    }

    // ONE standing tail of this cwd's mirror log for the whole session, matching every inline tag.
    // TYPEBULB_WAIT_FOLLOW makes it a continuous consumer: it never exits on a match, so it holds no
    // cursor (which concurrent sessions would share under this same --match) and needs no re-arm.
    // Spawned argv-direct on our own bin: the command is ours, not the agent's POSIX string, so no
    // shell is involved and the bracketed match needs no quoting.
    function startWatcher() {
      if (watcher || stopping || process.env.TYPEBULB_MIRROR !== "1") return;
      try {
        const child = spawn(process.execPath, [TB_BIN, "wait", "agent", "--match", "[inline "], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TYPEBULB_WAIT_SHIM: "1", TYPEBULB_WAIT_FOLLOW: "1" },
        });
        watcher = child;
        let buf = "";
        if (child.stdout) child.stdout.on("data", (b) => {
          buf += b.toString();
          const parts = buf.split("\n");
          buf = parts.pop() || "";
          for (const line of parts) onStatusLine(line);
        });
        if (child.stderr) child.stderr.resume();   // drained, never buffered: a full pipe would stall the tail
        child.on("error", (e) => { watcher = null; logErr("watcher", e && e.message); });
        // The agent armed nothing here, so a dead watcher costs the safety net, not the session (the
        // inverse of the intercepted-wait rule below): log and stand down. Never respawn — a watcher
        // that exits instantly would hot-loop — and never sendUserMessage a plumbing failure.
        child.on("exit", (code) => {
          watcher = null;
          if (!stopping) logErr("watcher exited (code " + code + ") — inline bulbs are unwatched for the rest of this session");
        });
      } catch (e) { watcher = null; logErr("watcher", e && e.message); }
    }

    pi.on("session_start", () => { try { startWatcher(); } catch (e) { logErr("session_start", e && e.message); } });

    // The gate a wake must pass: a name this session itself emitted. The mirror's log is per MIRROR,
    // so ungated, session A gets woken to "fix" a bulb session B wrote — into its own transcript. A
    // name SET, not a transcript buffer: bounded by this session's own bulbs, and no fence parsing.
    pi.on("message_end", (event) => {
      try {
        const msg = event && event.message;
        if (!msg || msg.role !== "assistant") return undefined;
        const c = msg.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
        if (text.indexOf("format: typebulb/v1") < 0) return undefined;
        const re = /^name:[ \t]*(\S.*)$/gm;
        let m;
        while ((m = re.exec(text))) ownNames.add(m[1].trim());
      } catch (e) { logErr("message_end", e && e.message); }
      return undefined;
    });

    pi.on("before_agent_start", (event) => {
      try {
        if (process.env.TYPEBULB_MIRROR !== "1") return undefined;
        startWatcher();                        // idempotent — covers an instance bound mid-session
        return { systemPrompt: event.systemPrompt + "\n\n" + TB_MIRROR_BLOCK };
      } catch (e) { logErr("before_agent_start", e && e.message); return undefined; }
    });

    pi.on("tool_call", (event, ctx) => {
      try {
        if (!event || event.toolName !== "bash") return undefined;
        const command = event.input && event.input.command;
        if (!isWaitCommand(command)) return undefined;

        // Under the watcher this render is already subscribed, so a manual arm spawns nothing: a
        // second subscription double-wakes. The reply rides in as a MUTATED command (pi documents
        // event.input as mutable), so the tool result is green rather than the error-marked block
        // below. Keyed on the inline tag, and on a watcher actually running — a local bulb's wait,
        // or a session whose watcher never started, falls through to the shim path (TB-Wait.md).
        if (watcher && isInlineWait(command)) {
          event.input.command = "echo '" + WATCHED_NOTE + "'";
          return undefined;
        }

        // Run the REAL typebulb wait in the background instead of foreground (which would deadlock the
        // turn). It does the mirror/registry lookup, --match and offsets itself. The marker tells it this
        // is a shim-backgrounded (non-blocking) wait, so it runs as a pure subscription: no give-up clock,
        // it waits for the event however long (bounded by the session-shutdown reap below) — an inline bulb's
        // first paint OR a running bulb's next event line alike.
        // The agent may self-background ("… &") — the generic-shell reading of "arm it in the
        // background", but here the SHIM is the backgrounder: bash would exit 0 instantly with empty
        // output, firing the wake before the event while the detached wait delivers to nobody
        // (field: Toroidal Life, '> /tmp/x.log 2>&1 &'). Strip a trailing "&" so the wait runs
        // foreground inside the shim's already-backgrounded child.
        const cmd = String(command).replace(/(?<!&)\s*&\s*$/, "");
        const bash = resolveBash();
        const opts = {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TYPEBULB_WAIT_SHIM: "1" },
        };
        const child = bash ? spawn(bash, ["-c", cmd], opts) : spawn(cmd, { ...opts, shell: true });
        pending.add(child);
        let out = "";
        let errOut = "";
        if (child.stdout) child.stdout.on("data", (b) => { out += b.toString(); });
        if (child.stderr) child.stderr.on("data", (b) => { errOut += b.toString(); });
        child.on("error", (e) => {
          pending.delete(child);
          logErr("spawn", e && e.message);
          // Same class as a failure exit: the subscription never armed, so silence is a deadlock.
          try { pi.sendUserMessage("typebulb wait FAILED to spawn: " + (e && e.message) + "\nNothing is watching — fix and re-arm the wait.", { deliverAs: "followUp" }); } catch (e2) {}
        });
        child.on("exit", (code) => {
          pending.delete(child);
          try {
            const text = out.trim();
            // Exit 0 with output is a real outcome (inline bulb ok/error, a turn-based move) -> wake the
            // agent (followUp delivers immediately when idle and queues when streaming — the same call
            // git-merge-and-resolve.ts makes from agent_end). A late wake is fine; it just reports
            // something true. Exit 2/3 (no render yet / server gone) surface passively, no turn.
            // Any OTHER non-zero exit means the subscription itself broke (bad args, no resolvable
            // mirror): the agent parked on a wake that can never come, so that failure must wake too —
            // missed wakes are fatal, spurious wakes cheap (TB-Wait.md). null (reap-killed) stays silent.
            // EXCEPT an inline bulb's clean ok verdict ("[inline <name> vN] ok" — core/client/inlineBulb.ts):
            // the user already sees the bulb and the skill orders silence on ok, so a wake would spend
            // a whole turn saying nothing and render a noise message. Silence IS the ok. Anything else
            // (an inline error, a turn-based loop event) still wakes; an unrecognized shape wakes too.
            // Checked PER LINE, not over the whole blob: wait lingers 10s and bursts every matching line
            // into one payload, and a version-agnostic --match ("[inline <name>") replays v1+v2+... from
            // log start, so an all-ok payload is routinely multi-line. Suppress iff EVERY line is an ok;
            // one error line among oks still wakes.
            var waitLines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
            const inlineOk = code === 0 && waitLines.length > 0 && waitLines.every(function (l) { return /^\[inline .*\] ok$/.test(l); });
            if (code === 0 && text && !inlineOk) {
              pi.sendUserMessage("typebulb wait result:\n" + text, { deliverAs: "followUp" });
            } else if (code === 0 && !text) {
              // A successful wait always prints its matched line(s), so exit 0 with nothing captured
              // means the agent redirected stdout (e.g. '> /tmp/x.log 2>&1') — the verdict landed in a
              // file nobody reads. The line is still in the mirror's log; point the agent there.
              pi.sendUserMessage("typebulb wait ended (exit 0) but its output was redirected away — read the verdict with: typebulb logs agent\nNext time run the wait plainly: no output redirect, no trailing &.", { deliverAs: "followUp" });
            } else if (code !== null && code !== 0 && code !== 2 && code !== 3) {
              var diag = (text + "\n" + errOut.trim()).trim();
              pi.sendUserMessage("typebulb wait FAILED (exit " + code + ")" + (diag ? ":\n" + diag : " with no output.") + "\nThe wait never armed — nothing is watching. Fix the command and re-arm it.", { deliverAs: "followUp" });
            } else if (ctx.ui && typeof ctx.ui.notify === "function") {
              // INVARIANT: this notify must never quote the "[inline <name>" tag verbatim. In a
              // composer-driven session the mirror's driver echoes extension notifies into the
              // mirror's own log (driver.ts) — the very log wait watches by substring — so a
              // verbatim tag re-fires the next same-match wait with a non-ok line: a self-
              // sustaining wake loop that defeats this suppression (TB-Wait.md). Stripping the
              // brackets kills the matchable substring while keeping the verdict readable.
              ctx.ui.notify("typebulb wait: " + (inlineOk ? text.replace(/[\[\]]/g, "") : code === 2 ? "timed out, nothing to report" : "ended (code " + code + ")"), "info");
            }
          } catch (e) { logErr("exit", e && e.message); }
        });

        return {
          block: true,
          reason: "Armed in the background for this emit. Do not run it again this turn; end your turn now. You will be re-invoked if the render reports a problem, a clean render stays silent, and each new emit takes a fresh wait.",
        };
      } catch (e) { logErr("tool_call", e && e.message); return undefined; }
    });

    try { pi.on("session_shutdown", () => { stopping = true; if (watcher) { try { watcher.kill(); } catch (e) {} watcher = null; } for (const c of pending) { try { c.kill(); } catch (e) {} } pending.clear(); }); } catch (e) {}
  } catch (e) { logErr("load", e && e.message); }
}
`

/** The extension with its path placeholder resolved — what ensurePiExtension actually writes. */
export function piExtensionSource(): string {
  return PI_EXTENSION_SOURCE
    .replace('"__TB_SKILL_PATH__"', JSON.stringify(bundledSkillPath()))
    .replace('"__TB_BIN_PATH__"', JSON.stringify(typebulbBinPath()))
}

/**
 * Write pi's `typebulb.ts` extension, gated on pi being present — NEVER throws (a best-effort side
 * task on the CLI hot path; a disk/permission error must not crash the user's actual `typebulb` command).
 * No `~/.pi/agent` → the user doesn't use pi → write nothing. Whatever typebulb you run owns the file's
 * content, so a downgrade lands that version's too — no stale file, no versioning. Idempotent by CONTENT,
 * not an unconditional clobber: this runs before EVERY command under EVERY harness (src/index.ts), so a
 * clobber put a 10KB script write into pi's extensions dir on `typebulb --version` — a per-invocation cost
 * claude- and codex-only users pay for pi, on a file pi may be reading at that moment.
 */
export function ensurePiExtension(): void {
  try {
    if (!existsSync(piHome())) return
  } catch { return }
  try {
    const target = extensionPath()
    const source = piExtensionSource()
    let current: string | undefined
    try { current = readFileSync(target, 'utf8') } catch { /* absent or unreadable ⇒ write it */ }
    if (current !== source) {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, source)
    }
  } catch {}
  // Wrapped per path, separately from the write: a failed write must not skip the reap, and a
  // left-behind matchu-patchu.ts is the one that costs the user their `edit` tool.
  for (const stale of staleExtensionPaths()) {
    try { rmSync(stale, { force: true }) } catch {}
  }
}
