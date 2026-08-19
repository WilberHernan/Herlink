import React, {useCallback, useEffect, useRef, useState} from 'react'
import os from 'node:os'
import path from 'node:path'
import {Box, Text, useApp, useInput, useStdout} from 'ink'
import SelectInput, {type ItemProps} from 'ink-select-input'
import Spinner from 'ink-spinner'
import {FullScreen} from './components/fullscreen.js'
import {Logo, ROSE_ROWS} from './components/logo.js'
import {Panel} from './components/panel.js'
import {ProgressBar} from './components/progress-bar.js'
import {Shortcuts} from './components/shortcuts.js'
import {TextInput} from './components/text-input.js'
import {UnderlineInput, underlineButtonWidth} from './components/underline-input.js'
import {clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './lib/click-map.js'
import {formatBytes, formatDuration, formatSpeed, shortenPath, truncate, wrapText} from './lib/format.js'
import {addToHistory, loadHistory} from './lib/history.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {isTermux, resolveOutDir} from './lib/termux.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type ThemeMode, useTheme} from './theme.js'
import {createParallelQueue, type DoneInfo, type ItemStateStatus, type Outcome} from './lib/queue.js'
export type {Outcome} from './lib/queue.js'
import {
  buildChoices,
  effectiveNoUpdate,
  ensureYtDlp,
  findFfmpeg,
  isBundledBinary,
  maybeSelfUpdate,
  playlistOption,
  type DownloadChoice,
  type DownloadProgress,
  type FfmpegStatus,
  type VideoInfo,
} from './lib/ytdlp.js'

const ACTION_LABEL = 'bajar'

// SelectInput sentinel for the "descargar los N videos" option (REQ-018) —
// real choices are indexes into choices[], so -1 can never collide
const PLAYLIST_CHOICE_VALUE = -1

const choiceLabel = (choice: DownloadChoice) => `${choice.kind === 'audio' ? '♪ ' : '▶ '}${choice.label}`

function ChoiceIndicator() {
  return (
    <Box marginRight={1}>
      <Text> </Text>
    </Box>
  )
}

function ChoiceItem({isSelected, label}: ItemProps) {
  const theme = useTheme()
  return (
    <Text
      bold={isSelected}
      color={isSelected ? theme.text : theme.muted}
      backgroundColor={isSelected ? theme.selection : undefined}
    >
      {label}
    </Text>
  )
}

// explicit blank lines — empty <Box height={1}/> spacers can collapse, and
// ink boxes default to flexShrink=1, so spacers are the first thing yoga
// crushes when content overflows the terminal
const Gap = ({lines = 1}: {lines?: number}) => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({length: lines}, (_, i) => (
      <Text key={i}> </Text>
    ))}
  </Box>
)

// fixed-width slots — the centered line must not change width as values tick,
// otherwise the whole layout shifts on every progress update
function partLabel(progress: DownloadProgress): string {
  // explains the bar resetting between files (video, then audio)
  return progress.totalParts > 1 ? `parte ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function indeterminateMeta(progress: DownloadProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ·  ${speed.padEnd(10)}`
}

/** -o wins over the ~/Downloads default (D12); the Termux effect is skipped when an override is set. */
export function resolveInitialOutDir(outDirOverride: string | undefined, homeDir: string): string {
  return outDirOverride ?? path.join(homeDir, 'Downloads')
}

// ── T4a: pure helpers shared by the screens rewrite (D5/D9/D10) ─────────────

/** Screen model replacing the phase enum (D4) — 'error' is gone: failures are
 * per-item rows in done (REQ-par-016). */
export type Screen = 'input' | 'picker' | 'downloads' | 'done'

/** One row of the downloads screen, keyed by itemId in insertion order (D5). */
export type ItemState = {
  status: ItemStateStatus
  url: string
  title?: string
  progress?: DownloadProgress
  error?: string
}

/** What the done screen renders — heading, sub line and every failed item's
 * error (REQ-par-015/016, D10). */
