import { App } from 'domeleon'
import { Root } from './root.js'

// Override the CLI's `<name> - typebulb` default tab title.
document.title = 'Claude Mirror'

new App({ root: new Root(), id: 'app' })
