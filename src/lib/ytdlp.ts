import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'
import {FFMPEG_TERMUX_HINT, isSharedStorageDir, isTermux, YTDLP_TERMUX_ERROR} from './termux.js'

const HERLINK_DIR = path.join(os.homedir(), '.herlink', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  // the standalone build is glibc and cannot exec on Termux's bionic libc —
  // PATH-only there, so fail with the install command instead of downloading
  if (isTermux()) throw new Error(YTDLP_TERMUX_ERROR)

  const local = path.join(HERLINK_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('primera ejecución: descargando yt-dlp…')
  await fs.mkdir(HERLINK_DIR, {recursive: true})

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
  const response = await fetch(url, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`No se pudo descargar yt-dlp (${response.status}). Revisa tu conexión e inténtalo de nuevo.`)
  }

  const tmp = `${local}.download`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

/**
 * Tri-state ffmpeg status (D4): available with no location = on PATH (yt-dlp
 * finds it itself), available with location = ffmpeg-static fallback, absent =
 * embed/merge features must warn-skip instead of failing (REQ-011/013).
 */
export type FfmpegStatus = {available: boolean; location?: string}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. yt-dlp still works for single-file formats
 * without it.
 */
export async function findFfmpeg(): Promise<FfmpegStatus> {
  if (await commandWorks('ffmpeg', ['-version'])) return {available: true} // on PATH, yt-dlp finds it itself
  // no ffmpeg-static fallback on Termux — hint instead of silently failing the
  // merge/extract step later
  if (isTermux()) {
    process.stderr.write(FFMPEG_TERMUX_HINT + '\n')
    return {available: false}
  }
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return {available: true, location: ffmpegPath}
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return {available: false}
}

// warn-skip, never fail (REQ-011): the Termux hint tells the user how to get
// ffmpeg, the desktop message explains why their flags were dropped
function warnFfmpegMissing(): void {
  process.stderr.write(
    (isTermux() ? FFMPEG_TERMUX_HINT : 'ffmpeg no está disponible — se omiten las opciones de incrustado') + '\n',
  )
}

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export async function probe(
  ytdlp: string,
  url: string,
  signal?: AbortSignal,
  cookies?: string,
): Promise<ProbeResult> {
  const argv = ['-J', '--no-playlist', '--no-warnings']
  if (cookies) argv.push('--cookies', cookies)
  argv.push(url)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, argv, {signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp terminó con el código ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('No se pudo leer la información del video de yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `herlink-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'mejor disponible · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `solo audio · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

export function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

/** The top video choice (or the "mejor disponible" fallback) — what --best downloads. */
export function bestChoice(info: VideoInfo): DownloadChoice {
  return buildChoices(info)[0]!
}

/** The audio-only mp3 choice — what --mp3 downloads. */
export function audioChoice(info: VideoInfo): DownloadChoice {
  return buildChoices(info).at(-1)!
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'HERLINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export type DownloadArgs = {
  url: string
  /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
  infoJsonPath?: string
  choice: DownloadChoice
  outDir: string
  ffmpeg: FfmpegStatus
  /** --continue: resume a partial download instead of restarting (REQ-005). */
  resume?: boolean
  /** Netscape cookies file, passed to yt-dlp for auth (REQ-007). */
  cookies?: string
  /** --embed-metadata --embed-thumbnail, ffmpeg-gated (REQ-009/011); resolved off-switch wins at parse (D3). */
  embedMetadata?: boolean
  /** Subtitle langs, '' = all; video kind only (REQ-012/014). */
  subs?: string
}

// pure aside from a call-time env read, so the Termux/desktop argument sets
// are testable without spawning yt-dlp
export function buildDownloadArgs(opts: DownloadArgs): string[] {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...(opts.cookies ? ['--cookies', opts.cookies] : []),
    ...opts.choice.args,
    ...(opts.resume ? ['--continue'] : []),
    // subs block — video kind only (REQ-014); --embed-subs gated on ffmpeg (REQ-013)
    ...(opts.subs !== undefined && opts.choice.kind === 'video'
      ? ['--write-subs', ...(opts.subs ? ['--sub-langs', opts.subs] : []), ...(opts.ffmpeg.available ? ['--embed-subs'] : [])]
      : []),
    // embed block — ffmpeg-gated, warn+skip when absent (REQ-011)
    ...(opts.embedMetadata && opts.ffmpeg.available ? ['--embed-metadata', '--embed-thumbnail'] : []),
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  // warn-skip instead of failing: embed flags requested but ffmpeg absent
  if (opts.embedMetadata && !opts.ffmpeg.available) warnFfmpegMissing()
  if (opts.subs !== undefined && opts.choice.kind === 'video' && !opts.ffmpeg.available) warnFfmpegMissing()
  // FAT-forbidden chars in titles (": ? * " < > |") break downloads into
  // shared storage — restrict-filenames makes yt-dlp sanitize them away
  if (isTermux() && isSharedStorageDir(opts.outDir)) args.push('--restrict-filenames')
  if (opts.ffmpeg.location) args.push('--ffmpeg-location', opts.ffmpeg.location)
  return args
}

export function download(
  opts: DownloadArgs & {ytdlp: string},
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = buildDownloadArgs(opts)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes this run, so a cancel can clean up after itself
    const destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        void removePartials(destinations)
        reject(new Error('Descarga cancelada.'))
        return
      }
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Falló la descarga (código de salida de yt-dlp ${code}).`))
      }
    })
  })
}

// KEEPS .part files so a later --continue can resume (D6, REQ-006); deletes
// only the final destination and the .ytdl resume metadata.
export function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
