import { Component, button } from 'domeleon'

/** Copy text, and say whether it landed. A VS Code webview can refuse the async clipboard, which
 *  failed silently and left the reader pasting an old copy, so the selection-and-copy command is the
 *  fallback. Call it inside the click: either route needs the gesture. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.appendChild(area)
  area.select()
  try { return document.execCommand('copy') } catch { return false } finally { area.remove() }
}

// Copy-to-clipboard button with a brief "copied" colour flash. Its own Component so domeleon keeps
// its DOM node stable across re-renders — that stability is what lets the CSS colour transition run.
// Instances live in MessageList.copyButtons (a public array) so domeleon discovers them; an inline
// button() re-emitted each render would be recreated and couldn't transition.
export class CopyButton extends Component {
  done = false
  #text: string

  constructor(text: string) {
    super()
    this.#text = text
  }

  setText(text: string) { this.#text = text }

  flash() {
    void copyText(this.#text)
    this.done = true
    this.update()
    setTimeout(() => { this.done = false; this.update() }, 600)
  }

  view() {
    return button({
      class: ['overlay-pill', 'copy', this.done ? 'done' : ''],
      onClick: (e: MouseEvent) => { e.stopPropagation(); this.flash() },
    }, this.done ? 'copied' : 'copy')
  }
}
