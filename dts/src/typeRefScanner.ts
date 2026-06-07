export class TypeRefScanner {
  collectRelativeTypeRefs(text: string) {
    return this.collectRefs(text).filter(s => s.startsWith('./') || s.startsWith('../'))
  }

  collectBareModuleRefs(text: string) {
    return this.collectRefs(text).filter(s => this.isBare(s))
  }

  private collectRefs(text: string) {
    const refs = new Set<string>()
    const add = (m: RegExpExecArray, idx: number) => { refs.add(m[idx]); return null }
    this.matchAll(text, /(import|export)\s+[^'"\n]*from\s*['"]([^'"\n]+)['"]/, m => add(m, 2))
    this.matchAll(text, /export\s*\*\s*from\s*['"]([^'"\n]+)['"]/, m => add(m, 1))
    return Array.from(refs)
  }

  private matchAll<T>(text: string, regex: RegExp, mapper: (match: RegExpExecArray) => T | null): T[] {
    const results: T[] = []
    try {
      const re = new RegExp(regex.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const r = mapper(m)
        if (r !== null) results.push(r)
      }
    } catch {}
    return results
  }

  private isBare(s: string): boolean {
    return !(s.startsWith('./') || s.startsWith('../') || s.startsWith('file:') || s.startsWith('http://') || s.startsWith('https://'))
  }
}
