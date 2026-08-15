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
import {formatBytes, formatDuration, formatEta, formatSpeed, shortenPath, truncate, wrapText} from './lib/format.js'
import {addToHistory, loadHistory} from './lib/history.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {isTermux, resolveOutDir} from './lib/termux.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type ThemeMode, useTheme} from './theme.js'
import {runQueue, type Outcome} from './lib/queue.js'
export type {Outcome} from './lib/queue.js'
import {
  buildChoices,
  ensureYtDlp,
  findFfmpeg,
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

function downloadMeta(progress: DownloadProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatEta(progress.eta)} restante` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ·  ${eta.padEnd(12)}`
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

type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      choice: DownloadChoice
      progress?: DownloadProgress
      processing: boolean
      refreshing?: boolean
    }
  | {name: 'done'; filepaths: string[]; cancelled: boolean}
  | {name: 'error'; message: string}

const HINTS: Record<Phase['name'], Array<[string, string]>> = {
  input: [
    ['↵', 'bajar'],
    ['^c', 'salir'],
  ],
  probing: [
    ['esc', 'cancelar'],
    ['^c', 'salir'],
  ],
  picking: [
    ['↑↓', 'elegir'],
    ['↵', 'bajar'],
    ['esc', 'cancelar'],
    ['^c', 'salir'],
  ],
  downloading: [
    ['esc', 'cancelar'],
    ['^c', 'salir'],
  ],
  done: [
    ['↵', 'volver'],
    ['^c', 'salir'],
  ],
  error: [
    ['↵', 'intentar de nuevo'],
    ['^c', 'salir'],
  ],
}

