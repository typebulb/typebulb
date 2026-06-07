/**
 * Bulb format access for the CLI. The portable format — parse, serialize, the block registry, the
 * config shape, data chunking — is the single source in typebulb/format; this module re-exports it
 * and adds the one CLI-only block, `server.ts`.
 */

export * from 'typebulb/format'
export { splitIntoChunks as parseDataChunks } from 'typebulb/format'

import { toBulbData, type BulbData, type ParsedBulb } from 'typebulb/format'

/** A local bulb is a portable bulb plus the CLI-only `server.ts` block. */
export type LocalBulb = BulbData & { server: string }

/** Like `toBulbData`, but also lifts the CLI-only `server.ts` block out of the parsed file map. */
export function toLocalBulb(parsed: ParsedBulb): LocalBulb {
  return { ...toBulbData(parsed), server: parsed.files.get('server.ts') ?? '' }
}
