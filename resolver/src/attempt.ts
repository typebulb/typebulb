export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch { return undefined }
}