export type DoneSummary = {heading: string; sub: string; errors: string[]}

/**
 * Aggregates the finished run into done-screen copy. The four goldens are
 * verbatim from the sequential build (REQ-par-015): 1 file → singular, N →
 * plural; cancelled → ✗ Cancelado with kept-files or none. Every failed item's
 * error is surfaced, never only errors[0] (REQ-par-016).
 */
export function doneSummary(done: DoneInfo): DoneSummary {
  const {filepaths, errors, cancelled} = done
  if (cancelled) {
    return {
      heading: '✗ Cancelado',
      sub: filepaths.length > 0 ? 'Se guardaron los archivos ya descargados:' : 'No se descargó ningún archivo',
      errors: [...errors],
    }
  }
  return {
    heading: filepaths.length > 1 ? `✓ Descargados ${filepaths.length} archivos` : '✓ Descargado',
    sub: filepaths.length > 1 ? 'Están en:' : 'Tu archivo está en:',
    errors: [...errors],
  }
}

// valid status edges fired by the parallel driver (D5, REQ-par-006 s2): the
// picker cancel and abort paths settle with no errors, so probing and picking
// may go straight to done; 'queued' → 'queued' is the idempotent row-creation
// event emitted by start() right after the map entry is created. processing →
// processing covers a multi-entry playlist with per-entry ffmpeg merges;
// refreshing → processing is the fresh-extraction retry landing straight in
// the merge step (queue.ts runItem retry path); refreshing → audio-fallback is
// the DRM-blocked video stream retrying once as audio-only.
const VALID_TRANSITIONS: Record<ItemStateStatus, readonly ItemStateStatus[]> = {
  queued: ['queued', 'probing'],
  probing: ['picking', 'done', 'error'],
  picking: ['downloading', 'done', 'error'],
  downloading: ['processing', 'refreshing', 'done', 'error'],
  processing: ['processing', 'refreshing', 'downloading', 'done', 'error'],
  refreshing: ['downloading', 'processing', 'audio-fallback', 'done', 'error'],
  'audio-fallback': ['processing', 'done', 'error'],
  done: [],
  error: [],
}

// statuses that may receive a progress tick
const PROGRESS_STATUSES: readonly ItemStateStatus[] = ['downloading', 'processing', 'refreshing', 'audio-fallback']

/**
 * Pure reducer for one downloads-screen row (D5). Applies the driver's status
 * events (onItemState) and progress ticks (onProgress) to the item's ItemState,
 * throwing on an impossible transition — a wiring bug in T4b surfaces as a loud
 * error instead of a silently corrupted row.
 */
export function itemStateTransition(
  prev: ItemState,
  event: ItemStateStatus | {type: 'progress'; progress: DownloadProgress},
): ItemState {
  if (typeof event === 'object') {
    if (!PROGRESS_STATUSES.includes(prev.status)) {
      throw new Error(`invalid itemStateTransition: progress event in status ${prev.status}`)
    }
    return {...prev, progress: event.progress}
  }
  if (!VALID_TRANSITIONS[prev.status].includes(event)) {
    throw new Error(`invalid itemStateTransition: ${prev.status} → ${event}`)
  }
  return {...prev, status: event}
}

/**
 * Init-once memoization (D9, REQ-par-021): get() caches the run() promise, so
 * a second submit mid-init awaits the SAME pending promise (one yt-dlp
 * download / self-update per startup). A rejected init clears the cache (next
 * get() retries fresh); reset() forces a fresh run on demand.
 */
export function createCachedInit<T>(run: () => Promise<T>): {get: () => Promise<T>; reset: () => void} {
  let cached: Promise<T> | undefined
  return {
    get: () => {
      if (!cached) {
        const promise = run()
        cached = promise
        // identity guard: an older rejection must not clear a newer promise
        // started after an explicit reset()
        promise.catch(() => {
          if (cached === promise) cached = undefined
        })
      }
      return cached
    },
    reset: () => {
      cached = undefined
    },
  }
}

