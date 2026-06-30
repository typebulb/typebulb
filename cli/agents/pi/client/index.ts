import { App } from 'domeleon'
import { Root } from '../../core/client/root.js'
import { PiModelPill } from './modelPill.js'

// pi's agent mirror client entry: the neutral Root plus a single read-only model pill (pi switches
// models natively — no switcher proxy or watchdog overlay, unlike Claude; TB-Harness.md). Everything else
// (transcript, embeds, session picker, token chip, bulb launcher, prose toggle) is the shared neutral UI.
document.title = 'Pi Mirror'

new App({
  root: new Root({ title: 'Pi Mirror', pills: [new PiModelPill()] }),
  id: 'app',
})
