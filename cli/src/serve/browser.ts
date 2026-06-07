/**
 * Cross-platform browser launcher.
 */

import open from 'open'

/** Open a URL in the default browser */
export async function openBrowser(url: string): Promise<void> {
  await open(url)
}
