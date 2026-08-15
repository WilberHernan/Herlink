import fs from 'node:fs/promises'
import {
  audioChoice,
  bestChoice,
  download,
  findFfmpeg,
  isPlaylistInfo,
  probe,
  type DownloadArgs,
  type DownloadChoice,
  type DownloadHandlers,
  type DownloadProgress,
  type FfmpegStatus,
  type ProbeResult,
  type VideoInfo,
} from './ytdlp.js'

export type QueueItem = {url: string; playlistIndex?: number}
export type QueueOutcome = {filepaths: string[]; errors: string[]; cancelled: boolean}
export type Outcome = {filepaths?: string[]; errors?: string[]; cancelled?: boolean}

/** Expand a playlist url into per-entry queue items, 1-based (D8). */
export function playlistItems(url: string, count: number): QueueItem[] {
  return Array.from({length: count}, (_, i) => ({url, playlistIndex: i + 1}))
}

// DI seam — node:test fakes replace the real spawn-based functions (D9)
export type QueueDeps = {
  probe?: typeof probe
  download?: typeof download
  findFfmpeg?: typeof findFfmpeg
}

export type QueueRunOptions = {
  ytdlp: string
  outDir: string
  ffmpeg: FfmpegStatus
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
  /** --no-update into probe/download argv: suppress yt-dlp's stale warning (REQ-022). */
  noUpdate?: boolean
  // TTY defers to the picker (async promise resolved on select), scriptable
  // resolves immediately; 'playlist' takes the "descargar los N videos"
  // choice (REQ-018) and 'cancel' aborts the queue
  choiceFor: (
    info: VideoInfo,
  ) =>
    | DownloadChoice
    | 'playlist'
    | 'pick'
    | 'cancel'
    | Promise<DownloadChoice | 'playlist' | 'pick' | 'cancel'>
  signal?: AbortSignal
  onItem?: (index: number) => void // per-item hook for UI state (url, "video i/N")
  onRetry?: () => void // fired before the fresh-extraction retry
  onProgress?: (progress: DownloadProgress) => void
  onProcessing?: () => void
  onStatus?: (message: string) => void
}

/**
 * Sequential download driver shared by the TTY app, batch and scriptable
 * paths (D9). Probes each item, asks the caller for a choice, downloads with
 * the probe's cached info and retries with a fresh extraction when that
 * expires (mirrors the previous app.tsx behavior).
 */
