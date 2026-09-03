import {spawn, type ChildProcess} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'
import {FFMPEG_TERMUX_HINT, isSharedStorageDir, isTermux, YTDLP_TERMUX_ERROR} from './termux.js'

// read at call time, not module load — tests flip $HOME between cases and a
// cached const would freeze the first answer forever (termux.ts convention)
function herlinkBinDir(): string {
  return path.join(os.homedir(), '.herlink', 'bin')
}

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

  const local = path.join(herlinkBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('primera ejecución: descargando yt-dlp…')
  await fs.mkdir(herlinkBinDir(), {recursive: true})

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

export type SelfUpdateResult = {
  /** true when the -U check ran and the binary state is known (current or updated). */
  checked: boolean
  /** New version when the self-update actually replaced the bundled binary. */
  updated?: string
  /** Why there is no definitive answer: not the bundled copy, Termux pkg, or the -U run failed. */
  reason?: 'not-bundled' | 'termux' | 'failed'
}

// the -U run must never hang startup (REQ-020/021): a stuck update is killed
// after 30s and treated as a silent failure
const SELF_UPDATE_TIMEOUT_MS = 30_000

// a pip/wheel install cannot self-update — yt-dlp says so and exits 0 on some
// versions, so the message is the reliable signal (never a crash)
const PACKAGE_MANAGER_RE = /pip|pypi|package manager/i

/** True only for the bundled standalone copy under ~/.herlink/bin (D11, REQ-020). */
export function isBundledBinary(binary: string): boolean {
  return path.dirname(binary) === herlinkBinDir()
}

/**
 * REQ-022: --no-update in probe/download args whenever the bundled binary is
 * in use (herlink manages freshness) or the user passed the flag. Pure so the
 * call sites (cli/app) and the golden tests share one rule.
 */
export function effectiveNoUpdate(userNoUpdate: boolean, binary: string): boolean {
  return userNoUpdate || isBundledBinary(binary)
}

/**
 * Silent startup self-update (D11): runs `yt-dlp -U` ONLY for the bundled
 * ~/.herlink/bin copy — never for a PATH `yt-dlp` or a Termux pkg install
 * (REQ-020). Never throws and never blocks startup: every failure path falls
 * back to {checked: false, reason: 'failed'}. onStatus fires only when the
 * binary was actually updated (silent otherwise).
 */
export async function maybeSelfUpdate(
  binary: string,
  onStatus?: (message: string) => void,
): Promise<SelfUpdateResult> {
  if (isTermux()) return {checked: false, reason: 'termux'}
  if (!isBundledBinary(binary)) return {checked: false, reason: 'not-bundled'}

  let stdout = ''
  let stderr = ''
  let code: number | null
  try {
    const result = await new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(binary, ['-U'], {timeout: SELF_UPDATE_TIMEOUT_MS})
      } catch (error) {
        reject(error)
        return
      }
      child.stdout?.on('data', chunk => (stdout += chunk))
      child.stderr?.on('data', chunk => (stderr += chunk))
      child.on('error', reject)
      child.on('close', code => resolve({code, stdout, stderr}))
    })
    code = result.code
  } catch {
    // spawn error or timeout — silent fallback, never crash startup (REQ-020)
    return {checked: false, reason: 'failed'}
  }
  if (code !== 0) return {checked: false, reason: 'failed'}
  if (PACKAGE_MANAGER_RE.test(stdout + stderr)) return {checked: false, reason: 'failed'}
  const updated = /Updated yt-dlp to (.+)/.exec(stdout)?.[1]
  if (updated) {
    onStatus?.(`yt-dlp actualizado a ${updated}`)
    return {checked: true, updated}
  }
  // "yt-dlp is up to date (X)" or unrecognized exit-0 output — no-op (REQ-021)
  return {checked: true}
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
    (isTermux() ? FFMPEG_TERMUX_HINT : 'Ffmpeg no está disponible — se omiten las opciones de incrustado') + '\n',
  )
}

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
  // playlist context — present on first-entry JSON even with --no-playlist (D7)
  _type?: string
  playlist_id?: string
  playlist_count?: number
}

/**
 * Playlist detection (D7): a probe of a playlist URL returns the first video's
 * JSON, where extractor_key stays "Youtube" — the playlist_id is the reliable
 * signal. _type === 'playlist' and the ':playlist' extractor suffix are the
 * spec-listed signals for other extractors (X/Instagram threads).
 */
