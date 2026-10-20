import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentAdapter } from './adapter.js'
import { sessionTags } from './tagIndex.js'
import { childFacts } from './childReport.js'
import { threadsOf, type Answer, type TagThread } from '../tags.js'
import type { ChildTranscript } from '../events.js'
import { typebulbHome } from '../../../src/servers.js'

// The board's server half (TB-Agent-Board.md): a session's threads from its own tags and its
// children's, and the owner's answers, kept per session beside `slow/` and `babysit/`. The mirror is
// the answers' only writer; status and babysit read them.

const answersFile = (sessionId: string) => join(typebulbHome(), 'answers', `${sessionId}.json`)

export function readAnswers(sessionId: string): Record<string, Answer> {
  try { return JSON.parse(readFileSync(answersFile(sessionId), 'utf8')) as Record<string, Answer> } catch { return {} }
}

/** Record one answer; a later answer to the same id replaces it. */
export function saveAnswer(sessionId: string, id: string, a: Answer) {
  const file = answersFile(sessionId)
  const all = { ...readAnswers(sessionId), [id]: a }
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
}

/** Every thread in a session, its own tags and its children's together in time order, and each
 *  child's brief line for the board's rows. */
export function sessionThreads<E>(adapter: AgentAdapter<E>, cwd: string, sessionId: string, file: string | undefined, kids: ChildTranscript[]): { threads: TagThread[]; briefs: Map<string, string> } {
  const { tags, briefs } = childFacts(adapter, cwd, kids)
  const all = [...sessionTags(adapter, file), ...tags].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))
  return { threads: threadsOf(all, readAnswers(sessionId)), briefs }
}
