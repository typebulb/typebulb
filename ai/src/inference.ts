/**
 * Inference layer shared by typebulb.com and the CLI (TB-Inference.md): the prompt template,
 * the LLM-output JSON sanitizer, and the `#tb=` result encoding. Single-sourced here so the two
 * surfaces may differ in UX but never in what is sent, how output is repaired, or how a result
 * is encoded for sharing.
 */

import { strToU8, strFromU8, deflateSync, inflateSync } from 'fflate'

// ─── Prompt builder ──────────────────────────────────────────────────────────

export interface InferenceScriptContent {
  /** Inference instructions (markdown) */
  infer?: string
  /** Example insight output (JSON string) */
  insight?: string
  /** Script code that will consume the output */
  code?: string
}

/**
 * Build the inference prompt from script content and data
 */
export function buildInferencePrompt(script: InferenceScriptContent, data: string[]): string {
  const parts: string[] = []

  parts.push(`You are a data processor. Follow the instructions to analyze the provided data. Output valid JSON that the code can consume.

---
Instructions:
${script.infer || 'Process the data and return a JSON object.'}`)

  if (script.insight) {
    parts.push(`---
Example output:
${script.insight}`)
  }

  if (script.code) {
    parts.push(`---
Code that will consume your output:
${script.code}`)
  }

  if (data.length > 0) {
    const dataContent = data.length === 1
      ? data[0]
      : data.map((chunk, i) => `[Chunk ${i + 1}]\n${chunk}`).join('\n\n')
    parts.push(`---
Data to process:
<data>
${dataContent}
</data>`)
  }

  parts.push(`
Output only valid JSON. No explanation, no markdown fences, just the JSON object. Every number must be a JSON literal — never an expression like 2 * pi; write the computed decimal instead.`)

  return parts.join('\n\n')
}

// ─── Sanitizer ───────────────────────────────────────────────────────────────
// Conservative: only apply a fix when the original fails to parse AND the fixed
// version produces valid JSON.

export interface SanitizeResult {
  parsed: unknown | null
  json: string
  fixesApplied: string[]
}

/** Try to parse, return result or null */
function tryParse(json: string): unknown | null {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Sanitization strategies: [name, fix function] */
const strategies: Array<[string, (s: string) => string | null]> = [
  ['orphan quote', (s) => { const f = s.replace(/^[ \t]*"[ \t]*\r?\n/gm, ''); return f !== s ? f : null }],
  ['trailing }', (s) => s.endsWith('}}') ? s.slice(0, -1) : null],
  ['trailing ]', (s) => s.endsWith(']]') ? s.slice(0, -1) : null],
  ['trailing },', (s) => s.endsWith('},') ? s.slice(0, -1) : null],
  ['trailing ],', (s) => s.endsWith('],') ? s.slice(0, -1) : null],
  ['trailing commas', stripTrailingCommas],
  ['arithmetic constants', foldArithmeticConstants],
]

/** Apply fn to the segments of near-JSON text that lie OUTSIDE string literals. */
function mapOutsideStrings(text: string, fn: (seg: string) => string): string {
  let out = ''
  let segStart = 0
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') {
      if (inString) { out += text.slice(segStart, i + 1); segStart = i + 1 }
      else { out += fn(text.slice(segStart, i)) + '"'; segStart = i + 1 }
      inString = !inString
    }
  }
  out += inString ? text.slice(segStart) : fn(text.slice(segStart))
  return out
}

/** Strip trailing commas before a closing } or ] — anywhere in the document, not just at its end.
 *  GPT-5.6 emits JSON5-style trailing commas inside nested objects, so deeply structured insights
 *  (one comma per closing) fail far more often than flat ones. String contents are never touched:
 *  a quoted snippet ending ",\n}" stays verbatim. */
function stripTrailingCommas(s: string): string | null {
  const fixed = mapOutsideStrings(s, (seg) => seg.replace(/,(\s*[}\]])/g, '$1'))
  return fixed !== s ? fixed : null
}

/** Fold constant arithmetic in value position — "range": [0, 4 * pi] — into JSON number literals.
 *  Cheap models routinely emit these, and the free tier runs on cheap models, so absorbing the
 *  artifact is load-bearing. Conservative like every strategy: only wins if the result parses, and
 *  string contents are never touched (a "period of 2*pi radians" explanation stays verbatim). */
function foldArithmeticConstants(s: string): string | null {
  const folded = mapOutsideStrings(s, (seg) => seg
    // Standalone constants first ("1e3" has no word boundary before its e, so exponents survive).
    .replace(/\bpi\b/g, '3.141592653589793')
    .replace(/\be\b/g, '2.718281828459045')
    // Fold a run only if it actually computes: contains an operator between operands.
    .replace(/-?\d[\d.\s+\-*/()]*\d|\(-?\d[\d.\s+\-*/()]*\d\)/g, (run) => {
      if (!/[+\-*/]/.test(run.replace(/^-/, '')) || run.length > 64) return run
      if (!/^[\d\s.+\-*/()]+$/.test(run)) return run
      try {
        const v = Function(`"use strict"; return (${run})`)() as unknown
        return typeof v === 'number' && Number.isFinite(v) ? String(v) : run
      } catch { return run }
    }))
  return folded !== s ? folded : null
}

