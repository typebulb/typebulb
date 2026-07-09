/**
 * Public node-side entry: the breakout server-management capability — launch, list,
 * and stop standalone bulb dev servers. Separate from the browser `.` entry (render.ts)
 * because this spawns processes and touches the on-disk registry, so it must never be
 * bundled into the self-contained browser build (Embed spec Invariant 6). Hosts of
 * embedded bulbs import this to graduate an embed into its own running server.
 */
export { launchBulbServer, listBulbServers, stopBulbServer, readServerLog, serverLogPath, type BulbServer } from './serve/serverRegistry.js'
export { listBulbFiles, type BulbFileInfo } from './serve/bulbFiles.js'
// Proactive trust prediction — scan a bulb for privileged tb.* usage so a host can offer --trust
// before launching (TB-Security.md "Proactive prediction"). A hint, never a gate.
export { predictBulbTrust } from './serve/predictBulbTrust.js'
export { bulbName, slugifyBulbName, stripFrontmatter } from './bulb/source.js'
// Derive missing config.json `dependencies` from a bulb's imports (TB-Lint-Transpile.md) — breakout
// uses it so a promoted embed is a correct, runnable .bulb.md even when the author omitted config.json.
export { ensureDeclaredDependencies } from './bulb/deriveDeps.js'
// Cross-platform editor launcher (open a cited file at a line). Agent-agnostic, so any mirror
// bulb shares one resolved-editor, detached-spawn implementation instead of re-deriving it.
export { openInEditor } from './serve/editor.js'
// Per-bulb trust memory (TB-Security.md) — the CLI owns the policy store; a GUI host
// (claude.bulb) delegates to it so the launcher toggle and the `typebulb trust` CLI share one source.
export { isBulbTrusted, setBulbTrusted, listTrustedBulbs } from './serve/trustStore.js'
// Model discovery (the same key-filtered catalog + local Ollama probe tb.models() uses), so a mirror
// host can populate a model switcher through this public entry rather than a deep serve/ internal.
export { getFilteredModels, catalogFetchError } from './serve/modelCatalog.js'
// The tb.ai primitives (env-cascade provider resolution + one streamed chat request), so a mirror
// feature (the composer's paste naming) makes its cheap model call through this public entry.
export { resolveLocalProvider, sendTbAi } from './serve/localProvider.js'
// The skill's two on-disk parts, so the pi extension's mirror-orientation block
// (agents/pi/server/piExtension.ts) points at the same artifacts `typebulb skill` and
// `typebulb agent` emit — through this public entry, per the agent-boundary rule.
export { bundledReadmePath, bundledDescriptionPath } from './skill.js'
