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

export type ItemResult = {filepaths: string[]; errors: string[]; cancelled: boolean}

/** Per-item callbacks threaded through runItem (D2): drivers bind their own
 * progress/processing/retry handlers — runQueue from opts, parallelQueue per
 * itemId. */
export type ItemHooks = {
  onRetry?: () => void // fired before the fresh-extraction retry
  onProgress?: (progress: DownloadProgress) => void
  onProcessing?: () => void
}

/**
 * Shared per-item pipeline (D2): probe → choiceFor → playlist-expand →
 * per-entry download → fresh-extraction retry, with per-entry isolation.
 * `signal` is the abort source for THIS item — runQueue passes opts.signal,
 * parallelQueue passes the item's controller.signal. Drivers interpret the
 * result: runQueue maps an item cancel to `cancelled=true, break`
 * (byte-identical legacy behavior); parallelQueue maps it to an item-only
 * cancel. playlistIndex items always re-extract — the probe's infoJsonPath is
 * never reused for playlist entries (REQ-019).
 */
export async function runItem(
  item: QueueItem,
  opts: QueueRunOptions,
  signal: AbortSignal | undefined,
  hooks: ItemHooks,
  deps: QueueDeps = {},
): Promise<ItemResult> {
  const doProbe = deps.probe ?? probe
  const doDownload = deps.download ?? download
  const filepaths: string[] = []
  const errors: string[] = []
  let cancelled = false

  if (signal?.aborted) {
    cancelled = true
    return {filepaths, errors, cancelled}
  }
  let info: VideoInfo
  let infoJsonPath: string | undefined
  try {
    const result = await doProbe(opts.ytdlp, item.url, signal, opts.cookies, opts.noUpdate)
    info = result.info
    infoJsonPath = result.infoJsonPath
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true
      return {filepaths, errors, cancelled}
    }
    errors.push(error instanceof Error ? error.message : String(error))
    return {filepaths, errors, cancelled}
  }
  if (signal?.aborted) {
    cancelled = true
    return {filepaths, errors, cancelled}
  }
  const choice = await opts.choiceFor(info)
  if (choice === 'cancel' || signal?.aborted) {
    cancelled = true
    return {filepaths, errors, cancelled}
  }
  if (choice === 'pick') {
    // TTY-deferred — the app resolves the pick before calling runQueue (T5)
    errors.push(`“${item.url}”: el selector interactivo no está disponible en este modo`)
    return {filepaths, errors, cancelled}
  }
  const handlers: DownloadHandlers = {
    onProgress: hooks.onProgress ?? (() => {}),
    onProcessing: hooks.onProcessing ?? (() => {}),
  }
  if (choice === 'playlist') {
    // "descargar los N videos" (REQ-018): iterate every entry with a fresh
    // extraction per entry — the probe's infoJsonPath is never reused for
    // playlist items (REQ-019). The option carries no format choice, so
    // entries download with the best available format (like --best).
    if (!isPlaylistInfo(info)) {
      errors.push(`“${item.url}”: no se pudo detectar una playlist`)
      return {filepaths, errors, cancelled}
    }
    const count = info.playlist_count
    if (typeof count === 'number' && count === 0) {
      errors.push(`“${item.url}”: la playlist no tiene videos`)
      return {filepaths, errors, cancelled}
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
        if (signal?.aborted) {
          cancelled = true
          break
        }
        try {
          filepaths.push(
            await doDownload({...entryBase, url: item.url, playlist: true, playlistIndex: i}, handlers, signal),
          )
        } catch (error) {
          if (signal?.aborted) {
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
        filepaths.push(await doDownload({...entryBase, url: item.url, playlist: true}, handlers, signal))
      } catch (error) {
        if (signal?.aborted) {
          cancelled = true
          return {filepaths, errors, cancelled}
        }
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return {filepaths, errors, cancelled}
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
        signal,
      ),
    )
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true
      return {filepaths, errors, cancelled}
    }
    // media urls in the cached info can expire — retry with a fresh extraction
    hooks.onRetry?.()
    try {
      filepaths.push(
        await doDownload(
          {...base, url: item.url, ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {})},
          handlers,
          signal,
        ),
      )
    } catch (error2) {
      if (signal?.aborted) {
        cancelled = true
        return {filepaths, errors, cancelled}
      }
      errors.push(error2 instanceof Error ? error2.message : String(error2))
    }
  }
  return {filepaths, errors, cancelled}
}

/**
 * Sequential download driver shared by the TTY app, batch and scriptable
 * paths (D9). Probes each item, asks the caller for a choice, downloads with
 * the probe's cached info and retries with a fresh extraction when that
 * expires (mirrors the previous app.tsx behavior). Each item runs through the
 * shared runItem pipeline (D2); an item cancel aborts the whole queue.
 */
export async function runQueue(
  items: QueueItem[],
  opts: QueueRunOptions,
  deps: QueueDeps = {},
): Promise<QueueOutcome> {
  const filepaths: string[] = []
  const errors: string[] = []
  let cancelled = false

  const hooks: ItemHooks = {
    onRetry: opts.onRetry,
    onProgress: opts.onProgress,
    onProcessing: opts.onProcessing,
  }

  for (const [index, item] of items.entries()) {
    if (opts.signal?.aborted) {
      cancelled = true
      break
    }
    opts.onItem?.(index)
    const result = await runItem(item, opts, opts.signal, hooks, deps)
    filepaths.push(...result.filepaths)
    errors.push(...result.errors)
    if (result.cancelled) {
      cancelled = true
      break
    }
  }

  return {filepaths, errors, cancelled}
}

// ── parallelQueue driver (D1/D3/D11) ────────────────────────────────────────

