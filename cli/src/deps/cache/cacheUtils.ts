import * as fs from 'fs/promises'
import * as crypto from 'crypto'

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex')
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')) as T } catch { return undefined }
}

export async function readText(filePath: string): Promise<string | undefined> {
  try { return await fs.readFile(filePath, 'utf8') } catch { return undefined }
}
