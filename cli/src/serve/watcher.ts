/**
 * File watcher for hot reload support.
 */

import chokidar from 'chokidar'

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
