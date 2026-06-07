/** Minimal YAML scalar escaping for the single `name:` frontmatter value — not a general YAML codec. */

export function escapeYamlString(str: string): string {
  if (/[:\n"']/.test(str) || str.startsWith(' ') || str.endsWith(' ')) {
    return `"${str.replace(/"/g, '\\"')}"`
  }
  return str
}

export function unescapeYamlString(str: string): string {
  if (str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1).replace(/\\"/g, '"')
  }
  if (str.startsWith("'") && str.endsWith("'")) {
    return str.slice(1, -1)
  }
  return str
}
