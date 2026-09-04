import fs from 'node:fs/promises'
import {
  audioChoice,
  audioFallbackChoice,
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
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
} from './constants.js'

export type QueueItem = {url: string; playlistIndex?: number}
export type QueueOutcome = {filepaths: string[]; errors: string[]; cancelled: boolean}
export type Outcome = {filepaths?: string[]; errors?: string[]; cancelled?: boolean}

// DRM-style failures (permanent 403 on the video stream) fall back to
// audio-only once — a fresh extraction cannot fix them (D-DRM)
const AUDIO_FALLBACK_RE = /403|DRM|unable to download video data|protected/i

/** Real timeout-based backoff wait; tests inject a no-op via QueueDeps.sleep. */
function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Expand a playlist url into per-entry queue items, 1-based (D8). */
export function playlistItems(url: string, count: number): QueueItem[] {
  return Array.from({length: count}, (_, i) => ({url, playlistIndex: i + 1}))
}

// DI seam — node:test fakes replace the real spawn-based functions (D9)
export type QueueDeps = {
  probe?: typeof probe
  download?: typeof download
  findFfmpeg?: typeof findFfmpeg
  /** Backoff wait between retries; tests inject a no-op to keep suites fast. */
  sleep?: (ms?: number) => Promise<void>
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
  retries?: number
  fragmentRetries?: number
  retrySleep?: string
  socketTimeout?: number
  downloadArchive?: string
  breakOnExisting?: boolean
  /** Base wait (ms) before each fresh-extraction retry, doubled per attempt (aria2 retry-wait). */
  retryBackoffMs?: number
  /** Max fresh-extraction retries after the first download attempt fails. */
  maxRetryAttempts?: number
  // TTY defers to the picker (async promise resolved on select), scriptable
  // resolves immediately; 'cancel' aborts the queue. 'playlist' is now a real
  // DownloadChoice (flagged playlist:true) returned by playlistOptions.
  choiceFor: (
    info: VideoInfo,
  ) => DownloadChoice | 'pick' | 'cancel' | Promise<DownloadChoice | 'pick' | 'cancel'>
  signal?: AbortSignal
  onItem?: (index: number) => void // per-item hook for UI state (url, "video i/N")
  onRetry?: () => void // fired before the fresh-extraction retry
  onAudioFallback?: () => void // fired before the audio-only fallback download (video stream DRM-blocked)
  onProgress?: (progress: DownloadProgress) => void
  onProcessing?: () => void
  /** Per-entry playlist counter: fired at the start of each download of a
   * known-count playlist (i of N, 1-based). Unknown-count runs never fire it. */
  onPlaylistEntry?: (current: number, total: number) => void
  onStatus?: (message: string) => void
}

export type ItemResult = {filepaths: string[]; errors: string[]; cancelled: boolean}

/** Per-item callbacks threaded through runItem (D2): drivers bind their own
 * progress/processing/retry handlers — runQueue from opts, parallelQueue per
 * itemId. */
export type ItemHooks = {
  onRetry?: () => void // fired before the fresh-extraction retry
  onAudioFallback?: () => void // fired before the audio-only fallback download (video stream DRM-blocked)
  onProgress?: (progress: DownloadProgress) => void
  onProcessing?: () => void
  /** Per-entry playlist counter (i of N, 1-based); never fired for unknown-count runs. */
  onPlaylistEntry?: (current: number, total: number) => void
}