/** Find the end index of a balanced {...} or [...] starting at `start`.
 *  String-aware (so braces inside JSON string literals don't count).
 *  Returns -1 if unbalanced. */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]!
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (c === '"') { inString = !inString; continue }
    if (inString) continue
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Scan for top-level balanced JSON values and return the last one that parses.
 *  Handles the case where a strong model with no thinking budget emits visible
 *  self-correction in the text channel — e.g. draft → "wait, reconsider" →
 *  revised JSON. The final value is essentially always the intended answer. */
function findLastValidJson(text: string): { parsed: unknown; json: string } | null {
  let last: { parsed: unknown; json: string } | null = null
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '{' || c === '[') {
      const end = findBalancedEnd(text, i)
      if (end !== -1) {
        const candidate = text.slice(i, end + 1)
        const parsed = tryParse(candidate)
        if (parsed !== null) last = { parsed, json: candidate }
        i = end + 1
        continue
      }
    }
    i++
  }
  return last
}

/**
 * Attempt to parse JSON, applying conservative fixes for common LLM errors
 */
export function sanitizeJsonOutput(content: string): SanitizeResult {
  const fixesApplied: string[] = []
  let json = content.trim()

  // Strip markdown fences (common LLM behavior despite instructions)
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    fixesApplied.push('markdown fences')
  }

  // Try parsing as-is
  let parsed = tryParse(json)
  if (parsed !== null) {
    return { parsed, json, fixesApplied }
  }

  // Extract from embedded markdown fences (reasoning/preamble text before ```json block)
  const fenceMatch = json.match(/```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) {
    json = fenceMatch[1].trim()
    fixesApplied.push('preamble before fenced JSON')
    parsed = tryParse(json)
    if (parsed !== null) {
      return { parsed, json, fixesApplied }
    }
  }

  // Strip preamble text before bare JSON (find first { or [)
  if (!json.startsWith('{') && !json.startsWith('[')) {
    const objIdx = json.indexOf('{')
    const arrIdx = json.indexOf('[')
    const idx = objIdx >= 0 && arrIdx >= 0 ? Math.min(objIdx, arrIdx) :
                objIdx >= 0 ? objIdx : arrIdx
    if (idx > 0) {
      json = json.slice(idx)
      fixesApplied.push('preamble text')
      parsed = tryParse(json)
      if (parsed !== null) {
        return { parsed, json, fixesApplied }
      }
    }
  }

  // Try each sanitization strategy (operates on cleaned json from above)
  for (const [name, fix] of strategies) {
    const fixed = fix(json)
    if (fixed !== null) {
      const parsed = tryParse(fixed)
      if (parsed !== null) {
        return { parsed, json: fixed, fixesApplied: [...fixesApplied, name] }
      }
    }
  }

  // Final fallback: scan the original content for the last syntactically
  // complete JSON value. Catches the "model emitted draft + revision in text"
  // pattern that the linear strategies above can't handle.
  const found = findLastValidJson(content)
  if (found !== null) {
    return { ...found, fixesApplied: [...fixesApplied, 'extracted last JSON value'] }
  }

  return { parsed: null, json, fixesApplied }
}

// ─── Result encoding (#tb=1:<deflate+base64url>) ─────────────────────────────

/** The result of an inference run: the AI's insight plus the data it analyzed */
export interface InferenceResult {
  insight: unknown      // Parsed insight object
  insightJson: string   // Serialized insight (for display/saving)
  data: string[]        // Data chunks that were analyzed
}

const TB_PREFIX = 'tb='
const TB_VERSION = '1'
const MAX_ENCODED_LENGTH = 60000  // ~60KB; Firefox's ~64K URL limit is the cross-browser floor

interface EncodedPayload {
  i: unknown    // insight (parsed)
  d: string[]   // data chunks
}

/** Encode result to URL hash. Returns "#tb=1:..." or empty string if too large. */
export function encodeToHash(result: InferenceResult): string {
  try {
    const payload: EncodedPayload = { i: result.insight, d: result.data }
    const json = JSON.stringify(payload)
    const compressed = deflateSync(strToU8(json), { level: 9 })
    const base64 = base64UrlEncode(compressed)
    const encoded = `${TB_VERSION}:${base64}`

    if (encoded.length > MAX_ENCODED_LENGTH) return ''
    return '#' + TB_PREFIX + encoded
  } catch {
    return ''
  }
}

/** Decode result from URL hash. Returns null if no result or decode fails. */
export function decodeFromHash(hash: string): InferenceResult | null {
  try {
    const fragment = hash.startsWith('#') ? hash.slice(1) : hash
    if (!fragment.startsWith(TB_PREFIX)) return null

    const encoded = fragment.slice(TB_PREFIX.length)
    const colonIndex = encoded.indexOf(':')
    if (colonIndex === -1 || encoded.slice(0, colonIndex) !== TB_VERSION) return null

    const compressed = base64UrlDecode(encoded.slice(colonIndex + 1))
    const payload = JSON.parse(strFromU8(inflateSync(compressed))) as EncodedPayload

    if (!payload || typeof payload.i === 'undefined' || !Array.isArray(payload.d)) {
      return null
    }

    return {
      insight: payload.i,
      insightJson: JSON.stringify(payload.i, null, 2),
      data: payload.d
    }
  } catch {
    return null
  }
}

/** Check if hash contains a tb= fragment (for error detection) */
export function hashContainsTb(hash: string): boolean {
  return hash.includes('tb=')
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: a single String.fromCharCode(...bytes) spread overflows the arg limit near 64K bytes.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) base64 += '='
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
