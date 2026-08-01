/**
 * The `tb.mode` values, owned in one place (TB-Mode.md). Every producer emits mode as a
 * *string* baked into a sandbox page, so a hand-typed copy compiles clean and fails only at
 * runtime inside the frame; producers interpolate `MODE` instead. It lives in `format`
 * because the client and the CLI both import `typebulb/format`, and runtime imports neither.
 *
 * Mode names the host surface, never the capability — `'local'` spans Restricted and Trusted.
 * Bulbs ask for capability directly (`tb.aiAccess()`).
 */

export const MODE = {
  /** The user's machine, via the CLI. */
  local: 'local',
  /** typebulb.com's editor, in a frame beside the code. */
  ide: 'ide',
  /** The bulb's own page on typebulb.com. */
  published: 'published',
  /** Inline in an agent's transcript, rendered by the mirror (bulb-in-a-bulb). */
  inline: 'inline',
} as const

export type TbMode = (typeof MODE)[keyof typeof MODE]

/** The union as it appears in the emitted `tb` typings — generated, so the `.d.ts` can't drift from MODE. */
export const modeUnion: string = Object.values(MODE).map(v => `'${v}'`).join(' | ')
