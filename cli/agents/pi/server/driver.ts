// PiRpcDriver — the pi realization of the composer's AgentDriver (TB-Agent-Composer.md).
// Spawns the USER'S installed `pi` in RPC mode (JSONL over stdio — pi's docs/rpc.md, verified
// 0.80.3): `prompt` when idle, `steer` mid-turn, `abort` for Stop. Never a bundled pi — version,
// config, and billing stay the user's (what makes driving pi allowed where driving Claude wasn't).
// The driver renders nothing (Invariant C1): pi appends to the session file and the mirror's tail
// renders it; this class exposes only ephemeral state (draft, streaming, …) riding the poll.
// Framing is strict LF-delimited JSONL — Node `readline` is NOT protocol-compliant (it also splits
// on U+2028/U+2029, valid inside JSON strings), so the reader is the manual buffer-split.
import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { errorMessage } from '../../core/server/context.js'
import type { ComposerDialogRequest, ComposerQueue, ComposerStats, ComposerStatus } from '../../core/events.js'

interface RpcResponse { type: 'response'; id?: string; success?: boolean; error?: string; data?: Record<string, unknown> }

// The slice of pi's AgentMessage the draft needs: content blocks carrying text / thinking.
interface PiPartialMessage { role?: string; content?: { type?: string; text?: string; thinking?: string }[] }

// A queued blocking extension dialog. `until` is its expiry; `ownTimeout` says pi carried its own
// `timeout` (pi auto-resolves those itself — expiry drops silently) vs our fallback clock (expiry
// must answer cancelled so the extension unblocks — T3, TB-Agent-Composer-Toolkit.md).
interface PendingDialog { req: ComposerDialogRequest; until: number; ownTimeout: boolean }

const RESPONSE_TIMEOUT_MS = 30_000
// prompt acceptance → agent_start is near-instant; this only covers an extension command that runs
// no agent turn at all, so the optimistic shimmer can't stick forever.
const OPTIMISTIC_STREAM_MS = 5000
const DISPOSE_GRACE_MS = 2000
const STDERR_TAIL = 2000
// A dialog with no pi-side timeout still may not hang pi forever (a closed mirror tab must degrade
// to v1's auto-cancel, late instead of instantly).
const DIALOG_FALLBACK_MS = 120_000
const NOTICE_INFO_MS = 8000
const NOTICE_ALERT_MS = 15_000

// The composerRpc passthrough's allowlist (TB-Agent-Composer-Toolkit.md Piece 4). Deliberately NOT
// prompt/steer/follow_up — messages go through send()'s routing and the engine's guards, one door.
const RPC_ALLOW = new Set([
  'get_state', 'get_commands', 'get_available_models', 'set_model',
  'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'compact',
  'set_auto_compaction', 'get_fork_messages', 'fork', 'clone',
  'set_session_name', 'export_html', 'bash', 'abort_bash',
])

// Every live child, reaped synchronously if this process dies without a clean dispose. One listener,
// module-level — per-driver listeners would pile up across driver replacements.
const liveChildren = new Set<ChildProcess>()
process.on('exit', () => { for (const c of liveChildren) { try { c.kill() } catch { /* dying anyway */ } } })

// pi's docs/rpc.md reader: split on \n only, strip a trailing \r, decode across chunk boundaries.
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line) onLine(line)
    }
  })
}

export class PiRpcDriver {
  #child: ChildProcess | undefined
  #streaming = false
  #optimisticUntil = 0                       // send accepted, agent_start not yet seen
  #open = false                              // an assistant message is mid-accumulation
  #draft: { text: string; thinking: string } | null = null
  #echo: string | null = null                // the just-sent idle prompt, held until its durable row lands
  // Ambient status (TB-Agent-Composer-Toolkit.md Piece 2): an agent operation in progress (retry,
  // compaction — wins priority), a transient notice, and keyed extension setStatus entries.
  #op: ComposerStatus | null = null
  #notice: { text: string; kind: ComposerStatus['kind']; until: number } | null = null
  #extStatus = new Map<string, string>()
  #dialogs: PendingDialog[] = []             // FIFO of blocking extension dialogs (Piece 3)
  #queue: ComposerQueue | null = null        // pending steer/follow-up texts (queue_update; parity #2)
  #stats: ComposerStats | null = null        // pi's own session totals (get_session_stats; parity #5)
  #model: string | null = null               // pi's configured model id (get_state / set_model responses)
  #sessionFile: string | undefined
  #error: string | undefined
  #stderrTail = ''
  #nextId = 1
  #pending = new Map<string, { resolve: (r: RpcResponse) => void; timer: NodeJS.Timeout }>()
  #exited: Promise<void>
  #resolveExited!: () => void

