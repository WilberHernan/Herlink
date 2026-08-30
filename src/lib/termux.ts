import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TERMUX_PREFIX = '/data/data/com.termux/files/usr'

export const YTDLP_TERMUX_ERROR = 'yt-dlp no está instalado. Instálalo con: pkg install python-yt-dlp'
export const FFMPEG_TERMUX_HINT = 'ffmpeg no encontrado. Instálalo con: pkg install ffmpeg'
export const TERMUX_API_HINT = 'El portapapeles necesita la app Termux:API. Instálala con: pkg install termux-api'
export const TERMUX_STORAGE_HINT = 'Ejecuta termux-setup-storage para habilitar el almacenamiento compartido (~/storage/Downlink)'
// relative to ~/storage — Downlink is a dedicated shared-storage folder for
// downloads, at the root of the storage mount (browser file manager)
export const TERMUX_VIDEOS_DIR = 'Downlink'

// read at call time, not module load — tests flip the env between cases and a
// cached const would freeze the first answer forever
export function isTermux(): boolean {
  return process.env.PREFIX === TERMUX_PREFIX && Boolean(process.env.ANDROID_ROOT)
}

/** True for ~/storage itself and everything under it (the termux-setup-storage shared dir). */
export function isSharedStorageDir(dir: string): boolean {
  const storage = path.join(os.homedir(), 'storage')
  return dir === storage || dir.startsWith(storage + path.sep)
}

/**
 * Download destination: ~/storage/Downlink (a dedicated shared storage folder
 * at the root of the mount) when termux-setup-storage ran (created on first
 * run), ~/Downloads otherwise. Desktop always ~/Downloads.
 */
export async function resolveOutDir(baseDir = os.homedir()): Promise<{dir: string; hint?: string}> {
  if (isTermux()) {
    const storage = path.join(baseDir, 'storage')
    try {
      if (!(await fs.stat(storage)).isDirectory()) throw new Error('not a directory')
    } catch {
      // shared storage not set up — fall through to ~/Downloads
      return {dir: path.join(baseDir, 'Downloads'), hint: TERMUX_STORAGE_HINT}
    }
    const shared = path.join(storage, TERMUX_VIDEOS_DIR)
    await fs.mkdir(shared, {recursive: true})
    return {dir: shared}
  }
  return {dir: path.join(baseDir, 'Downloads')}
}
