/**
 * File watcher for hot reload support.
 */

import chokidar from 'chokidar'
import fs from 'node:fs'
import path from 'node:path'

// Skip the initial scan, and let a write settle before firing so we never react
// to a half-written file or build artifact.
const WATCH_OPTIONS = {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 50,
  },
}

export interface WatcherOptions {
  /** File or directory to watch (a bulb file, a build-output dir). */
  target: string
  /** Called after a change settles. */
  onChange: () => void
  /** A bulb file reacts to 'change' only (add/unlink shouldn't trigger a doomed
   *  recompile); a build-output dir needs 'all' so added/removed files fire too. */
  events?: 'change' | 'all'
  /** Trailing debounce so one burst (an editor's format-on-save double-write, the
   *  multiple files a single build emits) collapses to one call. */
  debounceMs?: number
}

/** Watch a file or directory and invoke `onChange` once per settled change burst. */
export function watchPath(options: WatcherOptions): () => void {
  const { target, onChange, events = 'change', debounceMs = 150 } = options

  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = chokidar.watch(target, WATCH_OPTIONS)

  // A watcher error must never crash the server: an unhandled 'error' on an EventEmitter
  // throws out of emit (observed: Windows EBUSY when a watched assets/ file is still
  // mid-download). Log and keep watching — chokidar continues for the rest of the tree.
  watcher.on('error', err => console.warn(`watch: ${err instanceof Error ? err.message : err} — continuing`))

  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }
  if (events === 'all') watcher.on('all', fire)
  else watcher.on('change', fire)

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}

/** win32 and darwin resolve `assets` case-insensitively, so an `Assets/` folder IS the one the
 *  asset route serves and must reload; on Linux it is a different folder and never does. */
const isAssetsDir = (segment: string) =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? segment.toLowerCase() === 'assets'
    : segment === 'assets'

/** Watch a bulb's `assets/` for hot reload, rooted at the bulb's folder rather than on `assets/`.
 *
 *  Windows holds an open directory handle for every watched directory, and that handle refuses a
 *  rename or a move of every *ancestor* of the watched dir — never the watched dir itself, and
 *  never a hard delete. Watching `assets/` therefore left the bulb's own folder unmovable while it
 *  ran (Explorer's delete is a move to the Recycle Bin, so that failed too), while the `.bulb.md`
 *  beside it moved fine. One recursive watch on the folder puts the handle there instead, so the
 *  folder stays free and an `assets/` created after launch is picked up too. Recursive watching is
 *  unsupported on Linux before Node 20, which pins nothing anyway: watch `assets/` directly there. */
export function watchAssets(bulbDir: string, onChange: () => void, debounceMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }
  try {
    const watcher = fs.watch(bulbDir, { recursive: true }, (_event, name) => {
      // `name` is relative to the bulb folder; everything outside assets/ (a bulb's own tb.fs
      // output, which a reload would re-trigger) is not a reload.
      if (name && isAssetsDir(name.split(/[\\/]/)[0])) fire()
    })
    watcher.on('error', err => console.warn(`watch: ${err instanceof Error ? err.message : err} — continuing`))
    return () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  } catch {
    const assetsDir = path.join(bulbDir, 'assets')
    if (!fs.existsSync(assetsDir)) return () => {}
    return watchPath({ target: assetsDir, onChange, events: 'all', debounceMs })
  }
}
