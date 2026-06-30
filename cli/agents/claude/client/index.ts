import { App } from 'domeleon'
import { Root } from '../../core/client/root.js'
import { ModelPill } from './modelPill.js'

// Claude's agent mirror client entry: the neutral Root (../../client) composed with the Claude-only
// model switcher (TB-Agent-Switcher.md). The switcher is injected three ways — as a status-bar pill,
// as the watchdog overlay banner, and as the per-poll refresh hook — so Root itself stays
// harness-neutral (TB-Harness.md). Pi's entry composes the same Root with none of these.
document.title = 'Claude Mirror'

const modelPill = new ModelPill()

new App({
  root: new Root({
    title: 'Claude Mirror',
    pills: [modelPill],
    overlays: [() => modelPill.watchdogView()],
    onPollTick: () => { void modelPill.tickState() },
  }),
  id: 'app',
})
