import os from 'node:os'
import path from 'node:path'

export const DEFAULT_RETRIES = 10
export const DEFAULT_FRAGMENT_RETRIES = 10
export const DEFAULT_RETRY_SLEEP = '1'
export const DEFAULT_SOCKET_TIMEOUT = 30

export function defaultArchivePath(): string {
  return path.join(os.homedir(), '.herlink', 'archive.txt')
}