export type ItemStateStatus =
  | 'probing'
  | 'queued'
  | 'picking'
  | 'downloading'
  | 'processing'
  | 'refreshing'
  | 'done'
  | 'error'

export type DoneInfo = {filepaths: string[]; errors: string[]; cancelled: boolean; aborted?: boolean}

export type ParallelQueueOptions = {
  ytdlp: string
  outDir: string
  ffmpeg: FfmpegStatus
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
  noUpdate?: boolean
  /** Max concurrent tasks, default 3 (REQ-par-002, D-P1). */
  cap?: number
  /** 'cancel' cancels only this item — siblings' signals stay untouched (REQ-par-003). */
  choiceFor: (
    info: VideoInfo,
  ) => DownloadChoice | 'playlist' | 'cancel' | Promise<DownloadChoice | 'playlist' | 'cancel'>
  onItemState: (itemId: string, status: ItemStateStatus) => void
  onProgress: (itemId: string, progress: DownloadProgress) => void
  /** Fires once when the pool drains — aggregation lands with T3b (REQ-par-004). */
  onAllDone: (done: DoneInfo) => void
  deps?: QueueDeps
}

export type ParallelQueue = {
  /** Enqueue an item; returns its itemId. Never awaits the pool (REQ-par-001). */
  start: (item: QueueItem) => string
  /** Abort every running item; queued items never start; outcome marked cancelled (REQ-par-010/011). */
  cancelAll: () => void
  /** Partial aggregation of settled items, for early-exit reporting (REQ-par-019). */
  currentOutcome: () => DoneInfo
  /** True while any item is running or queued. */
  hasActive: () => boolean
}

type ParallelQueueEntry = {item: QueueItem; itemId: string; controller: AbortController}

/**
 * Stateful closure factory (D1, D9 pattern — DI'd like runQueue): owns a FIFO
 * pool capped at `cap` (default 3) concurrent tasks with one AbortController
 * per item. pump() starts the queue head whenever a slot frees (REQ-par-002);
 * cancelAll() aborts every running controller and drops queued items so they
 * never start (REQ-par-010). Each task runs the shared runItem pipeline with
 * the item's own signal (D2) — a per-item abort or failure never touches a
 * sibling's signal (REQ-par-003). All state is closure-local: a parallel run
 * leaves nothing behind for a later runQueue run (REQ-par-022 s2).
 */
export function createParallelQueue(opts: ParallelQueueOptions): ParallelQueue {
  const cap = opts.cap ?? 3
  const active = new Set<string>()
  const queue: ParallelQueueEntry[] = []
  // every live item (queued or running) so cancelAll can abort all of them
  const controllers = new Map<string, AbortController>()
  const outcome: DoneInfo = {filepaths: [], errors: [], cancelled: false, aborted: false}
  let nextId = 0

  const baseRunOpts: Omit<QueueRunOptions, 'choiceFor'> = {
    ytdlp: opts.ytdlp,
    outDir: opts.outDir,
    ffmpeg: opts.ffmpeg,
    resume: opts.resume,
    cookies: opts.cookies,
    embedMetadata: opts.embedMetadata,
    subs: opts.subs,
    noUpdate: opts.noUpdate,
  }

  function itemHooks(itemId: string): ItemHooks {
    return {
      onRetry: () => opts.onItemState(itemId, 'refreshing'),
      onProgress: progress => opts.onProgress(itemId, progress),
      onProcessing: () => opts.onItemState(itemId, 'processing'),
    }
  }

  function runTask(entry: ParallelQueueEntry): void {
    active.add(entry.itemId)
    opts.onItemState(entry.itemId, 'probing')
    const runOpts: QueueRunOptions = {
      ...baseRunOpts,
      choiceFor: async info => {
        opts.onItemState(entry.itemId, 'picking')
        const result = await opts.choiceFor(info)
        if (result !== 'cancel') opts.onItemState(entry.itemId, 'downloading')
        return result
      },
    }
    void (async () => {
      try {
        const result = await runItem(entry.item, runOpts, entry.controller.signal, itemHooks(entry.itemId), opts.deps)
        outcome.filepaths.push(...result.filepaths)
        outcome.errors.push(...result.errors)
        opts.onItemState(entry.itemId, result.errors.length > 0 ? 'error' : 'done')
      } catch (error) {
        // runItem catches its own failures; this guards a rejecting choiceFor
        outcome.errors.push(error instanceof Error ? error.message : String(error))
        opts.onItemState(entry.itemId, 'error')
      } finally {
        active.delete(entry.itemId)
        controllers.delete(entry.itemId)
        pump()
      }
    })()
  }

  // start the queue head while slots are free — the slot-freeing trigger after
  // every task settle (D3)
  function pump(): void {
    while (active.size < cap && queue.length > 0) {
      runTask(queue.shift()!)
    }
  }

  function start(item: QueueItem): string {
    const itemId = `item-${nextId++}`
    const controller = new AbortController()
    queue.push({item, itemId, controller})
    controllers.set(itemId, controller)
    opts.onItemState(itemId, 'queued')
    pump()
    return itemId
  }

  function cancelAll(): void {
    if (outcome.cancelled) return
    outcome.cancelled = true
    outcome.aborted = true
    // queued items never start (REQ-par-010); aborting their controllers too
    // guarantees nothing can begin after this point
    queue.splice(0)
    for (const controller of controllers.values()) controller.abort()
  }

  // partial aggregation for early exit — copies so callers can't corrupt the
  // driver's own state (REQ-par-019)
  function currentOutcome(): DoneInfo {
    return {...outcome, filepaths: [...outcome.filepaths], errors: [...outcome.errors]}
  }

  function hasActive(): boolean {
    return active.size > 0 || queue.length > 0
  }

  return {start, cancelAll, currentOutcome, hasActive}
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