/**
 * Shared per-item pipeline (D2): probe → choiceFor → playlist-expand →
 * per-entry download → fresh-extraction retry, with per-entry isolation.
 * `signal` is the abort source for THIS item — runQueue passes opts.signal,
 * parallelQueue passes the item's controller.signal. Drivers interpret the
 * result: runQueue maps an item cancel to `cancelled=true, break`
 * (byte-identical legacy behavior); parallelQueue maps it to an item-only
 * cancel. Downloads always re-extract — never reuse the probe's cached info.
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
  try {
    const result = await doProbe(opts.ytdlp, item.url, signal, opts.cookies, opts.noUpdate, {
      retries: opts.retries,
      fragmentRetries: opts.fragmentRetries,
      retrySleep: opts.retrySleep,
      socketTimeout: opts.socketTimeout,
      downloadArchive: opts.downloadArchive,
      breakOnExisting: opts.breakOnExisting,
    })
    info = result.info
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
  if (choice.playlist) {
    // Playlist expansion (REQ-018): iterate every entry with a fresh
    // extraction per entry. The option may carry its own format args (standard
    // 360p) or be empty (max quality — falls back to bestChoice per entry).
    if (!isPlaylistInfo(info)) {
      errors.push(`“${item.url}”: no se pudo detectar una playlist`)
      return {filepaths, errors, cancelled}
    }
    const count = info.playlist_count
    if (typeof count === 'number' && count === 0) {
      errors.push(`“${item.url}”: la playlist no tiene videos`)
      return {filepaths, errors, cancelled}
    }
    const entryChoice = choice.args.length > 0 ? choice : bestChoice(info)
    const entryBase = {
      ytdlp: opts.ytdlp,
      choice: entryChoice,
      outDir: opts.outDir,
      ffmpeg: opts.ffmpeg,
      resume: opts.resume,
      cookies: opts.cookies,
      embedMetadata: opts.embedMetadata,
      subs: opts.subs,
      noUpdate: opts.noUpdate,
      retries: opts.retries,
      fragmentRetries: opts.fragmentRetries,
      retrySleep: opts.retrySleep,
      socketTimeout: opts.socketTimeout,
      downloadArchive: opts.downloadArchive,
      breakOnExisting: opts.breakOnExisting,
    }
    if (typeof count === 'number' && count > 0) {
      for (let i = 1; i <= count; i++) {
        // per-entry playlist counter — the UI shows "i/N" while this entry runs
        hooks.onPlaylistEntry?.(i, count)
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
    retries: opts.retries,
    fragmentRetries: opts.fragmentRetries,
    retrySleep: opts.retrySleep,
    socketTimeout: opts.socketTimeout,
    downloadArchive: opts.downloadArchive,
    breakOnExisting: opts.breakOnExisting,
  }
  try {
    // always re-extract — probe's infoJsonPath URLs expire before download starts
    filepaths.push(
      await doDownload(
        {...base, url: item.url, ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {})},
        handlers,
        signal,
      ),
    )
  } catch (error) {
    if (signal?.aborted) {
      cancelled = true
      return {filepaths, errors, cancelled}
    }
    // transient network/server error — retry with a fresh extraction and
    // exponential backoff (aria2 retry-wait pattern, P0): yt-dlp's own burst
    // retries give up within seconds on a real cut, so a brief outage gets a
    // real wait (1s * 2^attempt) before re-extracting so it can recover
    const baseWait = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    const maxAttempts = opts.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS
    const doSleep = deps.sleep ?? sleepMs
    let lastError: unknown = error
    let drmMessage: string | undefined
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        cancelled = true
        return {filepaths, errors, cancelled}
      }
      hooks.onRetry?.()
      // exponential backoff BEFORE this fresh extraction — let a short cut recover
      await doSleep(baseWait * 2 ** attempt)
      if (signal?.aborted) {
        cancelled = true
        return {filepaths, errors, cancelled}
      }
      try {
        filepaths.push(
          await doDownload(
            {...base, url: item.url, ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {})},
            handlers,
            signal,
          ),
        )
        return {filepaths, errors, cancelled}
      } catch (retryError) {
        if (signal?.aborted) {
          cancelled = true
          return {filepaths, errors, cancelled}
        }
        const message = retryError instanceof Error ? retryError.message : String(retryError)
        if (choice.kind === 'video' && AUDIO_FALLBACK_RE.test(message)) {
          // DRM is permanent — a fresh extraction cannot fix it, so stop
          // retrying and fall back to audio-only (D-DRM)
          drmMessage = message
          break
        }
        lastError = retryError
      }
    }
    if (drmMessage !== undefined) {
      hooks.onAudioFallback?.()
      try {
        filepaths.push(
          await doDownload(
            {
              ...base,
              url: item.url,
              choice: audioFallbackChoice(info, opts.ffmpeg),
              ...(item.playlistIndex ? {playlistIndex: item.playlistIndex} : {}),
            },
            handlers,
            signal,
          ),
        )
      } catch (error3) {
        if (signal?.aborted) {
          cancelled = true
          return {filepaths, errors, cancelled}
        }
        errors.push(error3 instanceof Error ? error3.message : String(error3))
      }
      return {filepaths, errors, cancelled}
    }
    errors.push(lastError instanceof Error ? lastError.message : String(lastError))
  }
  return {filepaths, errors, cancelled}
}

/**
 * Sequential download driver shared by the TTY app, batch and scriptable
 * paths (D9). Probes each item, asks the caller for a choice, downloads with
 * a fresh extraction each time. Each item runs through the shared runItem
 * pipeline (D2); an item cancel aborts the whole queue.
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
    onAudioFallback: opts.onAudioFallback,
    onProgress: opts.onProgress,
    onProcessing: opts.onProcessing,
    onPlaylistEntry: opts.onPlaylistEntry,
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
  | 'audio-fallback'
  | 'done'
  | 'error'
  | 'cancelled'

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
  retries?: number
  fragmentRetries?: number
  retrySleep?: string
  socketTimeout?: number
  downloadArchive?: string
  breakOnExisting?: boolean
  /** Base wait (ms) before each fresh-extraction retry, doubled per attempt (aria2 retry-wait). */
  retryBackoffMs?: number
  /** Max fresh-extraction retries after the first download attempt fails. */
  maxRetryAttempts?: number
  /** Max concurrent tasks, default 3 (REQ-par-002, D-P1). */
  cap?: number
  /** 'cancel' cancels only this item — siblings' signals stay untouched (REQ-par-003). 'playlist' is a real DownloadChoice (flagged playlist:true). */
  choiceFor: (
    info: VideoInfo,
  ) => DownloadChoice | 'cancel' | Promise<DownloadChoice | 'cancel'>
  onItemState: (itemId: string, status: ItemStateStatus) => void
  onTitle: (itemId: string, title: string) => void
  onProgress: (itemId: string, progress: DownloadProgress) => void
  /** Per-entry playlist counter for an item (i of N, 1-based); unknown-count
   * playlist runs never fire it. */
  onPlaylistEntry?: (itemId: string, current: number, total: number) => void
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
  /** Number of items whose picker is open — the onAllDone deferral guard (REQ-par-017). */
  pendingPicks: () => number
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
  // open pickers — onAllDone defers while > 0 (REQ-par-017, D10)
  let pendingPicks = 0
  // one-shot guard — fires onAllDone at most once per queue instance (REQ-par-004)
  let drained = false

  const baseRunOpts: Omit<QueueRunOptions, 'choiceFor'> = {
    ytdlp: opts.ytdlp,
    outDir: opts.outDir,
    ffmpeg: opts.ffmpeg,
    resume: opts.resume,
    cookies: opts.cookies,
    embedMetadata: opts.embedMetadata,
    subs: opts.subs,
    noUpdate: opts.noUpdate,
    retries: opts.retries,
    fragmentRetries: opts.fragmentRetries,
    retrySleep: opts.retrySleep,
    socketTimeout: opts.socketTimeout,
    downloadArchive: opts.downloadArchive,
    breakOnExisting: opts.breakOnExisting,
    retryBackoffMs: opts.retryBackoffMs,
    maxRetryAttempts: opts.maxRetryAttempts,
  }

  function itemHooks(itemId: string): ItemHooks {
    return {
      onRetry: () => opts.onItemState(itemId, 'refreshing'),
      onAudioFallback: () => opts.onItemState(itemId, 'audio-fallback'),
      onProgress: progress => opts.onProgress(itemId, progress),
      onProcessing: () => opts.onItemState(itemId, 'processing'),
      onPlaylistEntry: (current, total) => opts.onPlaylistEntry?.(itemId, current, total),
    }
  }

  function runTask(entry: ParallelQueueEntry): void {
    active.add(entry.itemId)
    opts.onItemState(entry.itemId, 'probing')
    const runOpts: QueueRunOptions = {
      ...baseRunOpts,
      choiceFor: async info => {
        opts.onItemState(entry.itemId, 'picking')
        opts.onTitle(entry.itemId, info.title)
        // the picker is open — onAllDone must wait for this item (REQ-par-017)
        pendingPicks++
        try {
          const result = await opts.choiceFor(info)
          if (result !== 'cancel') opts.onItemState(entry.itemId, 'downloading')
          return result
        } finally {
          pendingPicks--
        }
      },
    }
    void (async () => {
      try {
        const result = await runItem(entry.item, runOpts, entry.controller.signal, itemHooks(entry.itemId), opts.deps)
        outcome.filepaths.push(...result.filepaths)
        outcome.errors.push(...result.errors)
        // a cancelled item (picker-ESC or abort) must NOT render as a successful
        // 'done' ✓ — it produced nothing — nor as an 'error' ✗: it renders as a
        // distinct terminal 'cancelled'. Only a clean download is 'done'.
        const status: ItemStateStatus = result.cancelled
          ? 'cancelled'
          : result.errors.length > 0
            ? 'error'
            : 'done'
        opts.onItemState(entry.itemId, status)
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
    checkDrained()
  }

  // onAllDone fires exactly once when nothing runs and no picker is open —
  // active===0 implies the FIFO queue is empty because pump() fills every free
  // slot, so the queue needs no separate check (REQ-par-004/014, D10)
  function checkDrained(): void {
    if (drained) return
    if (active.size === 0 && pendingPicks === 0) {
      drained = true
      opts.onAllDone(currentOutcome())
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

  function pendingPicksCount(): number {
    return pendingPicks
  }

  return {start, cancelAll, currentOutcome, hasActive, pendingPicks: pendingPicksCount}
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
  retries?: number
  fragmentRetries?: number
  retrySleep?: string
  socketTimeout?: number
  downloadArchive?: string
  breakOnExisting?: boolean
  retryBackoffMs?: number
  maxRetryAttempts?: number
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
      retries: opts.retries,
      fragmentRetries: opts.fragmentRetries,
      retrySleep: opts.retrySleep,
      socketTimeout: opts.socketTimeout,
      downloadArchive: opts.downloadArchive,
      breakOnExisting: opts.breakOnExisting,
      retryBackoffMs: opts.retryBackoffMs,
      maxRetryAttempts: opts.maxRetryAttempts,
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
