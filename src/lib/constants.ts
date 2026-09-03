import os from 'node:os'
import path from 'node:path'

export const DEFAULT_RETRIES = 10
export const DEFAULT_FRAGMENT_RETRIES = 10
export const DEFAULT_RETRY_SLEEP = '1'
export const DEFAULT_SOCKET_TIMEOUT = 30
// app-level backoff before each fresh-extraction retry (aria2 retry-wait
// pattern): a brief connectivity cut that yt-dlp's burst retries can't ride
// out gets a real wait so it can recover instead of erroring 1s later.
export const DEFAULT_RETRY_BACKOFF_MS = 1000
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3

export function defaultArchivePath(): string {
  return path.join(os.homedir(), '.herlink', 'archive.txt')
}
