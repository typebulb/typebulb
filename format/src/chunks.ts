/**
 * Split the `data.txt` block into chunks. The single source of truth, shared by the CLI and
 * typebulb.com.
 *
 * Rules:
 * - A valid structural format (JSON/XML/YAML) → a single chunk (preserves internal blank lines).
 * - Otherwise → split on 2+ blank lines.
 */

import { isStructuralData } from './detection.js'

/** Separator for rejoining chunks (2 blank lines = 3 newlines). */
export const CHUNK_SEPARATOR = '\n\n\n'

export type ChunkWithBoundaries = { text: string; startLine: number; endLine: number }

/** Split raw data into chunks with their 1-based line boundaries. */
export function splitIntoChunksWithBoundaries(raw: string): ChunkWithBoundaries[] {
  if (!raw?.trim()) return []

  const normalized = raw.replace(/\r\n/g, '\n')
  const trimmed = normalized.trim()

  if (isStructuralData(trimmed)) {
    return [{ text: trimmed, startLine: 1, endLine: normalized.split('\n').length }]
  }

  const lines = normalized.split('\n')
  const chunks: ChunkWithBoundaries[] = []
  let start = 0, lastContent = -1, blankRun = 0

  const flush = () => {
    if (lastContent >= start) {
      const text = lines.slice(start, lastContent + 1).join('\n').trim()
      if (text) chunks.push({ text, startLine: start + 1, endLine: lastContent + 1 })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) {
      blankRun++
    } else {
      if (blankRun >= 2 && lastContent >= start) { flush(); start = i }
      blankRun = 0
      lastContent = i
    }
  }
  flush()

  return chunks
}

/** Convenience: just the chunk texts. */
export function splitIntoChunks(raw: string): string[] {
  return splitIntoChunksWithBoundaries(raw).map(c => c.text)
}
