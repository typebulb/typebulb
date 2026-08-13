/**
 * Text arriving from outside the CLI: a file, or stdin through the `-` source token that
 * `call --args -`, `put <kind>=-` and `send <file> -` all speak. Shared rather than per-command
 * because all three read the same transport, and a third copy is how the three drift.
 */

/** Read all of stdin as UTF-8 — backs every `-` source, which sidesteps shell quoting (PowerShell). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

/** Leading BOM stripped + CRLF→LF + trailing trim (TB-Get-Put.md Normalization): transport
 *  artifacts of Windows tooling, never intended content — PowerShell 5.1's default UTF-8 writes a
 *  BOM, and one baked into a block breaks `JSON.parse` (so `tb.json(0)`) on the very results files
 *  `put` exists to promote. Block bodies are stored LF; the fence framing supplies the final newline.
 *  `send` normalizes its piped payload through this too, so piping text and passing the same text
 *  positionally deliver the same value. */
export function normalizeContent(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return noBom.replace(/\r\n/g, '\n').trimEnd()
}