/**
 * Where the app goes when one picker closes (REQ-par-005): the last open
 * picker returning to the run leaves the picker frame — an empty picker
 * screen would render just the logo and hints with no progress rows.
 */
export function screenAfterPickerClose(remainingPickers: number, current: Screen): Screen {
  return remainingPickers === 0 && current === 'picker' ? 'downloads' : current
}

/**
 * Splits one submit value into the plausible URLs it carries — a single paste
 * may bring several links separated by whitespace (REQ-par-001).
 */
export function splitSubmittedUrls(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter(url => isProbablyUrl(url))
}

/**
 * After a rejected submit (the queue never accepted the links), the input is
 * restored to the submitted value — unless the user already typed something
 * new while the attempt was in flight, which must never be clobbered.
 */
export function restoreAfterRejectedSubmit(current: string, rejectedValue: string): string {
  return current.trim() === '' ? rejectedValue : current
}

/** Short label per item status on the downloads screen (D4, REQ-par-006). */
const STATUS_LABEL: Record<ItemStateStatus, string> = {
  queued: 'en cola',
  probing: 'obteniendo info…',
  picking: 'eligiendo formato…',
  downloading: 'descargando…',
  processing: 'procesando…',
  refreshing: 'reintentando…',
  'audio-fallback': 'bajando solo audio…',
  done: '✓',
  error: '✗',
}

const HINTS: Record<Screen, Array<[string, string]>> = {
  input: [
    ['↵', 'bajar'],
    ['^c', 'salir'],
  ],
  picker: [
    ['↑↓', 'elegir'],
    ['↵', 'bajar'],
    ['esc', 'cancelar'],
    ['^c', 'salir'],
  ],
  downloads: [
    ['↵', 'volver al input'],
    ['esc', 'cancelar'],
    ['^c', 'salir'],
  ],
  done: [
    ['↵', 'volver'],
    ['^c', 'salir'],
  ],
}

// everything the first submit needs before a queue can exist (D9)
type InitContext = {ytdlp: string; ffmpeg: FfmpegStatus; noUpdate: boolean}
type CachedInit<T> = ReturnType<typeof createCachedInit<T>>

type AppProps = {
  initialUrls?: string[]
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  outDirOverride?: string
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
  noUpdate?: boolean
  onOutcome: (outcome: Outcome) => void
}

export function App({initialThemeMode = 'auto', ...props}: AppProps) {
  const [themeMode, setThemeMode] = useState(initialThemeMode)
  const cycleTheme = useCallback(() => {
    setThemeMode(nextThemeMode)
  }, [])

  return (
    <ThemeProvider mode={themeMode}>
      <AppContent {...props} cycleTheme={cycleTheme} />
    </ThemeProvider>
  )
}

