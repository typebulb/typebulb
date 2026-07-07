import type { ComposerRecipe, RecipeCtx } from '../../core/client/types.js'
import { formatTokens, truncate } from '../../core/client/util.js'

// Pi's palette recipe table (TB-Agent-Composer-Toolkit.md Piece 5): the built-in TUI commands re-homed as
// dialog-driven RPC sequences, because pi's RPC mode does not execute them from prompt text (rpc.md:
// built-ins "would not execute if sent via prompt" — the silent footgun). A row earns its place by
// existing in pi's TUI or RPC surface, nothing else. The interpreter and modal primitives are the
// neutral Composer's; only this table knows pi command names. Everything durable a recipe causes
// (a fork moving the leaf, a compaction entry) renders from the transcript tail (T4).

const k = (n: number | undefined) => `~${formatTokens(n ?? 0)}`

// One rpc with the shared failure plumbing: a non-ok response throws (runRecipe surfaces it).
async function call(ctx: RecipeCtx, cmd: Parameters<RecipeCtx['rpc']>[0], fail: string): Promise<unknown> {
  const r = await ctx.rpc(cmd)
  if (!r.ok) throw new Error(r.error ?? fail)
  return r.data
}

// Best-effort get_state for preselecting pickers on the current value; undefined on failure
// (the select just opens at row 0).
async function state(ctx: RecipeCtx) {
  return (await ctx.rpc({ type: 'get_state' })).data as
    { model?: { provider?: string; id?: string }; thinkingLevel?: string } | undefined
}

export const piRecipes: ComposerRecipe[] = [
  {
    name: 'model',
    description: 'Switch the model',
    async run(ctx) {
      const data = await call(ctx, { type: 'get_available_models' }, 'could not list models')
      const models = ((data as { models?: { provider: string; id: string }[] })?.models) ?? []
      if (!models.length) return 'no models configured'
      const labels = models.map(m => `${m.provider}/${m.id}`)
      const cur = (await state(ctx))?.model
      const pick = await ctx.select('Switch model', labels, cur ? `${cur.provider}/${cur.id}` : undefined)
      if (pick === null) return
      const m = models[labels.indexOf(pick)]!
      await call(ctx, { type: 'set_model', provider: m.provider, modelId: m.id }, 'set_model failed')
      return `model: ${pick}`
    },
  },
  {
    name: 'thinking',
    description: 'Set the thinking level',
    async run(ctx) {
      const level = await ctx.select('Thinking level',
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], (await state(ctx))?.thinkingLevel)
      if (level === null) return
      await call(ctx, { type: 'set_thinking_level', level }, 'set_thinking_level failed')
      return `thinking: ${level}`
    },
  },
  // compact/fork/clone: hidden until live-verified (fork-in-same-file rendering and clone's
  // driver-binding aftermath are the open risks; compact spends). Flip `hidden` off to re-enable.
  {
    name: 'compact',
    description: 'Compact the conversation context',
    hidden: true,
    async run(ctx) {
      const instructions = await ctx.input('Compact context', 'optional instructions — Enter to compact')
      if (instructions === null) return
      const d = await call(ctx, { type: 'compact', ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}) },
        'compact failed') as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined
      return d?.tokensBefore ? `compacted: ${k(d.tokensBefore)} → ${k(d.estimatedTokensAfter)} tokens` : 'compacted'
    },
  },
  {
    name: 'fork',
    description: 'Fork from an earlier message',
    hidden: true,
    async run(ctx) {
      const data = await call(ctx, { type: 'get_fork_messages' }, 'could not list fork points')
      const msgs = ((data as { messages?: { entryId: string; text: string }[] })?.messages) ?? []
      if (!msgs.length) return 'nothing to fork from'
      const labels = msgs.map((m, i) => `${i + 1}. ${truncate(m.text, 80)}`)
      const pick = await ctx.select('Fork from…', labels)
      if (pick === null) return
      const m = msgs[labels.indexOf(pick)]!
      const text = (await call(ctx, { type: 'fork', entryId: m.entryId }, 'fork failed') as { text?: string } | undefined)?.text
      if (text) ctx.setInput(text)
      return 'forked — edit the restored prompt and send'
    },
  },
  {
    name: 'clone',
    description: 'Duplicate this branch into a new session',
    hidden: true,
    async run(ctx) {
      if (!(await ctx.confirm('Clone session?', 'Duplicates the current branch into a new session file.'))) return
      await call(ctx, { type: 'clone' }, 'clone failed')
      return 'cloned into a new session'
    },
  },
  {
    name: 'name',
    description: 'Name this session',
    async run(ctx) {
      const name = await ctx.input('Session name')
      if (name === null || !name.trim()) return
      await call(ctx, { type: 'set_session_name', name: name.trim() }, 'set_session_name failed')
      return `named: ${name.trim()}`
    },
  },
  {
    name: 'export',
    description: 'Export the session to HTML',
    async run(ctx) {
      return `exported: ${(await call(ctx, { type: 'export_html' }, 'export failed') as { path?: string } | undefined)?.path ?? 'done'}`
    },
  },
  {
    name: 'stats',
    description: 'Token usage, cost, and context headroom',
    // hidden: redundant with the token pill (cost + context %), and its cumulative tokens.total
    // reads as context usage — distracting. The pill is the stats surface.
    hidden: true,
    async run(ctx) {
      const d = await call(ctx, { type: 'get_session_stats' }, 'get_session_stats failed') as
        { tokens?: { total?: number }; cost?: number; contextUsage?: { percent?: number | null } } | undefined
      const parts = [
        d?.tokens?.total !== undefined ? `${k(d.tokens.total)} tokens` : null,
        d?.cost !== undefined ? `$${d.cost.toFixed(2)}` : null,
        d?.contextUsage?.percent != null ? `context ${d.contextUsage.percent}%` : null,
      ].filter(Boolean)
      return parts.length ? parts.join(' · ') : 'no stats yet'
    },
  },
]
