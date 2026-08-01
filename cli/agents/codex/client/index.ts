import { App } from 'domeleon'
import { Root } from '../../core/client/root.js'
import { CodexModelPill } from './modelPill.js'

// Codex's agent mirror client entry: the neutral Root plus a read-only model pill — Codex switches
// models natively (no switcher proxy or watchdog overlay, unlike Claude) and has no driver (no
// composer, unlike Pi): a read-only mirror (TB-Agent-Codex.md). Everything else (transcript, embeds,
// session picker, token chip, bulb launcher, prose toggle) is the shared neutral UI.
document.title = 'Codex Mirror'

new App({
  root: new Root({ title: 'Codex Mirror', pills: [new CodexModelPill()] }),
  id: 'app',
})