type AppProps = {
  initialUrls?: string[]
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  outDirOverride?: string
  resume?: boolean
  cookies?: string
  embedMetadata?: boolean
  subs?: string
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
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const [queue, setQueue] = useState<string[]>(initialUrls ?? [])
  const [queueIndex, setQueueIndex] = useState(0)
  const [url, setUrl] = useState(initialUrls?.[0] ?? '')
  const [urlInput, setUrlInput] = useState('')
  // -o override wins; ~/Downloads default, then shared storage on Termux once
  // resolveOutDir lands (effect below is skipped when the override is set)
  const [outDir, setOutDir] = useState(() => resolveInitialOutDir(outDirOverride, os.homedir()))
  const [history, setHistory] = useState(loadHistory)
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  // the "descargar los N videos" picker option, present only for playlists (REQ-018)
  const [playlistChoice, setPlaylistChoice] = useState<{label: string; count?: number} | undefined>(undefined)
  const ytdlpRef = useRef('')
  const highlightRef = useRef(0) // choice under the cursor, for the ↵ hint click
  const abortRef = useRef<AbortController | undefined>(undefined)
  // resolves runQueue's per-item choiceFor promise once the picker answers
  const pickRef = useRef<((choice: DownloadChoice | 'playlist' | 'cancel') => void) | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(
    initialUrls?.length ? {name: 'probing', status: 'preparando…'} : {name: 'input'},
  )

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))

  const startQueue = useCallback(
    async (urls: string[]) => {
      const controller = new AbortController()
      abortRef.current = controller
      setQueue(urls)
      setQueueIndex(0)
      setUrl(urls[0] ?? '')
      setPhase({name: 'probing', status: 'preparando…'})
      try {
        const ytdlp =
          ytdlpRef.current ||
          (await ensureYtDlp(status => setPhase({name: 'probing', status}), controller.signal))
        ytdlpRef.current = ytdlp
        if (controller.signal.aborted) return
        setPhase({name: 'probing', status: 'obteniendo info del video…'})
        const ffmpeg: FfmpegStatus = await findFfmpeg()
        if (controller.signal.aborted) return
        // the sequential queue driver (D9): probe → pick → download → next
        // item, with React callbacks driving every phase transition
        const outcome = await runQueue(
          urls.map(url => ({url})),
          {
            ytdlp,
            outDir,
            ffmpeg,
            resume,
            cookies,
            embedMetadata,
            subs,
            signal: controller.signal,
            onItem: index => {
              setQueueIndex(index)
              setUrl(urls[index]!)
              setPlatform(detectPlatform(urls[index]!))
              setPhase({name: 'probing', status: 'obteniendo info del video…'})
            },
            choiceFor: (videoInfo): Promise<DownloadChoice | 'playlist' | 'cancel'> => {
              setInfo(videoInfo)
              setChoices(buildChoices(videoInfo))
              setPlaylistChoice(playlistOption(videoInfo))
              highlightRef.current = 0
              setPhase({name: 'picking'})
              // the picker answers via handlePick; esc resolves 'cancel' (REQ-017)
              return new Promise(resolve => {
                pickRef.current = resolve
              })
            },
            onProgress: progress =>
              setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
            onProcessing: () =>
              setPhase(prev => (prev.name === 'downloading' ? {...prev, processing: true} : prev)),
            onRetry: () =>
              setPhase(prev =>
                prev.name === 'downloading' ? {...prev, progress: undefined, refreshing: true} : prev,
              ),
          },
        )
        onOutcome(outcome)
        if (!outcome.cancelled) for (const itemUrl of urls) setHistory(addToHistory(itemUrl))
        if (outcome.cancelled) {
          // remaining items skipped, already-downloaded files kept (REQ-017)
          setPhase({name: 'done', filepaths: outcome.filepaths, cancelled: true})
        } else if (outcome.errors.length > 0) {
          setPhase({name: 'error', message: outcome.errors[0]!})
        } else {
          setPhase({name: 'done', filepaths: outcome.filepaths, cancelled: false})
        }
      } catch (error) {
        if (controller.signal.aborted) {
          setPhase({name: 'done', filepaths: [], cancelled: true})
          return
        }
        setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
      }
    },
    [outDir, resume, cookies, embedMetadata, subs, onOutcome],
  )

  useEffect(() => {
    if (initialUrls?.length) void startQueue(initialUrls)
  }, [initialUrls, startQueue])

  useEffect(() => {
    if (!isTermux() || outDirOverride) return
    void resolveOutDir().then(({dir, hint}) => {
      setOutDir(dir)
      if (hint) process.stderr.write(hint + '\n')
    })
  }, [outDirOverride])

  const resetToInput = useCallback(() => {
    setQueue([])
    setQueueIndex(0)
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setInfo(undefined)
    setChoices([])
    setPlaylistChoice(undefined)
    setPhase({name: 'input'})
  }, [])

  // whole-queue cancel (REQ-017): abort the current item, resolve a pending
  // pick with 'cancel' so runQueue skips the remaining items and keeps the
  // files already downloaded
  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    pickRef.current?.('cancel')
    pickRef.current = undefined
    setUrlInput(url) // keep the link around so a cancel isn't destructive
  }, [url])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }
      if (key.escape && (phase.name === 'error' || phase.name === 'done')) resetToInput()
      if (key.escape && (phase.name === 'probing' || phase.name === 'downloading' || phase.name === 'picking')) {
        cancelRun()
      }
      if (key.return && (phase.name === 'error' || phase.name === 'done')) resetToInput()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const handleUrlSubmit = (value: string) => {
    const trimmed = value.trim()
    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'eso no parece un enlace — pega una url completa'})
      return
    }
    void startQueue([trimmed])
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  const handlePick = (item: {value: number}) => {
    if (item.value === PLAYLIST_CHOICE_VALUE) {
      // "descargar los N videos" (REQ-018) — runQueue expands the probe into
      // per-entry downloads; the synthetic choice only drives the header
      pickRef.current?.('playlist')
      pickRef.current = undefined
      setPhase({
        name: 'downloading',
        choice: {label: playlistChoice?.label ?? 'descargar playlist', kind: 'video', args: []},
        processing: false,
      })
      return
    }
    const choice = choices[item.value]
    if (!choice) return
    pickRef.current?.(choice)
    pickRef.current = undefined
    setPhase({name: 'downloading', choice, processing: false})
  }

  let hints: Array<[string, string]> = [...HINTS[phase.name], ['^t', `tema:${theme.mode}`]]
  if (phase.name === 'input' && history.length > 0) {
    hints = [hints[0]!, ['↑', 'historial'], ...hints.slice(1)]
  }

  // Anything a mouse user would expect to press is clickable. Targets are
  // found by their text in the rendered frame (see lib/click-map.ts), so
  // there is no layout math to keep in sync.
  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === 'esc')
      return phase.name === 'probing' || phase.name === 'downloading' || phase.name === 'picking'
        ? cancelRun
        : resetToInput
    if (key === '↵') {
      if (phase.name === 'input') return () => handleUrlSubmit(urlInput)
      if (phase.name === 'picking') return () => handlePick({value: highlightRef.current})
      if (phase.name === 'error' || phase.name === 'done') return resetToInput
    }
    return undefined // ↑↓ / ↑ stay keyboard-only
  }
  const clickTargets: ClickTarget[] = []
  if (phase.name === 'input') {
    // the arrow glyph is the whole button: a single `➜` on the input row
    clickTargets.push({match: '➜', action: () => handleUrlSubmit(urlInput)})
  }
  if (phase.name === 'picking') {
    for (const [index, choice] of choices.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handlePick({value: index})})
    }
    if (playlistChoice) {
      clickTargets.push({
        match: choiceLabel({kind: 'video', label: playlistChoice.label, args: []}),
        action: () => handlePick({value: PLAYLIST_CHOICE_VALUE}),
      })
    }
  }
  // done phase: no visible action — Enter returns to the start (see HINTS + useInput)
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
          if (phase.name === 'probing' || phase.name === 'downloading' || phase.name === 'picking') cancelRun()
          else if (phase.name !== 'input') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  return (
    <FullScreen>
      <Logo />
      <Gap />
      <Box flexDirection="column" alignItems="center">
        <Text color={theme.muted}>una terminal que no promete nada.</Text>
        <Text color={theme.muted}>solo ofrece un lugar donde lo fugaz puede quedarse un poco más.</Text>
      </Box>
      <Gap lines={3} />

      {phase.name === 'input' && (
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
          {phase.warning ? (
            <Text color={theme.warning}>✗ {phase.warning}</Text>
          ) : clipboardOffered ? (
            <Text color={theme.muted}>hay un enlace en tu portapapeles — ⇥ para pegarlo</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.muted}>desde tu portapapeles — ↵ para bajarlo</Text>
          ) : null}
        </Box>
      )}

      {phase.name === 'probing' && (
        <Box flexDirection="column" alignItems="center">
          <UnderlineInput
            width={boxWidth}
            button={ACTION_LABEL}
            buttonDim
          >
            <Text color={theme.text}>
              {url.length > boxWidth - 14 ? `${url.slice(0, boxWidth - 15)}…` : url}
            </Text>
          </UnderlineInput>
        </Box>
      )}

      {phase.name === 'picking' && platform && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} justifyContent="center" paddingRight={3}>
            {/* wrapped by hand so continuation lines stay flush left —
                ink's wrapping keeps the break's space as a 1-cell indent */}
            {wrapText(info?.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.emphasized}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.muted}>
              ▸ {platform.label}
              {info?.duration ? ` · ${formatDuration(info.duration)}` : ''}
              {info?.uploader ? ` · ${info.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Descargar" width={38}>
            <SelectInput
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={[
                ...choices.map((choice, index) => ({
                  key: String(index),
                  label: choiceLabel(choice),
                  value: index,
                })),
                // REQ-018: playlist option alongside the format choices
                ...(playlistChoice
                  ? [
                      {
                        key: 'playlist',
                        label: choiceLabel({kind: 'video', label: playlistChoice.label, args: []}),
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

      {phase.name === 'downloading' && (
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.emphasized}>
            {queue.length > 1 ? <Text color={theme.muted}>video {queueIndex + 1}/{queue.length} · </Text> : null}
            {info?.title ? `${truncate(info.title, 42)} · ` : ''}
            {phase.choice.label}
          </Text>
          <Gap />
          {/* every branch is exactly three rows — bar, gap, meta — so the layout never jumps */}
          {phase.processing ? (
            <>
              <ProgressBar percent={1} />
              <Gap />
              <Text>
                <Text color={theme.accent}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.muted}> procesando…</Text>
              </Text>
            </>
          ) : phase.progress?.totalBytes ? (
            <>
              <ProgressBar percent={phase.progress.downloadedBytes / phase.progress.totalBytes} />
              <Gap />
              <Text color={theme.muted}>{downloadMeta(phase.progress)}</Text>
            </>
          ) : phase.progress ? (
            <>
              <Text>
                <Text color={theme.accent}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.muted}> descargando…</Text>
              </Text>
              <Gap />
              <Text color={theme.muted}>{indeterminateMeta(phase.progress)}</Text>
            </>
          ) : (
            <>
              <ProgressBar percent={0} />
              <Gap />
              <Text>
                <Text color={theme.accent}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.muted}>
                  {phase.refreshing ? ' enlace expirado — obteniendo uno nuevo…' : ' comenzando descarga…'}
                </Text>
              </Text>
            </>
          )}
        </Box>
      )}

      {phase.name === 'done' && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            {phase.cancelled ? (
              <Text bold color={theme.warning}>✗ Cancelado </Text>
            ) : phase.filepaths.length > 1 ? (
              <Text bold color={theme.success}>✓ Descargados {phase.filepaths.length} archivos </Text>
            ) : (
              <Text bold color={theme.success}>✓ Descargado </Text>
            )}
            <Text color={theme.muted}>
              {phase.cancelled
                ? phase.filepaths.length > 0
                  ? 'se guardaron los archivos ya descargados:'
                  : 'no se descargó ningún archivo'
                : phase.filepaths.length > 1
                  ? 'están en:'
                  : 'tu archivo está en:'}
            </Text>
          </Text>
          <Gap />
          {phase.filepaths.map(filepath => (
            <Text key={filepath} color={theme.info}>
              {shortenPath(filepath, os.homedir(), 60)}
            </Text>
          ))}
        </Box>
      )}

      {phase.name === 'error' && (
        <Box flexDirection="column" alignItems="center" width={Math.max(10, Math.min(columns - 6, 72))}>
          <Text color={theme.error}>✗ {phase.message}</Text>
        </Box>
      )}

      {hints.length > 0 ? (
        <>
          <Gap lines={4} />
          <Shortcuts
            items={hints}
            leading={
              phase.name === 'probing' ? (
                <Text>
                  <Text color={theme.accent}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={theme.muted}> {phase.status}</Text>
                </Text>
              ) : undefined
            }
          />
        </>
      ) : null}
    </FullScreen>
  )
}
