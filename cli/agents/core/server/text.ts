// Neutral text caps shared by every agent adapter's entry parsing. A renderable image is left whole by
// the adapter (it becomes a data-URI markdown image); everything else — a base64 blob an agent emitted
// as text, a huge tool dump — is capped before it reaches the view, truncated with a marker rather than
// streamed in full.
export const MAX_BLOCK_CHARS = 50_000

export function capText(s: string): string {
  return s.length > MAX_BLOCK_CHARS
    ? s.slice(0, MAX_BLOCK_CHARS) + `\n…[${s.length - MAX_BLOCK_CHARS} more characters truncated]`
    : s
}

// A base64 image → an inline markdown image so it renders instead of dumping raw base64. One format,
// shared by every adapter's image-block path (CC reads `source.media_type`/`source.data`, Pi reads
// `mimeType`/`data`), so the data-URI shape can't drift between them.
export const dataUriImage = (base64: string, mediaType?: string) =>
  `![pasted image](data:${mediaType || 'image/png'};base64,${base64})`
