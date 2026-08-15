import fs from 'node:fs/promises'
import {
  audioChoice,
  bestChoice,
  download,
  findFfmpeg,
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
  // TTY defers to the picker ('pick'), scriptable resolves immediately
  choiceFor: (info: VideoInfo) => DownloadChoice | 'pick' | 'cancel'
  signal?: AbortSignal
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

  for (const item of items) {
    if (opts.signal?.aborted) {
      cancelled = true
      break
    }
    const {info, infoJsonPath} = await doProbe(opts.ytdlp, item.url, opts.signal, opts.cookies)
    if (opts.signal?.aborted) {
      cancelled = true
      break
    }
    const choice = opts.choiceFor(info)
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
    const base = {
      ytdlp: opts.ytdlp,
      choice,
      outDir: opts.outDir,
      ffmpeg: opts.ffmpeg,
      resume: opts.resume,
      cookies: opts.cookies,
      embedMetadata: opts.embedMetadata,
      subs: opts.subs,
    }
    try {
      filepaths.push(await doDownload({...base, url: item.url, infoJsonPath}, handlers, opts.signal))
    } catch (error) {
      if (opts.signal?.aborted) {
        cancelled = true
        break
      }
      // media urls in the cached info can expire — retry with a fresh extraction
      try {
        filepaths.push(await doDownload({...base, url: item.url}, handlers, opts.signal))
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
