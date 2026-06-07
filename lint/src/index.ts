/**
 * Lints a bulb's code block for environment-specific issues — patterns that are
 * valid TypeScript but break in the Typebulb runtime. Shared by typebulb.com and
 * the CLI (`typebulb check`) so both enforce the same rules with the same
 * AI-facing messages.
 *
 * Target-aware: `code.tsx` runs in the browser under an import map and a sandboxed
 * iframe, `server.ts` runs in Node. The import-map / browser rules (dynamic
 * import, URL / version / `.js`-deep-path imports, CSS imports, navigation) apply
 * only to the client; the Sucrase / ESM core (require, `const enum`, `namespace`,
 * `export =` / `import =`, `module {}`, redundant `tb`) applies to both.
 */

export type LintTarget = 'client' | 'server'

export type LintIssueType =
  | 'DYNAMIC_IMPORT' | 'COMMONJS_REQUIRE' | 'JS_EXTENSION_IMPORT' | 'URL_IMPORT'
  | 'VERSION_SPECIFIER_IMPORT' | 'REDUNDANT_TB_DECLARATION' | 'CONST_ENUM'
  | 'NAMESPACE_DECLARATION' | 'COMMONJS_EXPORT_EQUALS' | 'COMMONJS_IMPORT_EQUALS'
  | 'MODULE_DECLARATION' | 'CSS_FILE_IMPORT' | 'NAVIGATION'

export type LintIssue = {
  type: LintIssueType
  severity: 'error'
  message: string    // AI-friendly feedback
  lineNumber?: number  // Line number in the source file
  lineContent?: string // The problematic line for debugging
}

const CLIENT: readonly LintTarget[] = ['client']
const BOTH: readonly LintTarget[] = ['client', 'server']

interface Rule { type: LintIssueType; pattern: RegExp; targets: readonly LintTarget[] }

