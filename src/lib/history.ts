import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {defaultArchivePath} from './constants.js'

export {defaultArchivePath} from './constants.js'

const HISTORY_FILE = path.join(os.homedir(), '.config', 'herlink', 'history.json')
const LIMIT = 50

/**
 * P0-2 archive note:
 * UI history (history.json) keeps the last 50 URLs for quick recall (↑).
 * Download deduplication for playlists is handled by yt-dlp's --download-archive
 * (archive.txt with "extractor id" lines). history.ts does NOT duplicate that
 * logic — the archive file is passed straight to yt-dlp via buildDownloadArgs().
 * Use defaultArchivePath() when the user passes --download-archive without a value.
 */
export const ARCHIVE_FILE = defaultArchivePath()

export function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/** Prepend a url (deduped, capped) and persist. Returns the new list. */
export function addToHistory(url: string): string[] {
  const next = [url, ...loadHistory().filter(entry => entry !== url)].slice(0, LIMIT)
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), {recursive: true})
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // history is a nicety — never let it break a download
  }
  return next
}