export function isPlaylistInfo(info: VideoInfo): boolean {
  return info._type === 'playlist' || info.extractor_key?.endsWith(':playlist') || Boolean(info.playlist_id)
}

/**
 * Picker option for the playlist choice (REQ-018): offered alongside the
 * format choices when the probed URL is a playlist. count is undefined when
 * yt-dlp did not report playlist_count (D13 fallback label).
 */
export function playlistOption(info: VideoInfo): {label: string; count?: number} | undefined {
  if (!isPlaylistInfo(info)) return undefined
  const count = typeof info.playlist_count === 'number' ? info.playlist_count : undefined
  return {label: count ? `descargar los ${count} videos` : 'descargar todos los videos', count}
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

import {
  DEFAULT_FRAGMENT_RETRIES,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_SLEEP,
  DEFAULT_SOCKET_TIMEOUT,
  defaultArchivePath,
} from './constants.js'

export {DEFAULT_FRAGMENT_RETRIES, DEFAULT_RETRIES, DEFAULT_RETRY_SLEEP, DEFAULT_SOCKET_TIMEOUT, defaultArchivePath}

export type ProbeExtra = {
  retries?: number
  fragmentRetries?: number
  retrySleep?: string
  socketTimeout?: number
  downloadArchive?: string
  breakOnExisting?: boolean
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
  noUpdate?: boolean,
  extra?: ProbeExtra,
): Promise<ProbeResult> {
  const argv = ['-J', '--no-playlist', '--no-warnings', '--compat-options', 'manifest-filesize-approx']
  if (cookies) argv.push('--cookies', cookies)
  if (noUpdate) argv.push('--no-update')
  // P0-1: robust retries for probe as well (403/transient network) — mirrors download hardening
  argv.push('--retries', String(extra?.retries ?? DEFAULT_RETRIES))
  argv.push('--fragment-retries', String(extra?.fragmentRetries ?? DEFAULT_FRAGMENT_RETRIES))
  argv.push('--retry-sleep', extra?.retrySleep ?? DEFAULT_RETRY_SLEEP)
  argv.push('--socket-timeout', String(extra?.socketTimeout ?? DEFAULT_SOCKET_TIMEOUT))
  if (extra?.downloadArchive) argv.push('--download-archive', extra.downloadArchive)
  if (extra?.breakOnExisting && extra?.downloadArchive) argv.push('--break-on-existing')
  argv.push(url)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, argv, {signal})
    activeChildren.add(child)
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => {
      activeChildren.delete(child)
      reject(error)
    })
    child.on('close', code => {
      activeChildren.delete(child)
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

  // nonce beyond pid+Date.now: two probes in the same millisecond write
  // distinct tmpfiles, neither overwrites the other (REQ-par-002 s2)
  const infoJsonPath = path.join(
    os.tmpdir(),
    `herlink-info-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  )
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

function estimateSize(f: RawFormat, duration?: number): number {
  if (f.filesize) return f.filesize
  if (f.filesize_approx) return f.filesize_approx
  // estimate from bitrate (tbr kbps) × duration when filesize is missing (YouTube often omits it)
  const bitrate = f.tbr ?? f.abr
  if (bitrate && duration) return Math.round((bitrate * 1000 / 8) * duration)
  return 0
}

export function buildChoices(info: VideoInfo, ffmpeg?: FfmpegStatus): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = estimateSize(bestAudio ?? {}, info.duration)

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = estimateSize(best, info.duration) + (muxed ? 0 : audioSize)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    // BUG-1: MP4 only supports H.264/AV1 video. VP9/AV1-in-WebM cannot be
    // merged into MP4 (`[mov] vp9 only supported in MP4` — yt-dlp #10500).
    // On YouTube there is NO H.264 above 1080p (#8880), so a 1440p/2160p
    // "· mp4" label always resolves to VP9 and the merge fails. Detect the
    // best candidate's video codec: if it is not MP4-compatible, offer the
    // height as MKV instead so the merge actually succeeds.
    const vcodec = best.vcodec ?? ''
    const mp4Compatible = /avc1?\b|h264|av01/i.test(vcodec)
    const mergeFormat = mp4Compatible ? 'mp4' : 'mkv'
    const extLabel = mergeFormat === 'mp4' ? 'mp4' : 'mkv'
    // BUG-3: bv*+ba requires ffmpeg to merge; without ffmpeg the download would
    // fail at runtime. yt-dlp itself falls back to -f best (a pre-muxed file)
    // when ffmpeg is unavailable, so mirror that here: use a pre-muxed leg.
    const hasFfmpeg = ffmpeg?.available !== false
    const formatSpec = hasFfmpeg
      ? `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`
      : `b[height=${height}]/b[height<=${height}]/b`
    choices.push({
      kind: 'video',
      label: `${height}p · ${extLabel}${sizeLabel}`,
      args: [
        '-f',
        formatSpec,
        '-S',
        'vcodec:avc',
        '--merge-output-format',
        mergeFormat,
        // Facebook serves VP9 in MP4 which breaks playback — a Firefox UA
        // makes it serve H.264 instead (yt-dlp issue #11326). Safe for all sites.
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'mejor disponible · mp4',
      args: [
        '-f',
        // BUG-3: without ffmpeg use a pre-muxed file (b) — bv*+ba needs a merge
        ffmpeg?.available === false ? 'b/best' : 'bv*+ba/b',
        '-S',
        'vcodec:avc',
        '--merge-output-format',
        'mp4',
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      ],
    })
  }
  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  // BUG-3: mp3 transcoding (-x --audio-format mp3) requires ffmpeg. Without it
  // offer the best native audio stream instead (ba/b) so the choice still works.
  const hasFfmpeg2 = ffmpeg?.available !== false
  choices.push({
    kind: 'audio',
    label: hasFfmpeg2 ? `solo audio · mp3${audioSizeLabel}` : `solo audio${audioSizeLabel}`,
    args: hasFfmpeg2 ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['-f', 'ba/b'],
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

/**
 * Audio-only fallback when the video stream is DRM-blocked (mp3 when ffmpeg
 * is available, best native audio format otherwise).
 */
export function audioFallbackChoice(info: VideoInfo, ffmpeg: FfmpegStatus): DownloadChoice {
  if (ffmpeg.available) return audioChoice(info)
  return {kind: 'audio', label: 'solo audio', args: ['-f', 'ba/b']}
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

// every probe/download child tracked so process exit can kill ALL of them,
// not just the last one (REQ-par-018) — closed children are removed from the
// Set so a dead pid is never SIGTERM'd again (REQ-par-018 s2)
const activeChildren = new Set<ChildProcess>()

function killAllChildren(): void {
  for (const child of activeChildren) child.kill('SIGTERM')
}

process.on('exit', killAllChildren)

export type DownloadArgs = {
  url: string
  choice: DownloadChoice
  outDir: string
  ffmpeg: FfmpegStatus
  /** --continue: resume a partial download instead of restarting (REQ-005). */
  resume?: boolean  /** Netscape cookies file, passed to yt-dlp for auth (REQ-007). */
  cookies?: string
  /** --embed-metadata --embed-thumbnail, ffmpeg-gated (REQ-009/011); resolved off-switch wins at parse (D3). */
  embedMetadata?: boolean
  /** Subtitle langs, '' = all; video kind only (REQ-012/014). */
  subs?: string
  /** Playlist mode: playlist:true omits --no-playlist; with playlistIndex the
   * entry window --playlist-start/end N scopes the run to one entry (D8). */
  playlist?: boolean
  playlistIndex?: number
  /** --no-update: suppress yt-dlp's 90-day stale warning when herlink manages
   * freshness or the user asked for it (REQ-022). */
  noUpdate?: boolean
  /** P0-1: hardened retries — defaults 10/10/1/30 mitigate YouTube 403 transient failures */
  retries?: number
  fragmentRetries?: number
  retrySleep?: string
  socketTimeout?: number
  /** P0-2: yt-dlp archive — prevents re-downloading playlist entries already fetched */
  downloadArchive?: string
  breakOnExisting?: boolean
}

// pure aside from a call-time env read, so the Termux/desktop argument sets
// are testable without spawning yt-dlp
export function buildDownloadArgs(opts: DownloadArgs): string[] {
  const args = [
    opts.url,
    ...(opts.cookies ? ['--cookies', opts.cookies] : []),
    ...opts.choice.args,
    ...(opts.resume ? ['--continue'] : []),
    // subs block — video kind only (REQ-014); --embed-subs gated on ffmpeg (REQ-013)
    ...(opts.subs !== undefined && opts.choice.kind === 'video'
      ? ['--write-subs', ...(opts.subs ? ['--sub-langs', opts.subs] : []), ...(opts.ffmpeg.available ? ['--embed-subs'] : [])]
      : []),
    // embed block — ffmpeg-gated, warn+skip when absent (REQ-011)
    ...(opts.embedMetadata && opts.ffmpeg.available ? ['--embed-metadata', '--embed-thumbnail'] : []),
    // --no-update: suppress the stale-binary warning (REQ-022)
    ...(opts.noUpdate ? ['--no-update'] : []),
    // Rate limiting: 1s between requests to avoid throttling
    '--sleep-requests',
    '1',
    // Retry up to 3 times on extractor failures (transient errors, rate limits)
    '--extractor-retries',
    '3',
    // P0-1: hardened download retries — 403 mitigation (YouTube #14087 etc)
    '--retries',
    String(opts.retries ?? DEFAULT_RETRIES),
    '--fragment-retries',
    String(opts.fragmentRetries ?? DEFAULT_FRAGMENT_RETRIES),
    '--retry-sleep',
    opts.retrySleep ?? DEFAULT_RETRY_SLEEP,
    '--socket-timeout',
    String(opts.socketTimeout ?? DEFAULT_SOCKET_TIMEOUT),
    // P0-2: archive — skip already-downloaded entries; break-on-existing fast-path
    ...(opts.downloadArchive ? ['--download-archive', opts.downloadArchive] : []),
    ...(opts.breakOnExisting && opts.downloadArchive ? ['--break-on-existing'] : []),
    // playlist: per-entry window replaces --no-playlist (D8); unknown-count
    // single run drops --no-playlist entirely (D13)
    ...(opts.playlistIndex
      ? ['--playlist-start', String(opts.playlistIndex), '--playlist-end', String(opts.playlistIndex)]
      : opts.playlist
        ? []
        : ['--no-playlist']),
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
    // video kinds tag the resolution in the filename ([1080p]) so the same
    // video can be downloaded at multiple resolutions without yt-dlp treating
    // the existing file as a collision and refusing to proceed; audio (mp3) is
    // a single option so it keeps the plain title (no resolution makes sense)
    path.join(
      opts.outDir,
      opts.choice.kind === 'audio' ? '%(title).60s.%(ext)s' : '%(title).60s [%(height)sp].%(ext)s',
    ),
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
    activeChildren.add(child)

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let completedBytes = 0
    let currentPartTotal = 0
    let buffer = ''
    // Throttle progress events to max 1 per 100ms — prevents Ink render
    // batching from making the UI feel laggy when yt-dlp emits fast
    let lastProgressTime = 0
    let pendingProgress: DownloadProgress | null = null
    let progressFlushTimer: ReturnType<typeof setTimeout> | null = null
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
          const totalBytes = toNumber(total) ?? toNumber(totalEstimate)
          if (downloadedBytes < lastDownloaded) {
            // new part started — previous part finished, accumulate its total
            completedBytes += currentPartTotal
            part++
          }
          lastDownloaded = downloadedBytes
          currentPartTotal = totalBytes ?? 0
          const prog: DownloadProgress = {
            downloadedBytes: downloadedBytes + completedBytes,
            totalBytes: totalBytes != null ? completedBytes + totalBytes : undefined,
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          }
          const now = Date.now()
          if (now - lastProgressTime >= 100) {
            lastProgressTime = now
            handlers.onProgress(prog)
          } else {
            // buffer latest progress and flush after throttle window
            pendingProgress = prog
            if (!progressFlushTimer) {
              progressFlushTimer = setTimeout(() => {
                progressFlushTimer = null
                if (pendingProgress) {
                  lastProgressTime = Date.now()
                  handlers.onProgress(pendingProgress)
                  pendingProgress = null
                }
              }, 100 - (now - lastProgressTime))
            }
          }
        } else if (line.includes('Downloading ') && line.includes(' format(s):')) {
          // BUG-4: yt-dlp prints "[info] xxx: Downloading 2 format(s): 137+251"
          // for a video+audio merge — the old hardcoded 'Downloading 1 format(s):'
          // never matched "2+", so totalParts stayed 1 and the UI showed
          // "parte n/1" during merges. Count the ids ("137+251" → 2).
          const ids = (line.split('format(s):')[1] ?? '').trim()
          const count = ids.split('+').filter(Boolean).length
          if (count > 0) totalParts = count
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
    child.on('error', error => {
      activeChildren.delete(child)
      reject(error)
    })
    child.on('close', code => {
      activeChildren.delete(child)
      // flush any buffered progress so the final state isn't lost
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer)
        progressFlushTimer = null
      }
      if (pendingProgress) {
        handlers.onProgress(pendingProgress)
        pendingProgress = null
      }
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
