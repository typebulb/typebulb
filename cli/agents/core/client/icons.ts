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
const custom = {
  caret: '<svg viewBox="0 0 16 16"><path d="M4 1.5 L13 8 L4 14.5 Z" fill="currentColor"/></svg>',
  fork: '<svg viewBox="0 0 16 16" fill="none"><path d="M4 2 V8 H12 V2 M8 8 V14" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/></svg>',
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
