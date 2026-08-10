/**
 * The composer's clipboard-capture pipeline (TB-Agent-Composer-Toolkit.md Piece 6): pasted content
 * becomes a durable file under `<cwd>/.typebulb/paste/`, and the composer inserts its @-mention —
 * the path-reference pattern that supersedes wire-attached base64 images (TB-Agent-Composer-Parity.md
 * #3). A path costs ~10 tokens until the agent chooses to read it, stays re-referenceable across
 * turns, and keeps the session JSONL (which the mirror re-parses constantly) free of blobs.
 *
 * Text pastes get a descriptive kebab-case name from the shared cheap-model ladder (cheapAi.ts); no
 * key, a timeout, or any error falls back to a timestamp name. Naming is a nicety — it must never
 * block or fail a paste.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { cheapAi } from './cheapAi.js'
import { errorMessage } from './context.js'
import { PASTE_DIR, PASTE_IMAGE_MIME } from '../events.js'

const NAME_TIMEOUT_MS = 4000
const NAME_SNIPPET_CHARS = 4000

export interface PasteRequest { kind: 'image' | 'text'; data: string; mime?: string }

// 20260707-142530 — local time, sortable, filename-safe.
function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** A model reply → a safe kebab-case stem; '' when nothing usable survives. */
export function slugifyPasteName(reply: string): string {
  return reply.trim().toLowerCase()
    .replace(/\.[a-z0-9]{1,4}$/, '')           // drop an extension the model added anyway
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// One cheap completion → a filename stem, or undefined on any failure (the caller timestamps).
async function nameText(text: string): Promise<string | undefined> {
  const reply = await cheapAi(
    `Reply with ONLY a short kebab-case filename (2-5 words, lowercase, no extension) describing this text:\n\n${text.slice(0, NAME_SNIPPET_CHARS)}`,
    NAME_TIMEOUT_MS,
  )
  return reply ? (slugifyPasteName(reply) || undefined) : undefined
}

/** Write one captured clipboard payload under `.typebulb/paste/` and return its project-relative
 *  path (posix separators — it's inserted into a prompt, not passed to fs). */
export async function savePaste(cwd: string, req: PasteRequest): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!req || (req.kind !== 'image' && req.kind !== 'text')) return { ok: false, error: 'bad paste kind' }
  if (typeof req.data !== 'string' || !req.data) return { ok: false, error: 'empty paste' }
  const dir = join(cwd, PASTE_DIR)
  try { mkdirSync(dir, { recursive: true }) } catch (err: unknown) { return { ok: false, error: errorMessage(err) } }
  let stem: string
  let ext: string
  let content: Buffer | string
  if (req.kind === 'image') {
    stem = `img-${timestamp()}`
    ext = Object.keys(PASTE_IMAGE_MIME).find(e => PASTE_IMAGE_MIME[e] === req.mime) ?? 'png'
    content = Buffer.from(req.data, 'base64')
    if (!content.length) return { ok: false, error: 'empty image data' }
  } else {
    stem = (await nameText(req.data)) ?? `paste-${timestamp()}`
    ext = 'md'
    content = req.data
  }
  let name = `${stem}.${ext}`
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.${ext}`
  try { writeFileSync(join(dir, name), content) } catch (err: unknown) { return { ok: false, error: errorMessage(err) } }
  return { ok: true, path: `${PASTE_DIR}/${name}` }
}

/** Read one pasted image back as base64 for the transcript thumbnail. `name` is a bare filename
 *  inside the paste dir — anything path-like is refused, so the mirror serves nothing else. */
export function readPaste(cwd: string, name: string): { ok: true; mime: string; base64: string } | { ok: false; error: string } {
  if (!/^[\w-]+(\.[\w-]+)*$/.test(name)) return { ok: false, error: 'bad name' }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const mime = PASTE_IMAGE_MIME[ext]
  if (!mime) return { ok: false, error: 'not an image' }
  try { return { ok: true, mime, base64: readFileSync(join(cwd, PASTE_DIR, name)).toString('base64') } }
  catch { return { ok: false, error: 'not found' } }
}
