export class TypeRefScanner {
  collectRelativeTypeRefs(text: string) {
    return this.collectRefs(text).filter(s => s.startsWith('./') || s.startsWith('../'))
  }

  collectBareModuleRefs(text: string) {
    return this.collectRefs(text).filter(s => this.isBare(s))
  }

  private collectRefs(text: string) {
    // Drop comment-styled lines so imports quoted in JSDoc @example blocks aren't
    // harvested as refs (each phantom costs a fan-out of 404 probes). Line-based on
    // purpose: stripping /* … */ as a region would mangle `declare module 'x/*'`,
    // whose string literal contains a literal `/*`.
    const code = text.split('\n').filter(line => {
      const t = line.trimStart()
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
    }).join('\n')
    const refs = new Set<string>()
    for (const m of code.matchAll(/(import|export)\s+[^'"\n]*from\s*['"]([^'"\n]+)['"]/g)) refs.add(m[2])
    for (const m of code.matchAll(/export\s*\*\s*from\s*['"]([^'"\n]+)['"]/g)) refs.add(m[1])
    return Array.from(refs)
  }

  private isBare(s: string): boolean {
    return !(s.startsWith('./') || s.startsWith('../') || s.startsWith('file:') || s.startsWith('http://') || s.startsWith('https://'))
  }
}
