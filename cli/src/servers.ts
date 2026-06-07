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
// before launching (Specs/Typebulb-CLI-Trust.md "Proactive prediction"). A hint, never a gate.
export { predictBulbTrust } from './serve/predictBulbTrust.js'
export { bulbName, slugifyBulbName, stripFrontmatter } from './bulb/source.js'
// Cross-platform editor launcher (open a cited file at a line). Agent-agnostic, so any viewer
// bulb shares one resolved-editor, detached-spawn implementation instead of re-deriving it.
export { openInEditor } from './serve/editor.js'
// Per-bulb trust memory (Specs/Typebulb-CLI-Trust.md) — the CLI owns the policy store; a GUI host
// (claude.bulb) delegates to it so the launcher toggle and the `typebulb trust` CLI share one source.
export { isBulbTrusted, setBulbTrusted, listTrustedBulbs } from './serve/trustStore.js'
