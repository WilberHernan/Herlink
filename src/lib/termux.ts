import {spawn} from 'node:child_process'
import {constants, accessSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const TERMUX_PREFIX = '/data/data/com.termux/files/usr'

export const YTDLP_TERMUX_ERROR = 'yt-dlp no está instalado. Instálalo con: pkg install python-yt-dlp'
export const FFMPEG_TERMUX_HINT = 'ffmpeg no encontrado. Instálalo con: pkg install ffmpeg'
export const TERMUX_API_HINT = 'El portapapeles necesita la app Termux:API. Instálala con: pkg install termux-api'
export const TERMUX_STORAGE_HINT = 'Ejecuta termux-setup-storage para habilitar el almacenamiento compartido (~/storage/shared/Download/Downlink)'
export const TERMUX_WAKE_LOCK_HINT = '🔒 Mantengo la pantalla activa mientras descargo — termux-wake-lock'
// relative to ~/storage — shared → /sdcard (root of Android's internal
// storage), so shared/Download/Downlink maps to the real /sdcard/Download/
// folder, visible in the file manager under Downloads/Downlink
export const TERMUX_VIDEOS_DIR = path.join('shared', 'Download', 'Downlink')

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
 * Download destination: ~/storage/shared/Download/Downlink (the real Android
 * /sdcard/Download/Downlink, visible in the file manager under Downloads) when
 * termux-setup-storage ran (created on first run), ~/Downloads otherwise.
 * Desktop always ~/Downloads.
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

/**
 * Absolute path of an executable `command` on PATH (+ $PREFIX/bin, which Termux
 * puts on PATH at login but a bare TUI spawn may skip), or undefined if missing.
 * Pure existence check — it never RUNS the command, so probe/acquire stays
 * side-effect free and can't trigger Termux's first-run permission prompt.
 */
function resolveCommand(command: string): string | undefined {
  if (!command) return undefined
  const dirs = new Set([...(process.env.PATH ?? '').split(path.delimiter)])
  if (isTermux()) dirs.add(path.join(TERMUX_PREFIX, 'bin'))
  for (const dir of dirs) {
    if (!dir) continue
    try {
      const candidate = path.join(dir, command)
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep scanning later dirs
    }
  }
  return undefined
}

/** True when `command` resolves to an executable on PATH or $PREFIX/bin. */
export function commandWorks(command: string): boolean {
  return resolveCommand(command) !== undefined
}

// held-state lives here, not the caller, so release is idempotent and the TUI
// hint can read it without duplicating the acquire/release bookkeeping
let wakeLockHeld = false

/**
 * Fire-and-forget the Termux CLI binary. stdio is ignored, the child is
 * detached from our process group and unref'd: the call never blocks the TUI
 * (termux-wake-lock can take seconds on some Android versions) and survives a
 * terminal signal so the background wakelock stays held for the whole run.
 */
function runLockCommand(command: string): void {
  // resolve to the absolute path so spawn matches commandWorks even when
  // $PREFIX/bin isn't on the process PATH (the TUI can skip the login shell)
  const binary = resolveCommand(command)
  if (!binary) return
  let child
  try {
    child = spawn(binary, [], {stdio: 'ignore', detached: true})
  } catch {
    return
  }
  child.unref()
  // TOCTOU / permission race: if the check passes but the spawn still fails
  // (binary vanished, exec denied), swallow the error — it must never crash
  // the download TUI with an uncaught ENOENT.
  child.on('error', () => {})
}

/**
 * Holds a CPU wakelock on Termux so Android doesn't deep-sleep while the queue
 * runs in the background. No-op and false on desktop or when the binary is
 * missing — a missing termux-tools must never block a download, only hint.
 */
export function acquireWakeLock(): boolean {
  if (!isTermux() || !commandWorks('termux-wake-lock')) return false
  runLockCommand('termux-wake-lock')
  wakeLockHeld = true
  return true
}

/** Releases the Termux wakelock; safe to call when none was acquired. */
export function releaseWakeLock(): void {
  if (!wakeLockHeld) return
  wakeLockHeld = false
  if (isTermux() && commandWorks('termux-wake-unlock')) {
    runLockCommand('termux-wake-unlock')
  }
}

/** Whether a wakelock is currently held — drives the background hint. */
export function isWakeLockHeld(): boolean {
  return wakeLockHeld
}