  /** `spawnFn` is injectable for tests (fake stdio, no pi install). The real spawn is one command
   *  string under `shell: true` (`pi` resolves to `pi.cmd` on Windows); a `"` in the session path
   *  can't be quoted portably, so it's rejected up front. */
  constructor(cwd: string, sessionFile: string | undefined,
    spawnFn: (command: string, cwd: string) => ChildProcess = (command, dir) =>
      // TYPEBULB_MIRROR marks a mirror-driven pi (bash subshells inherit it): the skill tells the
      // agent the mirror is already open — skip `typebulb agent`, don't close with its link.
      spawn(command, { cwd: dir, shell: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TYPEBULB_MIRROR: '1' } })) {
    this.#exited = new Promise(res => { this.#resolveExited = res })
    if (sessionFile?.includes('"')) {
      this.#error = 'session path contains a quote — cannot drive it'
      this.#resolveExited()
      return
    }
    const command = sessionFile ? `pi --mode rpc --session "${sessionFile}"` : 'pi --mode rpc'
    let child: ChildProcess
    try {
      child = spawnFn(command, cwd)
    } catch (err) {
      this.#error = `could not start pi: ${errorMessage(err)}`
      this.#resolveExited()
      return
    }
    this.#child = child
    this.#sessionFile = sessionFile
    liveChildren.add(child)
    if (child.stdout) attachJsonlReader(child.stdout, line => this.#onLine(line))
    if (child.stderr) child.stderr.on('data', (b: Buffer) => { this.#stderrTail = (this.#stderrTail + b.toString()).slice(-STDERR_TAIL) })
    child.on('error', err => this.#die(`could not start pi: ${err.message}`))
    child.on('exit', code => {
      // A clean dispose already cleared #child; anything else is pi dying under us.
      if (this.#child === child) this.#die(code ? `pi exited (code ${code})${this.#stderrTail.trim() ? `: ${this.#stderrTail.trim()}` : ''}` : 'pi exited')
      liveChildren.delete(child)
      this.#resolveExited()
    })
    // Resolve the session file pi actually opened/created (the sessionless spawn's whole point;
    // for a --session spawn it confirms the path) and the configured model — the pill shows it
    // before any turn lands on disk. Best-effort: a timeout leaves both undefined/null.
    void this.#request({ type: 'get_state' }).then(r => {
      const f = r.data?.sessionFile
      if (typeof f === 'string' && f) this.#sessionFile = f
      const m = r.data?.model as { id?: unknown } | null | undefined
      if (m && typeof m.id === 'string' && m.id) this.#model = m.id
    }).catch(() => { /* stays undefined; the engine keeps its own binding */ })
    this.#refreshStats()                       // boot baseline (an existing session already has spend)
  }

  get streaming() { return this.#streaming || Date.now() < this.#optimisticUntil }
  get draft() { return this.#draft }
  get echo() { return this.#echo }
  get queue() { return this.#queue }
  get stats() { return this.#stats }
  get model() { return this.#model }
  get sessionFile() { return this.#sessionFile }
  get error() { return this.#error }

  /** One composed line: operation > fresh notice > joined extension statuses (expiry in-getter). */
  get status(): ComposerStatus | null {
    if (this.#op) return this.#op
    if (this.#notice) {
      if (Date.now() < this.#notice.until) return { text: this.#notice.text, kind: this.#notice.kind }
      this.#notice = null
    }
    if (this.#extStatus.size) return { text: [...this.#extStatus.values()].join(' · '), kind: 'info' }
    return null
  }

  /** The oldest unanswered dialog. Reading expires stale heads — the poll is the expiry clock
   *  (deliberate side effect; see the toolkit spec's gotchas). */
  get dialog(): ComposerDialogRequest | null {
    const now = Date.now()
    while (this.#dialogs.length) {
      const d = this.#dialogs[0]!
      if (now < d.until) return d.req
      this.#dialogs.shift()
      // pi resolved its own-timeout dialogs already; a fallback-clock one must be unblocked by us.
      if (!d.ownTimeout) this.#writeLine({ type: 'extension_ui_response', id: d.req.id, cancelled: true })
    }
    return null
  }

  /** A one-shot line for the status channel from outside the protocol (the adapter's trust
   *  notice rides this — parity #12). Same expiry rules as pi-originated notices. */
  notice(text: string, kind: ComposerStatus['kind']) { this.#setNotice(text, kind) }

  /** Answer a pending dialog. Unknown/expired ids are a soft error (pi may have timed it out). */
  respondUi(id: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): { ok: boolean; error?: string } {
    const i = this.#dialogs.findIndex(d => d.req.id === id)
    if (i < 0) return { ok: false, error: 'dialog expired or already answered' }
    const [d] = this.#dialogs.splice(i, 1)
    const payload: Record<string, unknown> = { type: 'extension_ui_response', id }
    if (resp.cancelled) payload.cancelled = true
    else if (d!.req.method === 'confirm') payload.confirmed = !!resp.confirmed
    else payload.value = resp.value ?? ''
    this.#writeLine(payload)
    return { ok: true }
  }

  /** The allowlisted passthrough (TB-Agent-Composer-Toolkit.md Piece 4). */
  async rpc(cmd: { type: string } & Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    if (!RPC_ALLOW.has(cmd.type)) return { ok: false, error: `command not allowed: ${cmd.type}` }
    try {
      const r = await this.#request(cmd)
      // A successful switch reports the new Model object back — keep the pill current immediately,
      // not at the next assistant turn (rpc.md: set_model's data IS the Model).
      if (r.success && cmd.type === 'set_model') {
        const id = (r.data as { id?: unknown } | undefined)?.id
        if (typeof id === 'string' && id) this.#model = id
      }
      // fork/clone move the pi process to a NEW session file (verified 0.80.3 — the old file is
      // left untouched); re-resolve the binding from the process's own report and hand the file
      // to the caller, so the fork/clone recipes can attach the view to it.
      if (r.success && (cmd.type === 'fork' || cmd.type === 'clone')) {
        try {
          const st = await this.#request({ type: 'get_state' })
          const f = st.data?.sessionFile
          if (typeof f === 'string' && f) this.#sessionFile = f
        } catch { /* keep the old binding — the recipe's attach becomes a no-op */ }
        return { ok: true, data: { ...(r.data ?? {}), sessionFile: this.#sessionFile } }
      }
      return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error ?? `pi rejected ${cmd.type}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** Idle → prompt; mid-turn → steer, or `follow_up` with opts.followUp (delivered only when the
   *  turn ends). A mid-turn slash command must go as a prompt (steer/follow_up REJECT extension
   *  commands; prompt runs them immediately even during streaming, and `streamingBehavior` queues
   *  anything else exactly like steer/follow_up — rpc.md, Prompting). */
  async send(text: string, opts?: { followUp?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const wasStreaming = this.streaming
    const cmd = wasStreaming
      ? (text.trimStart().startsWith('/')
          ? { type: 'prompt', message: text, streamingBehavior: opts?.followUp ? 'followUp' : 'steer' }
          : { type: opts?.followUp ? 'follow_up' : 'steer', message: text })
      : { type: 'prompt', message: text }
    let r: RpcResponse
    try { r = await this.#request(cmd) } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
    if (r.success && !wasStreaming) this.#optimisticUntil = Date.now() + OPTIMISTIC_STREAM_MS
    // Hold the prompt for the mirror to render now — pi flushes the user entry at message_end, so
    // the draft would otherwise render before the message that caused it. Mid-turn sends are in the
    // queue strip already; slash commands may run no turn and land no user entry to hand off to.
    if (r.success && !wasStreaming && !text.trimStart().startsWith('/')) this.#echo = text
    return r.success ? { ok: true } : { ok: false, error: r.error ?? 'pi rejected the message' }
  }

  async stop(): Promise<void> {
    if (!this.#child) return
    try { await this.#request({ type: 'abort' }) } catch { /* dying/hung — dispose is the backstop */ }
  }

  /** Engine hook: the durable transcript row arrived — drop a completed draft. One mid-accumulation
   *  (a NEW message is streaming) is kept; the completed text it replaced is already on disk. */
  clearCompletedDraft() { if (!this.#open) this.#draft = null }

  /** Engine hook: the durable user row arrived — drop the echoed prompt (the draft handoff, user side). */
  clearEcho() { this.#echo = null }

  /**
   * The disposal ladder: abort a live turn, grace; close stdin (pi exits on EOF — with shell:true
   * the pipe is pi's actual stdin, and killing the shell wrapper would NOT kill pi); grace; then a
   * tree-kill backstop (taskkill /T on Windows, kill() elsewhere). Idempotent.
   */
  async dispose(): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#child = undefined                    // exit handler now treats the exit as clean
    if (this.#streaming) {
      try { child.stdin?.write(JSON.stringify({ type: 'abort' }) + '\n') } catch { /* pipe gone */ }
      await Promise.race([this.#exited, delay(DISPOSE_GRACE_MS)])
    }
    try { child.stdin?.end() } catch { /* pipe gone */ }
    await Promise.race([this.#exited, delay(DISPOSE_GRACE_MS)])
    if (child.exitCode === null && !child.killed) {
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* best-effort */ }
      } else {
        try { child.kill('SIGKILL') } catch { /* best-effort */ }
      }
    }
    liveChildren.delete(child)
    this.#dialogs = []                         // pi is gone; nothing left to answer (T3)
    this.#failPending('pi was shut down')
  }

  // ── protocol ──

  #writeLine(payload: Record<string, unknown>) {
    try { this.#child?.stdin?.write(JSON.stringify(payload) + '\n') } catch { /* pipe gone */ }
  }

  #setNotice(text: string, kind: ComposerStatus['kind']) {
    const t = text.length > 200 ? text.slice(0, 200) + '…' : text
    if (!t) return
    this.#notice = { text: t, kind, until: Date.now() + (kind === 'info' ? NOTICE_INFO_MS : NOTICE_ALERT_MS) }
  }

  // Re-ask pi for its session totals (cost, context tokens/%) — pi's numbers verbatim, never our own
  // math (parity #5). Best-effort: a failure keeps the previous snapshot.
  #refreshStats() {
    void this.#request({ type: 'get_session_stats' }).then(r => {
      if (!r.success || !r.data) return
      const d = r.data as { cost?: number; contextUsage?: { tokens?: number | null; percent?: number | null } }
      this.#stats = {
        cost: typeof d.cost === 'number' ? d.cost : 0,
        contextTokens: typeof d.contextUsage?.tokens === 'number' ? d.contextUsage.tokens : null,
        contextPercent: typeof d.contextUsage?.percent === 'number' ? d.contextUsage.percent : null,
      }
    }).catch(() => { /* keep the previous snapshot */ })
  }

  #request(cmd: Record<string, unknown>): Promise<RpcResponse> {
    const child = this.#child
    if (!child?.stdin?.writable) return Promise.reject(new Error(this.#error ?? 'pi is not running'))
    const id = `tb-${this.#nextId++}`
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('pi did not respond (30s)'))
      }, RESPONSE_TIMEOUT_MS)
      timer.unref?.()
      this.#pending.set(id, { resolve, timer })
      try {
        child.stdin!.write(JSON.stringify({ id, ...cmd }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error(errorMessage(err)))
      }
    })
  }

  #onLine(line: string) {
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { return }             // startup noise / non-protocol output
    switch (e.type) {
      case 'response': {
        const r = e as unknown as RpcResponse
        const p = r.id ? this.#pending.get(r.id) : undefined
        if (p) { this.#pending.delete(r.id!); clearTimeout(p.timer); p.resolve(r) }
        return
      }
      case 'agent_start':
        this.#streaming = true
        this.#optimisticUntil = 0
        return
      case 'agent_end':
        this.#streaming = false
        this.#optimisticUntil = 0
        this.#open = false                                    // draft retained until the durable row lands
        this.#op = null                                       // belt: no operation outlives its turn
        this.#queue = null                                    // belt: a finished turn has nothing queued
        this.#refreshStats()                                  // the turn's spend just landed
        return
      case 'message_start': {
        const m = e.message as PiPartialMessage | undefined
        if (m?.role === 'assistant') { this.#open = true; this.#draft = { text: '', thinking: '' } }
        return
      }
      case 'message_update': {
        if (!this.#open) return
        // Rebuild from the partial message (not the deltas): replacement can't drift or double-append.
        const m = e.message as PiPartialMessage | undefined
        const blocks = Array.isArray(m?.content) ? m.content : []
        this.#draft = {
          text: blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join(''),
          thinking: blocks.filter(b => b?.type === 'thinking').map(b => b.thinking ?? '').join('\n'),
        }
        return
      }
      case 'message_end':
        this.#open = false                                    // completed; cleared when the tail emits it
        return
      case 'auto_retry_start':
        this.#op = { text: `retrying after a transient error (attempt ${Number(e.attempt) || 1}/${Number(e.maxAttempts) || '?'})…`, kind: 'warning' }
        return
      case 'auto_retry_end':
        this.#op = null
        if (e.success === false) this.#setNotice(`retries exhausted: ${String(e.finalError ?? 'unknown error')}`, 'error')
        return
      case 'compaction_start':
        this.#op = { text: 'compacting context…', kind: 'info' }
        return
      case 'compaction_end': {
        this.#op = null
        const result = e.result as { tokensBefore?: number; estimatedTokensAfter?: number } | null | undefined
        if (typeof e.errorMessage === 'string' && e.errorMessage) this.#setNotice(`compaction failed: ${e.errorMessage}`, 'error')
        else if (result?.tokensBefore) this.#setNotice(`compacted: ~${Math.round(result.tokensBefore / 1000)}k → ~${Math.round((result.estimatedTokensAfter ?? 0) / 1000)}k tokens`, 'info')
        this.#refreshStats()                                  // context % just changed shape
        return
      }
      case 'queue_update': {
        // The pending steer/follow-up texts (parity #2) — the client strip's data; empty ⇒ null.
        const steering = Array.isArray(e.steering) ? e.steering.map(String) : []
        const followUp = Array.isArray(e.followUp) ? e.followUp.map(String) : []
        this.#queue = steering.length || followUp.length ? { steering, followUp } : null
        return
      }
      case 'extension_ui_request': {
        // Blocking dialogs queue for the mirror to render (TB-Agent-Composer-Toolkit.md Piece 3); the
        // expiry clock guarantees pi never hangs on us (T3). notify/setStatus feed the status line;
        // the rest (setWidget, setTitle, …) stay dropped.
        const method = String(e.method ?? '')
        if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
          const timeout = typeof e.timeout === 'number' && e.timeout > 0 ? e.timeout : undefined
          this.#dialogs.push({
            req: {
              id: String(e.id ?? ''),
              method,
              title: typeof e.title === 'string' ? e.title : undefined,
              message: typeof e.message === 'string' ? e.message : undefined,
              options: Array.isArray(e.options) ? e.options.map(String) : undefined,
              placeholder: typeof e.placeholder === 'string' ? e.placeholder : undefined,
              prefill: typeof e.prefill === 'string' ? e.prefill : undefined,
            },
            until: Date.now() + (timeout ?? DIALOG_FALLBACK_MS),
            ownTimeout: timeout !== undefined,
          })
        } else if (method === 'notify') {
          const kind = e.notifyType === 'warning' ? 'warning' : e.notifyType === 'error' ? 'error' : 'info'
          this.#setNotice(String(e.message ?? ''), kind)
          // This echo lands in the mirror's <pid>.log — the wake bus `typebulb wait agent` matches by
          // substring — so nothing echoed here may quote a watched line verbatim: a quoted
          // "[embed <name>" tag re-fires the next same-match wait and loops (the wait shim defangs
          // its embed-ok notify for exactly this reason — TB-Wait.md, the shim invariants).
          console.log(`[composer] pi extension: ${String(e.message ?? '')}`)
        } else if (method === 'setStatus') {
          const key = String(e.statusKey ?? '')
          if (typeof e.statusText === 'string' && e.statusText) this.#extStatus.set(key, e.statusText)
          else this.#extStatus.delete(key)
        }
        return
      }
      default: return                                          // turn/tool events — the tail renders those
    }
  }

  // Fatal: pi died or never started while we still held it. The engine sees `error`, disposes, and
  // replaces the driver on the user's next send.
  #die(message: string) {
    this.#error = message
    this.#streaming = false
    this.#optimisticUntil = 0
    this.#open = false
    this.#draft = null
    this.#echo = null
    this.#op = null
    this.#notice = null
    this.#extStatus.clear()
    this.#dialogs = []
    this.#queue = null
    this.#stats = null
    this.#model = null
    this.#child = undefined
    this.#failPending(message)
  }

  #failPending(message: string) {
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.resolve({ type: 'response', success: false, error: message }) }
    this.#pending.clear()
  }
}

const delay = (ms: number) => new Promise<void>(res => { const t = setTimeout(res, ms); t.unref?.() })