const RULES: Rule[] = [
  { type: 'DYNAMIC_IMPORT', pattern: /\bimport\s*\(\s*['"`]/, targets: CLIENT },
  { type: 'COMMONJS_REQUIRE', pattern: /\brequire\s*\(\s*['"`]/, targets: BOTH },
  // Only flag .js extension when it appears in a deep import path (has /).
  // Package names that ARE ".js" (like "decimal.js") are legitimate npm packages.
  // Browser-only: a `.js` on a deep path is valid (often required) in Node ESM.
  { type: 'JS_EXTENSION_IMPORT', pattern: /from\s+['"][^'"]*\/[^'"]*\.js['"]/, targets: CLIENT },
  { type: 'URL_IMPORT', pattern: /from\s+['"]https?:\/\//, targets: CLIENT },
  { type: 'VERSION_SPECIFIER_IMPORT', pattern: /from\s+['"][^'"]*@[\d^~]/, targets: CLIENT },
  { type: 'REDUNDANT_TB_DECLARATION', pattern: /declare\s+(const|var|let)\s+tb\b/, targets: BOTH },
  { type: 'CONST_ENUM', pattern: /\bconst\s+enum\b/, targets: BOTH },
  { type: 'NAMESPACE_DECLARATION', pattern: /\bnamespace\s+\w+/, targets: BOTH },
  { type: 'COMMONJS_EXPORT_EQUALS', pattern: /\bexport\s*=/, targets: BOTH },
  { type: 'COMMONJS_IMPORT_EQUALS', pattern: /\bimport\s+\w+\s*=/, targets: BOTH },
  { type: 'MODULE_DECLARATION', pattern: /\bmodule\s+\w+\s*\{/, targets: BOTH },
  { type: 'CSS_FILE_IMPORT', pattern: /(?:from|import)\s+['"][^'"]*\.css['"]/, targets: CLIENT },
  // Navigation APIs break the sandboxed iframe.
  { type: 'NAVIGATION', pattern: /window\.(location\.(reload|assign|replace)\s*\(|open\s*\()/, targets: CLIENT },
  { type: 'NAVIGATION', pattern: /window\.location(\.href)?\s*=[^=]/, targets: CLIENT },
]

/**
 * Lint a bulb code block. `target` selects the ruleset: `client` (`code.tsx`,
 * the browser superset) or `server` (`server.ts`, the Sucrase / ESM core only).
 */
export function lint(source: string, options: { target: LintTarget }): LintIssue[] {
  if (!source) return []
  const { target } = options
  const issues: LintIssue[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1
    for (const rule of RULES) {
      if (!rule.targets.includes(target)) continue
      if (!rule.pattern.test(line)) continue
      issues.push({
        type: rule.type,
        severity: 'error',
        message: messageFor(rule.type, lineNumber),
        lineNumber,
        lineContent: line,
      })
    }
  }

  return issues
}

function messageFor(type: LintIssueType, lineNumber: number): string {
  if (type === 'URL_IMPORT') {
    return `Direct URL imports are not supported! Found on line ${lineNumber}.

**CRITICAL**: Import packages by name only. Do NOT use CDN URLs:

✅ CORRECT - Package name only:
\`\`\`typescript
import React from "react"
import _ from "lodash"
\`\`\`

❌ WRONG - Direct URL imports:
\`\`\`typescript
import React from "https://esm.sh/react"
import _ from "https://cdn.skypack.dev/lodash"
import x from "https://unpkg.com/some-package"
\`\`\`

**Fix:** Use the package name only. Package resolution is handled automatically.`
  }

  if (type === 'VERSION_SPECIFIER_IMPORT') {
    return `Version specifiers in imports are not supported! Found on line ${lineNumber}.

**CRITICAL**: Import packages by name only. Do NOT include version numbers:

✅ CORRECT - Package name only:
\`\`\`typescript
import React from "react"
import _ from "lodash"
import { something } from "@scope/package"
\`\`\`

❌ WRONG - Version in import path:
\`\`\`typescript
import React from "react@18.2.0"
import _ from "lodash@^4.17.0"
import { x } from "@scope/package@1.0.0"
\`\`\`

**Fix:** Remove the version specifier (everything from @ onwards). Versions are managed separately.`
  }

  if (type === 'JS_EXTENSION_IMPORT') {
    return `Deep import paths must NOT include \`.js\` extension! Found on line ${lineNumber}.

**CRITICAL**: Remove the \`.js\` extension from deep import paths (paths with \`/\`):

✅ CORRECT - No extension in deep import:
\`\`\`typescript
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls"
\`\`\`

❌ WRONG - Has .js extension in deep import:
\`\`\`typescript
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
\`\`\`

**Note:** Package names that literally end with ".js" (like \`decimal.js\`) are fine - this rule only applies to file paths within packages.

**Fix:** Remove \`.js\` from the end of the import path.`
  }

  if (type === 'DYNAMIC_IMPORT') {
    return `Dynamic imports are not supported! You used \`import('...')\` on line ${lineNumber}.

**CRITICAL**: All imports MUST be at the TOP of the file using standard ES6 import syntax:

✅ CORRECT - Static import at top of file:
\`\`\`typescript
import { createRoot } from 'react-dom/client'

// Later in code...
const root = createRoot(rootElement)
root.render(<App />)
\`\`\`

❌ WRONG - Dynamic import() in code:
\`\`\`typescript
// This is completely invalid!
import('react-dom/client').then(({ createRoot }) => {
  const root = createRoot(rootElement)
  root.render(<App />)
})
\`\`\`

**Fix:** Move ALL import statements to the top of the file using standard \`import\` syntax.`
  }

  if (type === 'REDUNDANT_TB_DECLARATION') {
    return `Redundant \`declare const tb\` found on line ${lineNumber}.
The \`tb\` global is already provided by the environment. Remove this declaration.`
  }

  if (type === 'CONST_ENUM') {
    return `\`const enum\` is not supported! Found on line ${lineNumber}.

**Fix:** Use a regular \`enum\` or an object with \`as const\`:

\`\`\`typescript
// Option 1: Regular enum
enum Direction { Up, Down, Left, Right }

// Option 2: Object literal (often better)
const Direction = { Up: 0, Down: 1, Left: 2, Right: 3 } as const
\`\`\`

\`const enum\` requires the full TypeScript compiler to inline values at compile time. Regular \`enum\` and object literals work identically at runtime.`
  }

  if (type === 'NAMESPACE_DECLARATION') {
    return `TypeScript \`namespace\` is not supported! Found on line ${lineNumber}.

**Fix:** Use ES modules instead:

\`\`\`typescript
// Instead of: namespace MyLib { export function foo() {} }
// Just use top-level exports:
export function foo() {}
\`\`\`

Namespaces are a legacy TypeScript pattern. Use standard ES module imports/exports instead.`
  }

  if (type === 'COMMONJS_EXPORT_EQUALS') {
    return `\`export =\` syntax is not supported! Found on line ${lineNumber}.

**Fix:** Use ES module \`export default\` instead:

\`\`\`typescript
// Instead of: export = myValue
export default myValue
\`\`\``
  }

  if (type === 'COMMONJS_IMPORT_EQUALS') {
    return `\`import x =\` syntax is not supported! Found on line ${lineNumber}.

**Fix:** Use ES module \`import\` instead:

\`\`\`typescript
// Instead of: import x = require('module')
import x from 'module'
\`\`\``
  }

  if (type === 'MODULE_DECLARATION') {
    return `TypeScript \`module\` declarations are not supported! Found on line ${lineNumber}.

**Fix:** Use ES modules instead. The \`module Foo {}\` syntax is a legacy TypeScript pattern — use standard imports/exports.`
  }

  if (type === 'CSS_FILE_IMPORT') {
    return `Importing CSS files is not supported! Found on line ${lineNumber}.

**CRITICAL**: CSS imports don't work here. The styles.css block is already applied to the page automatically.

✅ CORRECT - Just remove the import. CSS from the styles.css block is already applied to the page.

❌ WRONG - Importing CSS as a file:
\`\`\`typescript
import "./styles.css"
import styles from "./styles.css"
\`\`\`

**Fix:** Delete the CSS import line entirely. Write styles in the styles.css block — they are loaded automatically.`
  }

  if (type === 'NAVIGATION') {
    return `Navigation is forbidden in this sandboxed environment! Found on line ${lineNumber}.

**CRITICAL**: \`window.location\` changes, \`window.open()\`, and page reloads will break the app.

✅ CORRECT - Reset application state programmatically:
\`\`\`typescript
setState(initialState)
\`\`\`

❌ WRONG - Browser navigation:
\`\`\`typescript
window.location.reload()
window.location.href = "..."
window.open("...")
\`\`\`

**Fix:** Remove the navigation call. To "restart", reset your state variables instead.`
  }

  return `CommonJS \`require()\` is not supported! Found on line ${lineNumber}.

**CRITICAL**: Use ES6 \`import\` statements at the TOP of the file:

✅ CORRECT - ES6 import:
\`\`\`typescript
import { something } from 'module-name'
\`\`\`

❌ WRONG - CommonJS require:
\`\`\`typescript
const something = require('module-name')  // NOT SUPPORTED!
\`\`\`

**Fix:** Replace all \`require()\` calls with ES6 \`import\` statements at the top of the file.`
}
