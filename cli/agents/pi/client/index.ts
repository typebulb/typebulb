import { App } from 'domeleon'
import { Root } from '../../core/client/root.js'
import { Composer } from '../../core/client/composer.js'
import { PiModelPill } from './modelPill.js'
import { piRecipes } from './recipes.js'

// pi's agent mirror client entry: the neutral Root plus a read-only model pill (pi switches models
// natively — no switcher proxy or watchdog overlay, unlike Claude; TB-Agent-Harness.md) and the composer —
// pi is drivable (PiAdapter.createDriver), so this mirror gets the prompt panel Claude's doesn't
// (TB-Agent-Composer.md). Everything else (transcript, embeds, session picker, token chip, bulb
// launcher, prose toggle) is the shared neutral UI.
document.title = 'Pi Mirror'

new App({
  root: new Root({ title: 'Pi Mirror', pills: [new PiModelPill()], composer: new Composer(piRecipes) }),
  id: 'app',
})
