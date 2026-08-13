import MarkdownIt from 'markdown-it'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { renderMermaidSVG } from 'beautiful-mermaid'
import hljs from 'highlight.js/lib/core'
import hljsTypescript from 'highlight.js/lib/languages/typescript'
import hljsXml from 'highlight.js/lib/languages/xml'
import hljsCss from 'highlight.js/lib/languages/css'
import hljsJson from 'highlight.js/lib/languages/json'
import hljsMarkdown from 'highlight.js/lib/languages/markdown'
import hljsPlaintext from 'highlight.js/lib/languages/plaintext'
import hljsPython from 'highlight.js/lib/languages/python'
import hljsBash from 'highlight.js/lib/languages/bash'
import hljsYaml from 'highlight.js/lib/languages/yaml'
import { tryParseBulb, findUnfencedBulbs } from '../../../src/render.js'
import type { Msg } from './types.js'

// `html: true` lets the agent's natural semantic HTML through the parser — today only <details>/<summary>
// (collapsible answers, spoilers, folded logs). It is safe only because BOTH raw-HTML render rules
// (html_block/html_inline, below) funnel through filterSafeHtml: the effective surface is exactly
// SAFE_HTML_TAGS, and every other tag stays escaped just as html:false rendered it. mdPlain keeps
// html:false — the code view must show a bulb's literal markup, never let it render.
const md = new MarkdownIt({ html: true, linkify: true, breaks: true })

// Syntax highlighting for the code view and the diff doc: a custom hljs core build registering only
// the grammars a bulb uses plus the diff view's common file types — keeps the dep to ~tens of KB vs
// hljs's full ~1MB bundle. esbuild bundles these into the mirror's client.js (no import map, no
// proxy — the mirror is CLI code, not a bulb). No hljs theme stylesheet either — token
// colors come from our own CSS vars (.bulb-code/.diff-doc-body .hljs-*) so they follow the host
// light/dark theme instead of baking a palette.
hljs.registerLanguage('typescript', hljsTypescript)
hljs.registerLanguage('xml', hljsXml)
hljs.registerLanguage('css', hljsCss)
hljs.registerLanguage('json', hljsJson)
hljs.registerLanguage('markdown', hljsMarkdown)
hljs.registerLanguage('plaintext', hljsPlaintext)
hljs.registerLanguage('python', hljsPython)
hljs.registerLanguage('bash', hljsBash)
hljs.registerLanguage('yaml', hljsYaml)

