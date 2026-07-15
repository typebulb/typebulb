import { span } from 'domeleon'
import { iconSvgs } from './iconSvgs.js'

// The mirror's icon system — the typebulb.com client's setup, adapted for esbuild (no vite glob
// loader, so the downloaded svgs live in the generated sibling `iconSvgs.ts`, not loose files).
// KEYS are the mirror's names, VALUES the Material Symbols names the downloader fetches:
//   node tools/download-icons.ts runtime/cli/agents/core/client/icons.ts
// Every icon renders through icon() below — one shell, CSS-owned sizing, currentColor — so the
// look is identical across platforms (font glyphs centre unpredictably; svgs don't).
export const icons = {
  play: 'play_arrow.fill',        // bare triangle — for a button that draws its own circle (.bulb-launch)
  stop: 'stop.fill',
  playCircle: 'play_circle',      // the circle IS the button (composer send — typebulb.com's play look)
  stopCircle: 'stop_circle',
  addCircle: 'add_circle',
  attach: 'attach_file',
} as const

// Custom glyphs with no Material equivalent — allowed, deliberately (an icon earns a custom svg
// when Material has nothing right; same contract as a downloaded one: a single <svg>, currentColor,
// full-bleed 16-viewBox). caret: the disclosure triangle every collapsible rotates via CSS.
// fork: the abandoned-branch ⑂ (U+2442 renders tiny from fallback fonts; Material has no git-fork).
// diff: the git-diff pill's ± — two-color by design (plus in --diff-add, minus in --err, the same
// vars as the diff bands it opens; injected svg resolves CSS vars), which no single-color Material
// glyph can be. The currentColor exemption: its own stroke colors ARE the point.
const custom = {
  caret: '<svg viewBox="0 0 16 16"><path d="M4 1.5 L13 8 L4 14.5 Z" fill="currentColor"/></svg>',
  // push/pull (TB-Push-Pull.md, Mirror surface): arrow out of / into a tray — the upload/download
  // pair, sharing one baseline tray so the two read as siblings at 14px.
  push: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 11 V3 M4.75 6.25 L8 3 L11.25 6.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14 H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pull: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3 V11 M4.75 7.75 L8 11 L11.25 7.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14 H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  // the sync verbs' transient success tick (bulbsPill syncCell) — same stroke register as the arrows.
  check: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 L6.5 12 L13 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fork: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2 V8 H12 V2 M8 8 V14" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>',
  // viewBox cropped to the ink (the stacked +/− is tall and narrow): a full 16-box in a square icon
  // shell reads as phantom side padding in the pill.
  diff: '<svg viewBox="4 2 8 12" fill="none"><path d="M5.25 6 H10.75 M8 3.25 V8.75" stroke="var(--diff-add)" stroke-width="1.8" stroke-linecap="round"/><path d="M5.25 12.5 H10.75" stroke="var(--err)" stroke-width="1.8" stroke-linecap="round"/></svg>',
} as const

export type IconName = keyof typeof icons | keyof typeof custom

// Inject currentColor only when the root svg has no fill of its own (a stroke icon carries
// fill="none"; duplicating the attribute would override it — first occurrence wins in HTML).
const svgFor = (name: IconName): string => {
  const s = (custom as Record<string, string>)[name] ?? iconSvgs[(icons as Record<string, string>)[name] ?? ''] ?? ''
  return /<svg[^>]*\bfill=/.test(s) ? s : s.replace('<svg ', '<svg fill="currentColor" ')
}

/** One standardized icon: a span.icon shell the CSS sizes (default 14px; context classes
 *  override), the svg filling it. Extra classes ride along (e.g. 'caret-tri open'). */
export const icon = (name: IconName, cls: string | string[] = '') =>
  span({
    class: ['icon', ...(Array.isArray(cls) ? cls : [cls])],
    key: `icon-${name}`,
    // Empty-string child + innerHTML on mount — the splitter's lesson: some renderers skip
    // childless factories, and onMounted is the one hook that sees the real element.
    onMounted: (el: Element) => { el.innerHTML = svgFor(name) },
  }, '')
