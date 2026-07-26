/**
 * The source as the rules should see it: comments and template-literal bodies blanked to spaces,
 * everything else byte-identical — same length, same line breaks — so a match still reports the real
 * file's line and column.
 *
 * Ordinary quoted strings are deliberately LEFT ALONE: an import specifier lives in one, and blanking
 * those would blind every rule that exists.
 *
 * Why: the rules match text, so import-shaped text that isn't an import trips them. An inline Web
 * Worker's source in a template literal — the pattern a WebGL/WASM bulb needs — fires `URL_IMPORT`,
 * and that bulb can then never pass `typebulb check`. This is also the direction the resolver already
 * takes: its authoritative extraction is `es-module-lexer` (`packageService.extractImports`), which
 * has never seen those regions as imports, so blanking converges lint with it rather than drifting.
 *
 * A scanner, not a parser. Regex literals are recognized only in expression position (after `(`,
 * `,`, `=` and kin) — which covers where bulb code actually puts them (`split(/…/)`, `= /…/`) —
 * because an unrecognized regex is the one gap that can fail toward *less* text being linted: a
 * backtick inside one opens a phantom template that blanks real code up to the next backtick,
 * suppressing findings. A regex outside those positions (after `return`, say) keeps that hazard;
 * the other gap — a `}` inside a string inside `${…}` closing the interpolation early — fails the
 * safe way, more text linted, a surviving false positive.
 */

/** Characters after which a `/` can only start a regex, never division (division needs a left
 *  operand, which would end in an identifier/literal instead). Empty means start of source. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '{'])

export function codeView(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }

  let i = 0
  let prev = ''   // last significant code char — comments are transparent (`= /* c */ /x/` is a regex)
  while (i < source.length) {
    const c = source[i]
    const d = source[i + 1]

    if (c === '/' && d === '/') {
      let j = i
      while (j < source.length && source[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && d === '*') {
      let j = i + 2
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++
      blank(i, Math.min(j + 2, source.length))
      i = j + 2
    } else if (c === '/' && REGEX_PRECEDERS.has(prev)) {
      // A regex literal — skipped like a string, because its body can hide any delimiter: left as
      // code, split(/`/) would open a phantom template blanking everything to the next backtick.
      let j = i + 1
      let inClass = false   // an unescaped `/` inside `[…]` does not close a regex
      while (j < source.length && source[j] !== '\n') {
        const r = source[j]
        if (r === '\\') j++
        else if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        j++
      }
      i = j + 1
      prev = '/'
    } else if (c === '"' || c === "'") {
      // Skipped over, not blanked — this is where a real specifier lives.
      let j = i + 1
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') j++
        j++
      }
      i = j + 1
      prev = c
    } else if (c === '`') {
      const end = templateEnd(source, i)
      blank(i, end)
      i = end
      prev = '`'
    } else {
      if (!/\s/.test(c)) prev = c
      i++
    }
  }

  return out.join('')
}

/** Index just past the backtick closing the template literal that opens at `start`, stepping over
 *  `${…}` interpolations (and templates nested inside them). */
function templateEnd(source: string, start: number): number {
  let i = start + 1
  let depth = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') {
      if (depth === 0) return i + 1
      i = templateEnd(source, i)   // a template inside an interpolation
      continue
    }
    if (c === '$' && source[i + 1] === '{') { depth++; i += 2; continue }
    if (c === '}' && depth > 0) { depth--; i++; continue }
    i++
  }
  return source.length
}