function AppContent({
  initialUrls,
  clipboardUrl,
  outDirOverride,
  resume,
  cookies,
  embedMetadata,
  subs,
  noUpdate,
  onOutcome,
  cycleTheme,
}: {
  initialUrls?: string[]
  clipboardUrl?: string
  outDirOverride?: string
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
  noUpdate?: boolean
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const [screen, setScreen] = useState<Screen>(initialUrls?.length ? 'downloads' : 'input')
  // one row per link, keyed by itemId in insertion order (D5)
  const [items, setItems] = useState<Map<string, ItemState>>(new Map())
  const [doneInfo, setDoneInfo] = useState<DoneInfo>()
  const [urlInput, setUrlInput] = useState('')
  // -o override wins; ~/Downloads default, then shared storage on Termux once
  // resolveOutDir lands (effect below is skipped when the override is set)
  const [outDir, setOutDir] = useState(() => resolveInitialOutDir(outDirOverride, os.homedir()))
  const [history, setHistory] = useState(loadHistory)
  // oldest open picker (FIFO); undefined when no item is waiting (REQ-par-005)
  const [pickerItemId, setPickerItemId] = useState<string>()
  const [warning, setWarning] = useState<string>()
  // init progress line on the downloads screen while the first queue spins up
  const [initStatus, setInitStatus] = useState<string>()

  const queueRef = useRef<ReturnType<typeof createParallelQueue> | undefined>(undefined)
  const initRef = useRef<CachedInit<InitContext> | undefined>(undefined)
  // resolves each open picker's choiceFor promise once the user answers; esc
  // resolves with 'cancel' so only that item skips (REQ-par-009)
  const pickersRef = useRef(new Map<string, (choice: DownloadChoice | 'playlist' | 'cancel') => void>())
  const pickInfosRef = useRef(new Map<string, VideoInfo>())
  // itemId whose choiceFor is about to fire — set by the 'picking' event
  const pickForRef = useRef<string | undefined>(undefined)
  // urls whose queue.start() has not yet emitted the row-creating event; the
  // driver emits synchronously inside start(), before the app knows itemId, so
  // the FIFO pairs each emitted row with its url in order
  const pendingUrlsRef = useRef<string[]>([])
  // one startItems may be mid-init; a second submit joins it instead of
  // creating a second queue (Termux resolveOutDir can refire this effect)
  const startingRef = useRef(false)
  const pendingJoinRef = useRef<string[]>([])
  // initialUrls are submitted exactly once; on Termux the async outDir
  // resolution recreates startItems and would otherwise re-enqueue them
  const initialSubmittedRef = useRef(false)
  const highlightRef = useRef(0) // choice under the cursor, for the ↵ hint click
  const submittedRef = useRef<string[]>([])

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))

  // binary + ffmpeg init happens once per process, cached across runs
  const getInit = useCallback((): CachedInit<InitContext> => {
    if (!initRef.current) {
      initRef.current = createCachedInit<InitContext>(async () => {
        const ytdlp = await ensureYtDlp(setInitStatus)
        // herlink manages freshness of the bundled copy: silent -U once per run
        // (D11, REQ-020/021) and --no-update in probe/download args (REQ-022);
        // --no-update opts out; failure never blocks startup
        const bundled = isBundledBinary(ytdlp)
        const noUpdate_ = effectiveNoUpdate(noUpdate ?? false, ytdlp)
        if (!noUpdate && bundled) {
          await maybeSelfUpdate(ytdlp, setInitStatus)
        }
        const ffmpeg = await findFfmpeg()
        setInitStatus(undefined)
        return {ytdlp, ffmpeg, noUpdate: noUpdate_}
      })
    }
    return initRef.current
  }, [noUpdate])

  // appends links to the live queue, or creates the queue on the first submit;
  // resolves true when the queue accepted the urls (false on init failure)
  const startItems = useCallback(
    async (urls: string[]): Promise<boolean> => {
      setWarning(undefined)
      const existing = queueRef.current
      if (existing) {
        // REQ-par-001: back at the input mid-run, more links join the SAME pool
        submittedRef.current.push(...urls)
        enqueue(existing, urls)
        return true
      }
      if (startingRef.current) {
        // second submit while init is pending — join after the first queue exists
        pendingJoinRef.current.push(...urls)
        return true
      }
      startingRef.current = true
      setScreen('downloads')
      try {
        const init = await getInit().get()
        const merged = pendingJoinRef.current.length > 0 ? [...urls, ...pendingJoinRef.current] : urls
        pendingJoinRef.current = []
        submittedRef.current.push(...merged)
        const queue = createParallelQueue({
          ytdlp: init.ytdlp,
          outDir,
          ffmpeg: init.ffmpeg,
          resume,
          cookies,
          embedMetadata,
          subs,
          noUpdate: init.noUpdate,
          onItemState: (itemId, status) => {
            // the 'picking' event precedes the choiceFor callback; stash the
            // itemId so choiceFor knows which row its picker belongs to
            if (status === 'picking') pickForRef.current = itemId
            setItems(prev => {
              const row = prev.get(itemId)
              if (!row) {
                // start() emits the row-creating events synchronously, before
                // the app knows itemId — pair each with its url (FIFO)
                const url = pendingUrlsRef.current.shift()
                if (url === undefined) return prev
                return new Map(prev).set(itemId, {status, url})
              }
              return new Map(prev).set(itemId, itemStateTransition(row, status))
            })
          },
          onProgress: (itemId, progress) =>
            setItems(prev => {
              const row = prev.get(itemId)
              if (!row) return prev
              return new Map(prev).set(itemId, itemStateTransition(row, {type: 'progress', progress}))
            }),
          choiceFor: async info => {
            const itemId = pickForRef.current
            pickForRef.current = undefined
            if (!itemId) return 'cancel'
            pickInfosRef.current.set(itemId, info)
            setScreen('picker')
            return new Promise(resolve => {
              pickersRef.current.set(itemId, resolve)
              setPickerItemId(prev => prev ?? itemId)
            })
          },
          onAllDone: done => {
            queueRef.current = undefined
            // history gains the completed run's links (every submit, including
            // mid-run joins), never a cancelled one
            if (!done.cancelled) for (const itemUrl of submittedRef.current) setHistory(addToHistory(itemUrl))
            onOutcome(done)
            setDoneInfo(done)
            setScreen('done')
          },
        })
        queueRef.current = queue
        enqueue(queue, merged)
        return true
      } catch (error) {
        pendingJoinRef.current = []
        setWarning(error instanceof Error ? error.message : String(error))
        setScreen('input')
        return false
      } finally {
        startingRef.current = false
      }
    },
    [outDir, resume, cookies, embedMetadata, subs, getInit, onOutcome],
  )

  // one url per queue.start(); the driver's synchronous events create the rows
  const enqueue = (queue: ReturnType<typeof createParallelQueue>, urls: string[]) => {
    for (const url of urls) {
      pendingUrlsRef.current.push(url)
      queue.start({url})
    }
  }

  useEffect(() => {
    if (!initialUrls?.length || initialSubmittedRef.current) return
    initialSubmittedRef.current = true
    void startItems(initialUrls)
  }, [initialUrls, startItems])

  useEffect(() => {
    if (!isTermux() || outDirOverride) return
    void resolveOutDir().then(({dir, hint}) => {
      setOutDir(dir)
      if (hint) process.stderr.write(hint + '\n')
    })
  }, [outDirOverride])

  // early exit mid-run still reports the partial outcome (REQ-par-019); a
  // finished run already reported via onAllDone, so queueRef is undefined here
  useEffect(() => {
    return () => {
      if (queueRef.current) onOutcome(queueRef.current.currentOutcome())
    }
  }, [onOutcome])

  // each picker starts at the first option
  useEffect(() => {
    highlightRef.current = 0
  }, [pickerItemId])

  const resetToInput = useCallback(() => {
    // safe only from 'done' — the queue drained, nothing is running
    setScreen('input')
    setItems(new Map())
    setDoneInfo(undefined)
    setWarning(undefined)
    setPickerItemId(undefined)
    setUrlInput('')
    highlightRef.current = 0
    submittedRef.current = []
    pickersRef.current.clear()
    pickInfosRef.current.clear()
  }, [])

  // cancels only the oldest open picker — siblings' signals stay untouched
  const cancelPendingPick = useCallback(() => {
    if (!pickerItemId) return
    const resolve = pickersRef.current.get(pickerItemId)
    if (resolve) resolve('cancel')
    pickersRef.current.delete(pickerItemId)
    pickInfosRef.current.delete(pickerItemId)
    setPickerItemId(pickersRef.current.keys().next().value as string | undefined)
    // the last picker cancelled → back to the run, not an empty picker frame
    setScreen(screenAfterPickerClose(pickersRef.current.size, screen))
  }, [pickerItemId, screen])

  // whole-run cancel (REQ-par-010): abort every item AND resolve EVERY open
  // picker, or onAllDone would wait on the sibling promises forever
  // (pendingPicks guard in queue.ts)
  const cancelRun = useCallback(() => {
    queueRef.current?.cancelAll()
    for (const resolve of pickersRef.current.values()) resolve('cancel')
    pickersRef.current.clear()
    pickInfosRef.current.clear()
    setPickerItemId(undefined)
  }, [])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }
      if (key.escape) {
        if (screen === 'picker') cancelPendingPick()
        else if (screen === 'downloads') cancelRun()
        else if (screen === 'done') resetToInput()
        return
      }
      if (key.return) {
        if (screen === 'done') resetToInput()
        // REQ-par-001: downloads keep running, the input stays reachable
        else if (screen === 'downloads') setScreen('input')
        return
      }
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  // one paste may carry several links (REQ-par-001); whitespace separates them
  const handleUrlSubmit = async (value: string) => {
    const urls = splitSubmittedUrls(value)
    if (urls.length === 0) {
      setWarning('Eso no parece un enlace — pega una url completa')
      return
    }
    // clear immediately: a stale value can never ride along on the next paste
    // after a mid-run return (REQ-par-001). If the queue never accepts the
    // links (init failure) the field is restored for retry.
    setUrlInput('')
    const accepted = await startItems(urls)
    if (!accepted) setUrlInput(current => restoreAfterRejectedSubmit(current, value))
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  // the visible picker's data — the FIFO head (REQ-par-005)
  const pickerInfo = pickerItemId ? pickInfosRef.current.get(pickerItemId) : undefined
  const pickerUrl = pickerItemId ? items.get(pickerItemId)?.url : undefined
  const pickerPlatform = pickerUrl ? detectPlatform(pickerUrl) : undefined
  const pickerChoices = pickerInfo ? buildChoices(pickerInfo) : []
  const pickerPlaylist = pickerInfo ? playlistOption(pickerInfo) : undefined

  const handlePick = (item: {value: number}) => {
    const itemId = pickerItemId
    if (!itemId) return
    const resolve = pickersRef.current.get(itemId)
    if (!resolve) return
    let choice: DownloadChoice | 'playlist' | 'cancel'
    if (item.value === PLAYLIST_CHOICE_VALUE) {
      // "descargar los N videos" (REQ-018) — the driver expands the probe
      choice = 'playlist'
    } else {
      const picked = pickerChoices[item.value]
      if (!picked) return
      choice = picked
    }
    pickersRef.current.delete(itemId)
    pickInfosRef.current.delete(itemId)
    resolve(choice)
    setPickerItemId(pickersRef.current.keys().next().value as string | undefined)
    // no sibling pickers left → show the run so progress rows become visible
    setScreen(screenAfterPickerClose(pickersRef.current.size, screen))
  }

  let hints: Array<[string, string]> = [...HINTS[screen], ['^t', `tema:${theme.mode}`]]
  if (screen === 'input' && history.length > 0) {
    hints = [hints[0]!, ['↑', 'historial'], ...hints.slice(1)]
  }

  // Anything a mouse user would expect to press is clickable. Targets are
  // found by their text in the rendered frame (see lib/click-map.ts), so
  // there is no layout math to keep in sync.
  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === 'esc') {
      if (screen === 'picker') return cancelPendingPick
      if (screen === 'downloads') return cancelRun
      if (screen === 'done') return resetToInput
      return undefined
    }
    if (key === '↵') {
      if (screen === 'input') return () => handleUrlSubmit(urlInput)
      if (screen === 'picker') return () => handlePick({value: highlightRef.current})
      if (screen === 'downloads') return () => setScreen('input')
      if (screen === 'done') return resetToInput
    }
    return undefined // ↑↓ / ↑ stay keyboard-only
  }
  const clickTargets: ClickTarget[] = []
  if (screen === 'input') {
    // the arrow glyph is the whole button: a single `➜` on the input row
    clickTargets.push({match: '➜', action: () => handleUrlSubmit(urlInput)})
  }
  if (screen === 'picker') {
    for (const [index, choice] of pickerChoices.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handlePick({value: index})})
    }
    if (pickerPlaylist) {
      clickTargets.push({
        match: choiceLabel({kind: 'video', label: pickerPlaylist.label, args: []}),
        action: () => handlePick({value: PLAYLIST_CHOICE_VALUE}),
      })
    }
  }
  // done screen: no visible action — Enter returns to the start (see HINTS + useInput)
  for (const [key, label] of hints) {
    const action = hintAction(key)
    if (action) clickTargets.push({match: `${key} ${label}`, action})
  }

  useMouseClick(
    (x, y) => {
      // the logo takes you home — anchored on the rose geometry because the
      // name line below it scrambles ("Herlink" is not stable text while the
      // effect runs, so findFrameRow('Herlink') can miss during a scramble)
      const roseTop = findFrameRow('⣠') // first rose row, -1 when compact
      const nameRow = roseTop !== -1 ? roseTop + ROSE_ROWS + 1 : findFrameRow('Herlink')
      const inLogo =
        nameRow !== -1 &&
        (roseTop !== -1 ? y - 1 >= roseTop && y - 1 <= nameRow : y - 1 === nameRow)
      if (inLogo) {
        const span = frameRowSpan(y - 1)
        if (span && x >= span[0] - 1 && x <= span[1] + 1) {
          if (screen === 'picker') cancelPendingPick()
          else if (screen === 'downloads') cancelRun()
          else if (screen === 'done') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  const doneSummaryInfo = screen === 'done' && doneInfo ? doneSummary(doneInfo) : undefined
  const queuedCount = Array.from(items.values()).filter(item => item.status === 'queued').length

  const rowColor = (status: ItemStateStatus) => {
    switch (status) {
      case 'done':
        return theme.success
      case 'error':
        return theme.error
      case 'picking':
        return theme.accent
      case 'refreshing':
        return theme.warning
      case 'audio-fallback':
        return theme.warning
      case 'downloading':
        return theme.text
      default:
        return theme.muted
    }
  }

  const rowDetail = (item: ItemState) => {
    if (item.status === 'downloading' && item.progress) {
      const detail =
        item.progress.totalBytes ? (
          <ProgressBar percent={item.progress.downloadedBytes / item.progress.totalBytes} width={14} />
        ) : (
          <Text color={theme.muted}>{indeterminateMeta(item.progress)}</Text>
        )
      // title + bar on the same line when title is available
      if (item.title) {
        return (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={theme.muted}>{truncate(item.title.replace(/_/g, ' '), 30)}…</Text>
            {detail}
          </Box>
        )
      }
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          {detail}
        </Box>
      )
    }
    if (item.status === 'processing') {
      return (
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}> procesando…</Text>
        </Text>
      )
    }
    if (item.status === 'refreshing') {
      return (
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}> Reintentando — obteniendo datos nuevos…</Text>
        </Text>
      )
    }
    if (item.status === 'audio-fallback') {
      return (
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}> video bloqueado — bajando solo audio…</Text>
        </Text>
      )
    }
    return null
  }

  return (
    <FullScreen>
      <Logo />
      <Gap />
      <Box flexDirection="column" alignItems="center">
        <Text color={theme.muted}>una terminal que no promete nada.</Text>
        <Text color={theme.muted}>solo ofrece un lugar donde lo fugaz puede quedarse un poco más.</Text>
      </Box>
      <Gap lines={3} />

      {screen === 'input' && (
        <Box flexDirection="column" alignItems="center">
          <UnderlineInput width={boxWidth} button={ACTION_LABEL}>
            <TextInput
              value={urlInput}
              onChange={setUrlInput}
              onSubmit={handleUrlSubmit}
              placeholder="https://youtube.com/watch?v=…"
              width={boxWidth - underlineButtonWidth() - 3}
              history={history}
              submitOnPaste={isProbablyUrl}
              onTab={() => {
                if (clipboardOffered) setUrlInput(clipboardUrl!)
              }}
            />
          </UnderlineInput>
          {warning ? (
            <Text color={theme.warning}>✗ {warning}</Text>
          ) : clipboardOffered ? (
            <Text color={theme.muted}>Hay un enlace en tu portapapeles — ⇥ para pegarlo</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.muted}>desde tu portapapeles — ↵ para bajarlo</Text>
          ) : null}
        </Box>
      )}

      {screen === 'picker' && pickerItemId && pickerInfo && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} justifyContent="center" paddingRight={3}>
            {/* wrapped by hand so continuation lines stay flush left —
                ink's wrapping keeps the break's space as a 1-cell indent */}
            {wrapText(pickerInfo.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.emphasized}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.muted}>
              ▸ {pickerPlatform?.label ?? 'enlace'}
              {pickerInfo.duration ? ` · ${formatDuration(pickerInfo.duration)}` : ''}
              {pickerInfo.uploader ? ` · ${pickerInfo.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Descargar" width={38}>
            <SelectInput
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={[
                ...pickerChoices.map((choice, index) => ({
                  key: String(index),
                  label: choiceLabel(choice),
                  value: index,
                })),
                // REQ-018: playlist option alongside the format choices
                ...(pickerPlaylist
                  ? [
                      {
                        key: 'playlist',
                        label: choiceLabel({kind: 'video', label: pickerPlaylist.label, args: []}),
                        value: PLAYLIST_CHOICE_VALUE,
                      },
                    ]
                  : []),
              ]}
              onSelect={handlePick}
              onHighlight={item => (highlightRef.current = item.value)}
            />
          </Panel>
        </Box>
      )}

      {screen === 'downloads' && (
        <Box flexDirection="column" alignItems="center" width={contentWidth}>
          {items.size === 0 ? (
            <Text>
              <Text color={theme.accent}>
                <Spinner type="dots" />
              </Text>
              <Text color={theme.muted}> {initStatus ?? 'preparando…'}</Text>
            </Text>
          ) : (
            <>
              {Array.from(items.entries()).map(([itemId, item]) => (
                <Box key={itemId} flexDirection="column" width={boxWidth}>
                  <Box justifyContent="space-between">
                    {/* show title when downloading, URL otherwise */}
                    <Text color={theme.muted}>
                      {item.status === 'downloading' && item.title
                        ? truncate(item.title.replace(/_/g, ' '), 40)
                        : truncate(item.url, 40)}
                    </Text>
                    {/* hide label when progress bar is visible — bar is self-explanatory */}
                    {!(item.status === 'downloading' && item.progress) && (
                      <Text bold color={rowColor(item.status)}>
                        {STATUS_LABEL[item.status]}
                      </Text>
                    )}
                  </Box>
                  {rowDetail(item)}
                </Box>
              ))}
              {queuedCount > 0 && (
                <>
                  <Gap lines={1} />
                  <Text color={theme.muted}>{queuedCount} en cola</Text>
                </>
              )}
            </>
          )}
        </Box>
      )}

      {screen === 'done' && doneInfo && doneSummaryInfo && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Text bold color={doneInfo.cancelled ? theme.warning : theme.success}>
              {doneSummaryInfo.heading}{' '}
            </Text>
            <Text color={theme.muted}>{doneSummaryInfo.sub}</Text>
          </Text>
          <Gap />
          {doneInfo.filepaths.map((filepath, index) => (
            // two files may resolve to the same path (same title from different
            // urls) — a unique key keeps the map stable
            <Text key={`${filepath}-${index}`} color={theme.info}>
              {shortenPath(filepath, os.homedir(), 60)}
            </Text>
          ))}
          {doneSummaryInfo.errors.map((error, index) => (
            <Text key={index} color={theme.error}>
              ✗ {error}
            </Text>
          ))}
        </Box>
      )}

      {hints.length > 0 ? (
        <>
          <Gap lines={4} />
          <Shortcuts items={hints} />
        </>
      ) : null}
    </FullScreen>
  )
}
