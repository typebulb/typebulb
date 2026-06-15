/**
 * File watcher for hot reload support.
 */

import chokidar from 'chokidar'
import type { EventEmitter } from 'events'

// Shared across both watchers: skip the initial scan, and let a write settle
// before firing so we never react to a half-written build artifact.
const WATCH_OPTIONS = {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 50,
  },
}

export interface WatcherOptions {
  bulbPath: string
  emitter: EventEmitter
  /** Trailing debounce so a rapid save-burst (an editor's format-on-save double-write, a few
   *  edits saved back-to-back) collapses to one reload instead of one restart per save. */
  debounceMs?: number
}

/** Watch a bulb file for changes */
export function watchBulb(options: WatcherOptions): () => void {
  const { bulbPath, emitter, debounceMs = 150 } = options

  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = chokidar.watch(bulbPath, WATCH_OPTIONS)

  watcher.on('change', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => emitter.emit('reload'), debounceMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}

export interface DirWatcherOptions {
  /** Directory to watch (e.g. a local override's served `dist/`). */
  dir: string
  /** Called after a change settles. */
  onChange: () => void
  /** Trailing debounce so one build burst (`index.js` + `.map` + worker) = one call. */
  debounceMs?: number
}

/**
 * Watch a directory of build output and invoke `onChange` once per build burst.
 * `awaitWriteFinish` (same as the bulb watcher) prevents firing on a half-written
 * file; the trailing debounce collapses the multiple files a single build emits.
 */
export function watchDir(options: DirWatcherOptions): () => void {
  const { dir, onChange, debounceMs = 150 } = options

  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = chokidar.watch(dir, WATCH_OPTIONS)

  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    void watcher.close()
  }
}