// Fence tag OR file extension → registered grammar (the diff doc keys by extension; fences by tag —
// the vocabularies coincide). js/jsx fold into typescript (the superset grammar reads plain JS fine),
// html/svg into xml. Anything unknown or absent falls back to escaped plaintext (always registered,
// so never throws).
const HLJS_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', typescript: 'typescript',
  js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript',
  html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', json: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python', python: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  text: 'plaintext', txt: 'plaintext', plaintext: 'plaintext',
}
function highlightCode(code: string, lang: string): string {
  const name = HLJS_LANG[(lang || '').toLowerCase()] ?? 'plaintext'
  return `<pre class="hljs"><code>${hljs.highlight(code, { language: name }).value}</code></pre>`
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Whole-text highlight split back into per-line HTML — for surfaces that render line-by-line (the
// diff doc): highlighting must run over the FULL text so multi-line constructs (block comments,
// template literals) lex correctly, but each line ships as its own element, so any spans still open
// at a newline are closed there and re-opened on the next line (hljs emits only <span>/</span>, and
// escapes text, so every literal `<` in its output is a tag). Guarantees one entry per input line —
// on any surprise (grammar throw, line-count drift) it falls back to escaped plain text.
export function highlightToLines(code: string, tag: string): string[] {
  const src = code.split('\n')
  try {
    const name = HLJS_LANG[(tag || '').toLowerCase()] ?? 'plaintext'
    const html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value
    const lines: string[] = []
    const stack: string[] = []
    let cur = ''
    for (let i = 0; i < html.length; i++) {
      const ch = html[i]
      if (ch === '<') {
        const end = html.indexOf('>', i)
        const t = html.slice(i, end + 1)
        if (t[1] === '/') stack.pop(); else stack.push(t)
        cur += t
        i = end
      } else if (ch === '\n') {
        lines.push(cur + '</span>'.repeat(stack.length))
        cur = stack.join('')
      } else cur += ch
    }
    lines.push(cur + '</span>'.repeat(stack.length))
    if (lines.length === src.length) return lines
  } catch {}
  return src.map(escapeHtml)
}

// Plain markdown for the code view: renders a bulb's .bulb.md source (file labels +
// fenced code) with NONE of md's custom fence rules — crucially not the ````bulb````
// rule, which would mount a live sub-bulb inside a *code* view (bulb-in-bulb is real).
// Defaults plus the hljs highlight hook above.
export const mdPlain = new MarkdownIt({ html: false, linkify: false, breaks: false, highlight: highlightCode })

// markdown-it v14's rule/token types come from @types/markdown-it. Derive the render-rule and
// inline-state types from the live `md` instance rather than a deep subpath import, so they track
// whatever the resolver binds. The render rules below are typed by assignment context (no per-param
// annotations); only the standalone mathRule needs its state param named.
type MdRenderRule = NonNullable<(typeof md.renderer.rules)[string]>
type MdInlineState = Parameters<Parameters<typeof md.inline.ruler.before>[2]>[0]
type MdBlockState = Parameters<Parameters<typeof md.block.ruler.before>[2]>[0]

// Links open in a new tab: the bulb is a dashboard, in-place nav would lose
// scroll / session. rel=noopener is standard tab-napping hygiene. Shared by both
// parsers — user turns carry linkified URLs and @mention links too.
function applyLinkTargetRule(m: MarkdownIt) {
  const dflt: MdRenderRule = m.renderer.rules.link_open
    ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
  m.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
    return dflt(tokens, idx, opts, env, self)
  }
}
applyLinkTargetRule(md)

// A markdown table chops onto its own row like an svg/bulb embed, and can spread to the lane when it
// overflows the column (see fitTableEmbeds). A table isn't a fence, so it can't ride the fence rule —
// instead wrap it at the `table_open`/`table_close` boundary in the same `<div class="embed">` the
// fence rule stamps on svg/bulb, so it inherits the stripe-chop for free. Assistant-only by
// construction: user turns render through mdUser, which doesn't parse tables at all.
const defaultTableOpen: MdRenderRule = md.renderer.rules.table_open
  ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
md.renderer.rules.table_open = (tokens, idx, opts, env, self) => {
  const open = defaultTableOpen(tokens, idx, opts, env, self)
  // The inner `.table-scroll` carries the horizontal scroll, not the `.embed` wrapper: a scrollbar sits
  // at its container's bottom edge, so scrolling the wrapper drops the bar below the opaque chop padding,
  // flush against the next line (the bug). Nested inside, the bar rides above that padding, which then
  // separates it from the following prose — while the table itself stays at max-content width so it still
  // overflows and earns the bar (a plain block scroller would instead wrap the cells to fit, no bar).
  return `<div class="embed table-embed"><div class="table-scroll">${open}`
}
const defaultTableClose: MdRenderRule = md.renderer.rules.table_close
  ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
md.renderer.rules.table_close = (tokens, idx, opts, env, self) => {
  return `${defaultTableClose(tokens, idx, opts, env, self)}</div></div>`
}

// Safe semantic HTML the agent emits naturally, rendered rather than escaped. This is the *no-chop*
// counterpart to the svg/mermaid/table embeds: those carve their own opaque band out of the turn (the
// `.embed` stripe-chop); these flow inline with the prose, like a list or blockquote — the right register
// for a disclosure. Deliberately a tiny allowlist of inert, attribute-light tags — <details>/<summary>
// today; <kbd>/<mark>/<sub>/<sup>/<abbr> are natural future members, each a one-line addition to these
// two constants (and an optional `.md` CSS rule). Everything outside it — other tags, every attribute bar
// the inert per-tag set below, comments — is escaped to literal text, exactly as html:false did, so
// turning the parser on widens what renders by precisely this set and nothing more.
const SAFE_HTML_TAGS = new Set(['details', 'summary'])
// Per-tag attribute allowlist: inert structural/presentational attributes only, never a handler, style,
// or url-bearing one. `open` lets <details open> render expanded. A tag absent here keeps zero attributes.
const SAFE_HTML_ATTRS: Record<string, Set<string>> = { details: new Set(['open']) }

const SAFE_HTML_TAG = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const SAFE_HTML_ATTR = /([a-zA-Z][\w-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g

// Escape a text slice like md.utils.escapeHtml, but spare the `&` of an already-valid HTML entity
// (&lt; &#34; &#x2d; …). Those are inert — they decode to one literal character in a text context, never
// markup — so re-escaping their `&` to &amp; would leak the raw "&lt;" to the reader (the bug). Every
// bare `&`, and every <, >, ", is still escaped, so no tag can form.
const ENTITY_AMP = /&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g
const escapeTextKeepEntities = (s: string): string =>
  s.replace(ENTITY_AMP, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Walk a raw-HTML fragment tag by tag — no DOM, no tag-balancing. A <details>…</details> spans several
// markdown tokens (opener, the inner markdown, closer), so a balancing sanitizer like DOMPurify would
// auto-close the opener mid-fragment and strand the content; we filter each tag in isolation and leave
// nesting to the browser. Allowlisted tags pass with only their allowlisted attributes (emitted bare —
// the whitelist is boolean-only, so no attribute value is ever echoed back); every other tag, all other
// attributes, and all text are escaped (text via escapeTextKeepEntities, so an author's &lt; survives as
// the literal "<" rather than double-escaping to a raw &lt;). Safe by construction: the only tags emitted are the inert
// set above stripped to inert attributes, so there is no script/url/handler surface left to scrub.
function filterSafeHtml(fragment: string): string {
  let out = '', last = 0
  for (const m of fragment.matchAll(SAFE_HTML_TAG)) {
    const at = m.index ?? 0
    out += escapeTextKeepEntities(fragment.slice(last, at))
    last = at + m[0].length
    const tag = m[1].toLowerCase()
    if (!SAFE_HTML_TAGS.has(tag)) { out += md.utils.escapeHtml(m[0]); continue }
    if (m[0][1] === '/') { out += `</${tag}>`; continue }
    const allow = SAFE_HTML_ATTRS[tag]
    let attrs = ''
    if (allow) for (const a of m[2].matchAll(SAFE_HTML_ATTR)) {
      const name = a[1].toLowerCase()
      if (allow.has(name)) attrs += ` ${name}`
    }
    out += `<${tag}${attrs}>`
  }
  return out + escapeTextKeepEntities(fragment.slice(last))
}

// Both raw-HTML render rules funnel here, so html:true never widens the surface past SAFE_HTML_TAGS.
// Assistant-only by construction: mdUser keeps html:false, so a user prompt's raw HTML renders as its
// literal source without ever reaching this rule. KaTeX, svg and mermaid never reach here either (each
// owns its own token), so there is no whole-output sanitize to entangle.
const renderRawHtml: MdRenderRule = (tokens, idx) => filterSafeHtml(tokens[idx].content)
md.renderer.rules.html_block = renderRawHtml
md.renderer.rules.html_inline = renderRawHtml

// Math is a markdown-it inline rule registered BEFORE `escape` — it must claim
// the raw TeX before markdown-it strips the \( \) \[ \] backslashes or mangles
// `\\` / `_` / `*` inside the formula. Code/fenced spans are already tokenized, so
// math inside them is skipped for free. A standalone `$$…$$` display block needs a
// block-level companion too (mathBlockRule below) — the inline rule alone runs too
// late to stop the block parser from mis-reading the formula's own lines.
const MATH_DELIMS = [
  { open: '$$', close: '$$', display: true },
  { open: '$', close: '$', display: false },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
]

function mathRule(state: MdInlineState, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  for (const d of MATH_DELIMS) {
    if (!src.startsWith(d.open, start)) continue
    const from = start + d.open.length
    const to = src.indexOf(d.close, from)
    if (to < 0) continue
    const content = src.slice(from, to)
    if (!content.trim()) continue
    // Bare-`$` currency guard: skip "$5 and $6" — opener not followed by space,
    // closer not preceded by space, and no digit immediately after the close.
    if (d.open === '$' &&
        (/\s/.test(src[from] ?? '') || /\s/.test(src[to - 1] ?? '') || /\d/.test(src[to + 1] ?? ''))) continue
    if (!silent) {
      const token = state.push('math', 'span', 0)
      token.content = content
      token.markup = d.open
      token.meta = { display: d.display }
    }
    state.pos = to + d.close.length
    return true
  }
  return false
}
const renderMath: MdRenderRule = (tokens, idx) => {
  const t = tokens[idx]
  try { return katex.renderToString(t.content, { displayMode: !!t.meta?.display, throwOnError: false }) }
  catch { return md.utils.escapeHtml(t.markup + t.content + t.markup) }
}

// Display math `$$…$$` as a BLOCK rule, registered before `lheading` (markdown-it's
// setext-heading rule). Without it, a display block whose own lines include a bare `=`
// (or `-`) line is read as a setext underline: the block parser promotes the opening
// `$$` into an <h1> and strands the closing `$$` in the next paragraph, so the inline
// rule above never sees a matched pair and the TeX renders literally. `lheading` runs
// ahead of `paragraph`, so the rule must precede `lheading` specifically. Claiming the
// whole `$$…$$` region at the block level makes display math immune to every block rule
// (setext, lists, blockquotes), not just `=`. Emits the same `math` token the inline
// rule does (meta.display) so one renderer covers both. A `$$` mid-paragraph (line
// doesn't start with it) still falls through to the inline rule.
function mathBlockRule(state: MdBlockState, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false   // indented code, not math
  const open = state.bMarks[startLine] + state.tShift[startLine]
  if (!state.src.startsWith('$$', open)) return false

  // Locate the closing `$$` — on the opening line itself or a later one. A display block is
  // contiguous, so a blank line before the close means it's unterminated: bail rather than scan
  // on and swallow a later `$$` block. `state.src` is the whole document, so the content is then
  // one slice across the matched lines — no per-line accumulation.
  let closeLine = -1
  let closeAt = -1
  for (let line = startLine; line < endLine; line++) {
    if (line > startLine && state.isEmpty(line)) break
    const from = line === startLine ? open + 2 : state.bMarks[line]
    const at = state.src.indexOf('$$', from)
    if (at >= 0 && at < state.eMarks[line]) { closeLine = line; closeAt = at; break }
  }
  if (closeLine < 0) return false   // unterminated — leave it for the paragraph/inline rules
  if (silent) return true

  state.line = closeLine + 1
  const token = state.push('math', 'div', 0)
  token.block = true
  token.markup = '$$'
  token.content = state.src.slice(open + 2, closeAt).trim()
  token.meta = { display: true }
  token.map = [startLine, state.line]
  return true
}
// Both parsers carry the math rules — TeX delimiters are deliberate in a user prompt too. The
// insertion anchors ('escape', 'lheading') exist in mdUser's rulers even though its zero preset
// disables them, and a rule added afterwards is enabled regardless of the preset.
function applyMathRules(m: MarkdownIt) {
  m.inline.ruler.before('escape', 'math', mathRule)
  m.block.ruler.before('lheading', 'math_block', mathBlockRule)
  m.renderer.rules.math = renderMath
}
applyMathRules(md)

// beautiful-mermaid decodes only XML + numeric entities (decodeXML), so named HTML
// entities — &nbsp;, &mdash;, … — survive undecoded and then render as literal
// text. Decode the full named set first; the library's pass is then a no-op.
function decodeHtmlEntities(s: string): string {
  const ta = document.createElement('textarea')
  ta.innerHTML = s
  return ta.value
}

// ```mermaid``` fences render to inline SVG. A parse error falls through to the
// default code-block rendering, so an unsupported diagram degrades to readable
// source rather than a broken message.
// A hover-revealed copy pill for a rendered fence. Every fenced block — code, svg, mermaid, an
// unrecognised language — flows through the fence rule below, and the thing worth copying is always
// its raw body, so one primitive covers them all. The source rides the button's own data-src
// (escaped going in; getAttribute auto-unescapes coming out, so multi-line bodies round-trip), which
// decouples the delegated handler from each block's container structure. `.copyable` is the shared
// marker the rule stamps on every block so one CSS rule can reveal the pill on hover.
function copyButton(src: string): string {
  return `<button class="overlay-pill copy-src" type="button" title="Copy source" data-src="${md.utils.escapeHtml(src)}">copy</button>`
}

// A fence rendered as source: the default <pre><code> wrapped so it gets the same hover copy pill.
// The wrapper — not the <pre> — is the `.md` flow child; see `.code-block` CSS for the rhythm.
const wrapCodeBlock = (inner: string, src: string) =>
  `<div class="code-block copyable">${inner}${copyButton(src)}</div>`

const defaultFence: MdRenderRule = md.renderer.rules.fence
  ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx]
  const lang = (t.info ?? '').trim().toLowerCase()
  // Note: no `bulb` case here. Live inline bulbs are split out of the text before markdown runs
  // (splitBulbSegments → InlineBulb), so a ````bulb```` fence reaching markdown is illustrative
  // source — it falls through to defaultFence like any other unrecognised fence.
  // ```svg``` fences embed raw SVG. Same trust level as the rest of the assistant
  // markdown we render, but raw SVG can carry <script>/onload/<foreignObject>, so
  // it goes through DOMPurify's svg profile first — geometry survives, the script
  // surface is stripped. Lets the agent draw anything (smiley, plot from an
  // equation) without an iframe, since it's static markup, not executed code.
  // Live inline bulbs are assistant-only by construction: a user turn renders through mdUser, whose
  // fence rule always emits a plain source block, so no gate is needed here.
  if (lang === 'svg') {
    const safe = DOMPurify.sanitize(t.content, { USE_PROFILES: { svg: true, svgFilters: true } })
    return `<div class="embed svg-embed copyable">${safe}${copyButton(t.content)}</div>`
  }
  if (lang === 'mermaid') {
    try {
      // The library's internal theme vars share names with the bulb's (--fg/--bg/
      // --muted/--border/--accent), so passing var(--fg) here would emit a
      // self-referential `--fg: var(--fg)` on the SVG — a CSS cycle that resolves
      // to invalid. The --mm-* aliases (styles.css) break the cycle, still themed.
      const svg = renderMermaidSVG(decodeHtmlEntities(t.content), {
        // bg backs the label mask-rects (edge/loop labels); without it they default
        // to white and wash out in dark mode. transparent keeps the canvas clear.
        bg: 'var(--mm-bg)',
        fg: 'var(--mm-fg)',
        line: 'var(--mm-line)',
        accent: 'var(--mm-accent)',
        muted: 'var(--mm-muted)',
        surface: 'var(--mm-surface)',
        border: 'var(--mm-border)',
        font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        transparent: true,
      })
      return `<div class="mermaid copyable">${svg}${copyButton(t.content)}</div>`
    } catch { /* fall through to a plain code block */ }
  }
  // Every other fence (code, or an unrecognised language) is a copyable source block.
  return wrapCodeBlock(defaultFence(tokens, idx, opts, env, self), t.content)
}

// Author classDef/style colors render as literal fill/stroke/color that override
// the theme, freezing a light-mode palette into dark mode. The library has no flag
// to suppress this, and its prop parser splits on every comma, so a color-mix() fed
// through the source is shredded — we have to blend post-render instead. The
// library's own colors are var(--_…), which the literal-color test skips.
const isLiteralColor = (v: string | null): v is string =>
  !!v && !v.startsWith('var(') && !v.startsWith('url(') && v !== 'none' && v !== 'transparent'

function themeMermaidNodes(root: Element) {
  for (const el of root.querySelectorAll<SVGElement>('.mermaid g.node [fill], .mermaid g.node [stroke]')) {
    const fill = el.getAttribute('fill')
    if (isLiteralColor(fill)) {
      // Text → themed fg for legibility; shape → keep the hue, mixed mostly into bg.
      el.setAttribute('fill', el.tagName.toLowerCase() === 'text'
        ? 'var(--mm-fg)'
        : `color-mix(in srgb, ${fill} 25%, var(--mm-bg))`)
    }
    const stroke = el.getAttribute('stroke')
    if (isLiteralColor(stroke)) {
      el.setAttribute('stroke', `color-mix(in srgb, ${stroke} 55%, var(--mm-fg))`)
    }
  }
}

// Fit each raw ```svg``` embed to its content. A raw <svg> with only a viewBox has NO intrinsic size,
// so it defaults to width:100% and stretches to fill the column — which both makes the container's
// justify-content:center moot (where the art sits *inside* the viewBox is all that positions it, so a
// drawing parked off-centre in an oversized box reads as left/right-aligned) and blows a small drawing
// up to a column-wide wall. Two coupled steps fix both: (1) tighten the viewBox to the content's bbox,
// then (2) set the display width to that bbox's user-unit extent as px (1 unit ≈ 1px), capped by the
// CSS max-width:100%. Now it renders small when small (and the now-narrower svg actually centres), and
// a genuinely large drawing still caps at the column. getBBox is geometry-only — it ignores stroke,
// which paints up to half its width *outside* the geometry — so the viewBox is padded by the largest
// painted half-stroke (clipping depends on stroke width, not drawing size; a fixed % loses to a thick
// stroke on a small drawing). The +1 is a hairline guard for anti-aliasing / curve overshoot; pad is 0
// when nothing strokes (fills never overflow). Skips a node that isn't measurable (zero-area, or laid
// out inside a collapsed turn → getBBox throws / returns 0), leaving it as authored.
function fitSvgEmbeds(root: Element) {
  for (const svg of root.querySelectorAll<SVGSVGElement>('.svg-embed svg')) {
    try {
      const b = svg.getBBox()
      if (!b.width || !b.height) continue
      let half = 0
      for (const el of svg.querySelectorAll<SVGElement>('*')) {
        const cs = getComputedStyle(el)                      // computed, so it catches attribute, CSS, and inherited widths
        if (cs.stroke && cs.stroke !== 'none') half = Math.max(half, parseFloat(cs.strokeWidth) / 2)
      }
      const pad = half ? half + 1 : 0
      svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`)
      svg.style.width = `${b.width + pad * 2}px`              // natural size (units≈px); max-width:100% caps it, height:auto keeps ratio
    } catch { /* not laid out / unmeasurable — leave the authored viewBox */ }
  }
}

// Spread a table to the lane only when its natural width overflows the prose column — the one artifact
// where measuring is unambiguous (a table is exactly as wide as its content, no narrow-by-design case).
// The wrapper already chops in-column via `.embed`; here we compare the table's natural width (its
// scrollWidth as a non-shrinking flex child) to the column (the wrapper's content box) and add `spread`
// to break out, reusing the mermaid lane geometry. Re-measured fresh on each mount, so a table inside a
// turn collapsed at first render gets measured when the turn expands and its bubble mounts. The class is
// cleared first so a re-render re-decides rather than latching a stale spread.
function fitTableEmbeds(root: Element) {
  for (const wrap of root.querySelectorAll<HTMLElement>('.table-embed')) {
    const table = wrap.querySelector('table')
    if (!table) continue
    wrap.classList.remove('spread')
    // +1 tolerance for sub-pixel rounding; clientWidth is the column (content box), scrollWidth the
    // table's natural extent even while clipped. Unlaid-out (collapsed) tables read 0 and stay in-column.
    if (table.scrollWidth > wrap.clientWidth + 1) wrap.classList.add('spread')
  }
}

// A relative-path link in assistant markdown is a local file citation (optionally
// with a #Lnnn line anchor): open it in the editor, not the browser — the bulb is
// served from the project root, so the browser would GET the path and 404. Links
// with a scheme (http, mailto, …) fall through to the default new-tab behavior.
function onMarkdownClick(e: Event) {
  // Per-fence copy: the source is on the button's own data-src (see copyButton), so no container walk.
  const copyBtn = (e.target as Element | null)?.closest<HTMLButtonElement>('.copy-src')
  if (copyBtn) {
    e.preventDefault()
    navigator.clipboard?.writeText(copyBtn.dataset.src ?? '')
    copyBtn.classList.add('done')
    copyBtn.textContent = 'copied'
    setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.textContent = 'copy' }, 1200)
    return
  }
  const anchor = (e.target as Element | null)?.closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href') ?? ''
  if (!href || href.includes('://') || href.startsWith('//') || href.startsWith('#') || /^(mailto|tel):/i.test(href)) return
  e.preventDefault()
  const hashAt = href.indexOf('#')
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href
  const lineMatch = hashAt >= 0 ? /^L(\d+)/.exec(href.slice(hashAt + 1)) : null
  tb.server.openFile(decodeURIComponent(path), lineMatch ? parseInt(lineMatch[1], 10) : undefined)
}

// The bare markdown→HTML passes, before the DOM post-passes in mountMarkdown. Exposed for unit tests
// (no DOM needed, so they run under vitest's node env) — assert the rendered HTML of a snippet.
export const mdRenderToHtml = (text: string) => md.render(text)
export const mdUserRenderToHtml = (text: string) => mdUser.render(text)

// Mount rendered markdown into the element via innerHTML. The render thunk runs inside the try, so a
// parser throw degrades to the raw text. The click handler is bound natively here, not via
// domeleon's `onClick`: the anchors are raw innerHTML the vdom never sees, so a delegated handler
// wouldn't fire. onMarkdownClick is a stable ref, so re-mounts don't stack duplicate listeners.
const mountMarkdown = (render: () => string, fallback: string) => (el: Element) => {
  try {
    el.innerHTML = render()
    themeMermaidNodes(el)
    fitSvgEmbeds(el)
    fitTableEmbeds(el)
  } catch {
    ;(el as HTMLElement).textContent = fallback
  }
  el.addEventListener('click', onMarkdownClick)
}

export const renderMarkdown = (text: string) => mountMarkdown(() => md.render(text), text)

// A user prompt's @mentions become clickable links. The lookbehind requires a word
// boundary before the @ so an email's @ (foo@bar.com) isn't mistaken for a mention.
// `:` is in the class so Windows drive paths (@C:\dir\file) match instead of stopping
// at the colon. atMentionLink then routes each match.
const AT_MENTION = /(?<=^|\s)@[\w./\\:-]+/g

// A path separator or dot means file citation (relative-path link → editor, via
// onMarkdownClick). A bare word matching X's handle grammar ([A-Za-z0-9_], ≤15) goes
// to x.com — for this tool's users a plain @name is far more often a handle than an
// extensionless filename. The ://-bearing x.com link falls through to the new-tab rule.
const atMentionLink = (m: string): string => {
  const body = m.slice(1)
  if (/^[A-Za-z0-9_]{1,15}$/.test(body)) return `[${m}](https://x.com/${body})`
  // A Windows path's `\` mangles in a markdown link destination — markdown-it percent-encodes each one
  // to %5C and treats `\.`/`\(` as escapes that drop the separator, yielding a broken file:/// URL
  // (file:///C:/%5C…, ERR_FAILED). Forward slashes carry the same path unambiguously and Windows opens
  // them fine; the visible link text (`${m}`) keeps the original backslashes.
  return `[${m}](${body.replace(/\\/g, '/')})`
}

// The user-turn parser. Assistant turns are authored markup; user turns are verbatim keystrokes — so
// this instance starts from markdown-it's zero preset and enables ONLY constructs whose delimiters
// are never typed by accident: fenced code, inline backticks, hard newlines, inline links (what
// @mentions rewrite to), linkified URLs — plus the math rules ($…$ is deliberate too). Everything
// markdown merely *infers* from ambient characters stays literal text: headings (ATX and setext — a
// pasted lone `=` line used to promote the line above it to an <h1>), lists, blockquotes, emphasis,
// tables, escapes (Windows paths keep their backslashes), raw HTML (html stays off). The enable-list
// IS the principle — extend it only for a construct a user deliberately types, never to "improve"
// how pasted markdown looks.
const mdUser = new MarkdownIt('zero', { linkify: true, breaks: true })
mdUser.enable(['fence', 'backticks', 'newline', 'link', 'linkify'])
applyMathRules(mdUser)
applyLinkTargetRule(mdUser)
// Every user-turn fence renders as a plain copyable source block, never a live bulb — svg/mermaid/
// bulb are assistant media, and a pasted snippet should read literally.
const defaultUserFence: MdRenderRule = mdUser.renderer.rules.fence
  ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))
mdUser.renderer.rules.fence = (tokens, idx, opts, env, self) =>
  wrapCodeBlock(defaultUserFence(tokens, idx, opts, env, self), tokens[idx].content)

// User prompts render through mdUser. Two pre-passes first: @mentions are rewritten to links (see
// atMentionLink), and merged consecutive sends (see applyUser) render as separate segments joined by
// an injected <hr> — injected as HTML, not a `---` line, because mdUser deliberately doesn't parse hr.
export const userMarkdown = (msg: Msg) => {
  const segs = msg.segments ?? [msg.text]
  return mountMarkdown(
    () => segs.map(s => mdUser.render(s.replace(AT_MENTION, atMentionLink))).join('<hr>'),
    msg.text)
}

// Split an assistant message into ordered markdown chunks and live bulb sources. Bulbs reach us two ways,
// both keyed off the near-zero-false-positive frontmatter gate in parseBulb (`---\nformat: typebulb…`):
//
// (a) Fenced — the normal route. We walk markdown-it's own parser (md.parse) rather than a hand-rolled
//     fence regex — the same tokenizer that renders the prose, so nested ``` fences and fence-length rules
//     are handled for free. A `fence` token carries its body in `token.content`, `token.map` its line span.
//     The info string is *not* the authoritative test — the structural parse is. Some models (GLM,
//     consistently) tag the fence ````markdown instead of ````bulb, or double the opener as
//     ````markdown\n````bulb with a single closer (so markdown-it sees one `markdown` fence whose body
//     begins with a stray ````bulb opener line). So we promote any fence whose body parses as a real bulb,
//     after stripping a stray leading bulb-opener. Don't revert this to an info-string-only check.
//
// (b) Naked — no enclosing fence at all (findUnfencedBulbs). Kimi notably skips the fence and dumps the
//     raw frontmatter + blocks into the message, using `---` thematic breaks as delimiters, so md.parse
//     only ever sees the bulb's *inner* ```tsx/```css fences — none of which parses as a whole bulb — and
//     path (a) finds nothing. We scan the raw lines for the frontmatter signature instead.
//
// The two are merged by line span: a naked hit whose start falls inside a fenced span is the same bulb
// seen twice (the frontmatter sits inside the fence) and is dropped, so a normal fenced bulb is unaffected.
// A genuinely-mislabeled or unfenced bulb renders; a real markdown snippet (no bulb frontmatter) stays prose.
export type BulbSegment = { kind: 'md'; text: string } | { kind: 'bulb'; source: string }
const STRAY_BULB_OPENER = /^`{3,}\s*bulb\s*\n/
export function splitBulbSegments(text: string): BulbSegment[] {
  const lines = text.split('\n')
  type Span = { start: number; end: number; source: string }
  const spans: Span[] = []
  // (a) Fenced bulbs, incl. GLM-style mislabels.
  for (const t of md.parse(text, {})) {
    if (t.type !== 'fence' || !t.map) continue
    const source = t.content.replace(STRAY_BULB_OPENER, '')
    const isBulb = (t.info ?? '').trim().toLowerCase() === 'bulb' || tryParseBulb(source) !== undefined
    if (isBulb) spans.push({ start: t.map[0], end: t.map[1], source })
  }
  // (b) Naked bulbs, skipping any that sit inside a fenced span we already have.
  for (const b of findUnfencedBulbs(text)) {
    if (spans.some(s => b.start >= s.start && b.start < s.end)) continue
    spans.push({ start: b.start, end: b.end, source: b.source })
  }
  spans.sort((a, b) => a.start - b.start)

  const segs: BulbSegment[] = []
  let cursor = 0
  for (const s of spans) {
    if (s.start < cursor) continue // overlaps a bulb already emitted — keep the first
    if (s.start > cursor) segs.push({ kind: 'md', text: lines.slice(cursor, s.start).join('\n') })
    segs.push({ kind: 'bulb', source: s.source })
    cursor = s.end
  }
  if (cursor < lines.length) segs.push({ kind: 'md', text: lines.slice(cursor).join('\n') })
  return segs
}
