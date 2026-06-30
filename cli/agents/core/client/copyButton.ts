import { Component, button } from 'domeleon'

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
    navigator.clipboard?.writeText(this.#text)
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