export async function runQueue(
  items: QueueItem[],
  opts: QueueRunOptions,
  deps: QueueDeps = {},
): Promise<QueueOutcome> {
  const doProbe = deps.probe ?? probe
  const doDownload = deps.download ?? download
  const filepaths: string[] = []
  const errors: string[] = []
  let cancelled = false

  for (const [index, item] of items.entries()) {
    if (opts.signal?.aborted) {
      cancelled = true
      break
    }
    opts.onItem?.(index)
    let info: VideoInfo
    let infoJsonPath: string | undefined
    try {
      const result = await doProbe(opts.ytdlp, item.url, opts.signal, opts.cookies, opts.noUpdate)
      info = result.info
      infoJsonPath = result.infoJsonPath
    } catch (error) {
      if (opts.signal?.aborted) {
        cancelled = true
        break
      }
      errors.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (opts.signal?.aborted) {
      cancelled = true
      break
    }
    const choice = await opts.choiceFor(info)
    if (choice === 'cancel' || opts.signal?.aborted) {
      cancelled = true
      break
    }
    if (choice === 'pick') {
      // TTY-deferred — the app resolves the pick before calling runQueue (T5)
      errors.push(`“${item.url}”: el selector interactivo no está disponible en este modo`)
      continue
    }
    const handlers: DownloadHandlers = {
      onProgress: opts.onProgress ?? (() => {}),
      onProcessing: opts.onProcessing ?? (() => {}),
    }
    if (choice === 'playlist') {
      // "descargar los N videos" (REQ-018): iterate every entry with a fresh
      // extraction per entry — the probe's infoJsonPath is never reused for
      // playlist items (REQ-019). The option carries no format choice, so
      // entries download with the best available format (like --best).
      if (!isPlaylistInfo(info)) {
        errors.push(`“${item.url}”: no se pudo detectar una playlist`)
        continue
      }
      const count = info.playlist_count
      if (typeof count === 'number' && count === 0) {
        errors.push(`“${item.url}”: la playlist no tiene videos`)
        continue
      }
      const entryBase = {
        ytdlp: opts.ytdlp,
        choice: bestChoice(info),
        outDir: opts.outDir,
        ffmpeg: opts.ffmpeg,
        resume: opts.resume,
        cookies: opts.cookies,
        embedMetadata: opts.embedMetadata,
        subs: opts.subs,
        noUpdate: opts.noUpdate,
      }
      if (typeof count === 'number' && count > 0) {
        for (let i = 1; i <= count; i++) {
          if (opts.signal?.aborted) {
            cancelled = true
            break
          }
          try {
            filepaths.push(
              await doDownload({...entryBase, url: item.url, playlist: true, playlistIndex: i}, handlers, opts.signal),
            )
          } catch (error) {
            if (opts.signal?.aborted) {
              cancelled = true
              break
            }
            // per-entry error isolation — remaining entries continue (REQ-019)
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
      } else {
        // D13: playlist_count unknown — single yt-dlp run, no per-entry isolation
        try {
          filepaths.push(await doDownload({...entryBase, url: item.url, playlist: true}, handlers, opts.signal))
        } catch (error) {
          if (opts.signal?.aborted) {
            cancelled = true
            break
          }
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      continue
    }
    const base = {
      ytdlp: opts.ytdlp,
      choice,
      outDir: opts.outDir,
      ffmpeg: opts.ffmpeg,
      resume: opts.resume,
      cookies: opts.cookies,
      embedMetadata: opts.embedMetadata,
      subs: opts.subs,
      noUpdate: opts.noUpdate,
    }
    try {
      // playlist items (playlistIndex) always re-extract — never reuse the
      // probe's infoJsonPath (REQ-019)
      filepaths.push(
        await doDownload(
          {...base, url: item.url, ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {infoJsonPath})},
          handlers,
          opts.signal,
        ),
      )
    } catch (error) {
      if (opts.signal?.aborted) {
        cancelled = true
        break
      }
      // media urls in the cached info can expire — retry with a fresh extraction
      opts.onRetry?.()
      try {
        filepaths.push(
          await doDownload(
            {...base, url: item.url, ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {})},
            handlers,
            opts.signal,
          ),
        )
      } catch (error2) {
        if (opts.signal?.aborted) {
          cancelled = true
          break
        }
        errors.push(error2 instanceof Error ? error2.message : String(error2))
      }
    }
  }

  return {filepaths, errors, cancelled}
}

export type ScriptableOptions = {
  outDir: string
  scriptable: 'best' | 'mp3'
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
  /** --no-update into probe/download argv (REQ-022). */
  noUpdate?: boolean
  signal?: AbortSignal
}

/**
 * Non-TTY scriptable path (D10): creates/checks the outDir (REQ-004, no
 * silent fallback), synthesizes the fixed choice and prints results on plain
 * stdout — never renders Ink.
 */
export async function runScriptable(
  ytdlp: string,
  items: QueueItem[],
  opts: ScriptableOptions,
  deps: QueueDeps = {},
): Promise<QueueOutcome> {
  await fs.mkdir(opts.outDir, {recursive: true})
  await fs.access(opts.outDir, fs.constants.W_OK)
  const doFindFfmpeg = deps.findFfmpeg ?? findFfmpeg
  const ffmpeg = await doFindFfmpeg()
  const outcome = await runQueue(
    items,
    {
      ytdlp,
      outDir: opts.outDir,
      ffmpeg,
      resume: opts.resume,
      cookies: opts.cookies,
      embedMetadata: opts.embedMetadata,
      subs: opts.subs,
      noUpdate: opts.noUpdate,
      signal: opts.signal,
      choiceFor: info => (opts.scriptable === 'mp3' ? audioChoice(info) : bestChoice(info)),
      onStatus: message => process.stderr.write(message + '\n'),
    },
    deps,
  )
  for (const filepath of outcome.filepaths) console.log(filepath)
  for (const error of outcome.errors) console.error(`herlink: ${error}`)
  return outcome
}
