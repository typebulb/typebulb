import { App } from 'domeleon'
import { Root } from './core/client/root.js'
import { Composer } from './core/client/composer.js'
import type { RootConfig } from './core/client/types.js'
import { ModelPill } from './claude/client/modelPill.js'
import { CodexModelPill } from './codex/client/modelPill.js'
import { PiModelPill } from './pi/client/modelPill.js'
import { piRecipes } from './pi/client/recipes.js'

// The one mirror client every harness serves (TB-Agent-Harness.md): the neutral Root, composed per
// harness from this table and picked by the agent name page.ts stamps on <html data-agent>.
function root(cfg: RootConfig): Root {
  document.title = cfg.title
  return new Root(cfg)
}

const HARNESSES: Record<string, () => Root> = {
  // The model switcher (TB-Agent-Switcher.md): a status-bar pill, the watchdog banner, the per-poll refresh.
  claude: () => {
    const pill = new ModelPill()
    return root({ title: 'Claude Mirror', pills: [pill], overlays: [() => pill.watchdogView()], onPollTick: () => { void pill.tickState() } })
  },
  // Read-only model pill and no driver: Codex switches models natively (TB-Agent-Codex.md).
  codex: () => root({ title: 'Codex Mirror', pills: [new CodexModelPill()] }),
  // Read-only model pill plus the composer: pi is drivable (TB-Agent-Composer.md).
  pi: () => root({ title: 'Pi Mirror', pills: [new PiModelPill()], composer: new Composer(piRecipes) }),
}

const agent = document.documentElement.dataset.agent ?? ''
const make = HARNESSES[agent]
if (!make) throw new Error(`No mirror client for agent "${agent}"`)
new App({ root: make(), id: 'app' })
