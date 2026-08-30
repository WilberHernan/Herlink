import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {mock} from 'node:test'
import test from 'node:test'
import {
  audioChoice,
  bestChoice,
  buildChoices,
  buildDownloadArgs,
  download,
  ensureYtDlp,
  findFfmpeg,
  isBundledBinary,
  effectiveNoUpdate,
  isPlaylistInfo,
  maybeSelfUpdate,
  playlistOption,
  probe,
  removePartials,
  type DownloadChoice,
  type DownloadHandlers,
  type VideoInfo,
} from './ytdlp.js'
import {playlistItems} from './queue.js'

const PREFIX = '/data/data/com.termux/files/usr'
const noop = () => {}

// Switches the two env vars Termux detection reads, returning a restore fn
// (panel.test.ts style: always restore in finally).
function termuxEnv(on: boolean): () => void {
  const prevPrefix = process.env.PREFIX
  const prevAndroidRoot = process.env.ANDROID_ROOT
  if (on) {
    process.env.PREFIX = PREFIX
    process.env.ANDROID_ROOT = '/system'
  } else {
    delete process.env.PREFIX
    delete process.env.ANDROID_ROOT
  }
  return () => {
    if (prevPrefix === undefined) delete process.env.PREFIX
    else process.env.PREFIX = prevPrefix
    if (prevAndroidRoot === undefined) delete process.env.ANDROID_ROOT
    else process.env.ANDROID_ROOT = prevAndroidRoot
  }
}

// Scopes PATH to a single dir (or an empty string) so binary lookups only
// find the fakes we plant, returning a restore fn.
function withPath(dir: string): () => void {
  const prevPath = process.env.PATH
  process.env.PATH = dir
  return () => {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
  }
}

// Polls a marker file until it holds >= min non-empty lines, returning the
// count. SIGTERM delivery to a fake child is asynchronous, so the kill-all
// test polls instead of asserting immediately.
async function waitForFileLines(file: string, min: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let count = 0
  while (Date.now() < deadline) {
    try {
      count = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length
      if (count >= min) return count
    } catch {
      // marker file not written yet
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timeout: expected >= ${min} lines in ${file}, saw ${count}`)
}

test('ensureYtDlp() on Termux without yt-dlp errors and never downloads', async () => {
  const restoreTermux = termuxEnv(true)
  const restorePath = withPath('/nonexistent')
  try {
    await assert.rejects(ensureYtDlp(noop), /pkg install python-yt-dlp/)
  } finally {
    restorePath()
    restoreTermux()
  }
})

test('ensureYtDlp() resolves a yt-dlp binary on PATH', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  try {
    fs.writeFileSync(path.join(bin, 'yt-dlp'), '#!/bin/sh\necho "2026.01.01"\nexit 0\n', {mode: 0o755})
    const restoreTermux = termuxEnv(true)
    const restorePath = withPath(bin)
    try {
      assert.equal(await ensureYtDlp(noop), 'yt-dlp')
    } finally {
      restorePath()
      restoreTermux()
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('findFfmpeg() on Termux without ffmpeg reports unavailable and hints pkg install ffmpeg (D4)', async () => {
  const restoreTermux = termuxEnv(true)
  const restorePath = withPath('/nonexistent')
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    const status = await findFfmpeg()
    assert.deepEqual(status, {available: false})
    assert.equal(writeMock.mock.callCount(), 1)
    assert.match(String(writeMock.mock.calls[0]?.arguments[0]), /pkg install ffmpeg/)
  } finally {
    writeMock.mock.restore()
    restorePath()
    restoreTermux()
  }
})

test('findFfmpeg() on Termux with ffmpeg on PATH reports available with no location and no hint (D4)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  try {
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
    const restoreTermux = termuxEnv(true)
    const restorePath = withPath(bin)
    const writeMock = mock.method(process.stderr, 'write', () => true)
    try {
      const status = await findFfmpeg()
      // PATH ffmpeg: available, but no location — yt-dlp finds it itself
      assert.deepEqual(status, {available: true})
      assert.equal(writeMock.mock.callCount(), 0)
    } finally {
      writeMock.mock.restore()
      restorePath()
      restoreTermux()
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

const choice: DownloadChoice = {label: '1080p · mp4', kind: 'video', args: ['-f', 'bv*+ba/b']}

const VIDEO_INFO: VideoInfo = {
  title: 'test',
  formats: [
    {format_id: '1', vcodec: 'avc1', acodec: 'mp4a', height: 720, ext: 'mp4'},
    {format_id: '2', vcodec: 'avc1', acodec: 'none', height: 1080, ext: 'mp4'},
    {format_id: '3', acodec: 'mp4a', vcodec: 'none', abr: 128, ext: 'm4a'},
  ],
}

test('isPlaylistInfo() detects playlists via extractor_key, _type and playlist_id (D7)', () => {
  // --no-playlist first-entry JSON keeps extractor_key "Youtube" — the
  // playlist_id is the reliable signal (D7)
  assert.equal(isPlaylistInfo({title: 'x', extractor_key: 'Youtube', playlist_id: 'PL123'}), true)
  assert.equal(isPlaylistInfo({title: 'x', extractor_key: 'Youtube:playlist'}), true)
  assert.equal(isPlaylistInfo({title: 'x', _type: 'playlist'}), true)
})

test('isPlaylistInfo() returns false for a plain single video', () => {
  assert.equal(isPlaylistInfo({title: 'x'}), false)
  assert.equal(isPlaylistInfo({title: 'x', extractor_key: 'Youtube'}), false)
  assert.equal(isPlaylistInfo({title: 'x', _type: 'video'}), false)
})

test('playlistOption() labels the playlist choice with the count (REQ-018)', () => {
  assert.deepEqual(playlistOption({title: 'x', playlist_id: 'PL123', playlist_count: 5}), {
    label: 'descargar los 5 videos',
    count: 5,
  })
  assert.equal(playlistOption({title: 'x'}), undefined, 'single videos get no playlist option')
})

test('playlistOption() falls back to a generic label when the count is unknown (D13)', () => {
  assert.deepEqual(playlistOption({title: 'x', extractor_key: 'X:playlist'}), {
    label: 'descargar todos los videos',
    count: undefined,
  })
})

test('playlistItems() expands a playlist url into per-entry items with 1-based indexes (D8)', () => {
  assert.deepEqual(playlistItems('https://example.com/pl', 3), [
    {url: 'https://example.com/pl', playlistIndex: 1},
    {url: 'https://example.com/pl', playlistIndex: 2},
    {url: 'https://example.com/pl', playlistIndex: 3},
  ])
  assert.deepEqual(playlistItems('https://example.com/pl', 1), [{url: 'https://example.com/pl', playlistIndex: 1}])
})

test('playlistItems() with a zero count yields no items (REQ-019)', () => {
  assert.deepEqual(playlistItems('https://example.com/pl', 0), [])
})

test('bestChoice() returns the top video and audioChoice() the mp3 option', () => {
  const best = bestChoice(VIDEO_INFO)
  assert.equal(best.kind, 'video')
  assert.ok(best.args.some(a => a.includes('1080')), 'top fixture height must be the best choice')
  // no formats at all — falls back to the "mejor disponible" video choice
  assert.equal(bestChoice({title: 'sin formatos'}).kind, 'video')
  const audio = audioChoice(VIDEO_INFO)
  assert.equal(audio.kind, 'audio')
  assert.ok(audio.args.includes('-x'))
  assert.ok(audio.args.includes('mp3'))
})

test('buildChoices() labels VP9-only heights as mkv not mp4 (BUG-1: no H.264 above 1080p on YouTube)', () => {
  // A 2160p format that is VP9-only cannot be merged into MP4 (`[mov] vp9 only
  // supported in MP4` — yt-dlp #10500). It must surface as mkv so the download
  // actually succeeds instead of failing at the merge step.
  const info: VideoInfo = {
    title: 'vp9-2160',
    formats: [
      {format_id: '10', vcodec: 'vp09', vcodec_name: 'vp9', acodec: 'none', height: 2160, ext: 'webm'},
      {format_id: '11', vcodec: 'avc1', acodec: 'none', height: 1080, ext: 'mp4'},
      {format_id: '12', acodec: 'mp4a', vcodec: 'none', abr: 128, ext: 'm4a'},
    ],
  }
  const choices = buildChoices(info)
  const vp9 = choices.find(c => c.kind === 'video' && c.label.includes('2160'))
  assert.ok(vp9, '2160p choice must exist')
  assert.ok(vp9.label.includes('mkv'), `2160p label must say mkv, got: ${vp9.label}`)
  assert.ok(vp9.args.includes('--merge-output-format') && vp9.args.includes('mkv'), 'VP9 choice must merge to mkv')
  const h264 = choices.find(c => c.kind === 'video' && c.label.includes('1080'))
  assert.ok(h264.label.includes('mp4'), '1080p H.264 choice must stay mp4')
  assert.ok(h264.args.includes('mp4'), 'H.264 choice must merge to mp4')
})

test('buildChoices() without ffmpeg offers pre-muxed video and native audio (BUG-3)', () => {
  const info: VideoInfo = {
    title: 'no-ffmpeg',
    formats: [
      {format_id: '1', vcodec: 'avc1', acodec: 'mp4a', height: 720, ext: 'mp4'},
      {format_id: '3', acodec: 'mp4a', vcodec: 'none', abr: 128, ext: 'm4a'},
    ],
  }
  const choices = buildChoices(info, {available: false, reason: 'missing'})
  const video = choices.find(c => c.kind === 'video')!
  // without ffmpeg the video must use a pre-muxed leg (b), not bv*+ba (merge)
  const fIdx = video.args.indexOf('-f')
  assert.ok(video.args[fIdx + 1]!.includes('/b'), `video must avoid merge without ffmpeg: ${video.args[fIdx + 1]}`)
  assert.ok(!video.args[fIdx + 1]!.includes('+'), `video must not request a merge without ffmpeg: ${video.args[fIdx + 1]}`)
  const audio = choices.find(c => c.kind === 'audio')!
  assert.ok(!audio.args.includes('-x'), 'no ffmpeg means no mp3 transcode (-x)')
  assert.ok(!audio.label.includes('mp3'), 'audio label must not claim mp3 without ffmpeg')
  // with ffmpeg the normal merge/mp3 behavior is preserved
  const withFmpeg = buildChoices(info, {available: true})
  const audioWith = withFmpeg.find(c => c.kind === 'audio')!
  assert.ok(audioWith.args.includes('-x') && audioWith.label.includes('mp3'), 'ffmpeg present keeps mp3')
})

test('buildDownloadArgs() adds --restrict-filenames on Termux shared storage', () => {
  const restoreTermux = termuxEnv(true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'storage', 'downloads'),
      ffmpeg: {available: false},
    })
    assert.ok(args.includes('--restrict-filenames'))
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() skips --restrict-filenames on Termux outside shared storage', () => {
  const restoreTermux = termuxEnv(true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: false},
    })
    assert.ok(!args.includes('--restrict-filenames'))
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() on desktop is unchanged (no --restrict-filenames)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
      },
    )
    // golden array — pins the exact desktop argument sequence so any future
    // reordering, drop, or unconditional insertion fails this test (REQ-08)
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--no-quiet',
      '--progress',
      '--progress-template',
      'download:HERLINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print',
      'after_move:filepath',
      '--no-simulate',
      '-o',
      path.join(os.homedir(), 'Downloads', '%(title).60s.%(ext)s'),
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() adds --continue after the choice args when resume is set', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
        resume: true,
      },
    )
    // golden array — --continue lands right after choice.args, before the tail
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      '--continue',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--no-quiet',
      '--progress',
      '--progress-template',
      'download:HERLINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print',
      'after_move:filepath',
      '--no-simulate',
      '-o',
      path.join(os.homedir(), 'Downloads', '%(title).60s.%(ext)s'),
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() inserts --cookies right after the url when cookies are set', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
        cookies: '/tmp/cookies.txt',
      },
    )
    // golden array — --cookies <file> lands between the url and choice.args
    assert.deepEqual(args, [
      'https://example.com/v',
      '--cookies',
      '/tmp/cookies.txt',
      '-f',
      'bv*+ba/b',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--no-quiet',
      '--progress',
      '--progress-template',
      'download:HERLINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print',
      'after_move:filepath',
      '--no-simulate',
      '-o',
      path.join(os.homedir(), 'Downloads', '%(title).60s.%(ext)s'),
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() keeps a cookies path starting with "-" as its own argv element', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: false},
      cookies: '-strange-cookies',
    })
    // spawn() receives separate argv elements — never a merged "--cookies=-x"
    const flagIndex = args.indexOf('--cookies')
    assert.notEqual(flagIndex, -1, '--cookies must be present')
    assert.equal(args[flagIndex + 1], '-strange-cookies')
  } finally {
    restoreTermux()
  }
})

test('removePartials() deletes dest and .ytdl but keeps .part (REQ-006)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-partials-'))
  try {
    const dest = path.join(dir, 'video.mp4')
    fs.writeFileSync(dest, 'complete')
    fs.writeFileSync(`${dest}.part`, 'partial-data')
    fs.writeFileSync(`${dest}.ytdl`, 'resume-meta')
    await removePartials([dest])
    assert.equal(fs.existsSync(dest), false)
    assert.equal(fs.existsSync(`${dest}.ytdl`), false)
    assert.equal(fs.existsSync(`${dest}.part`), true)
    assert.equal(fs.readFileSync(`${dest}.part`, 'utf8'), 'partial-data')
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('probe() passes --cookies <file> to the yt-dlp argv (REQ-007)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const argsOut = path.join(bin, 'args.txt')
  try {
    fs.writeFileSync(
      path.join(bin, 'fake-ytdlp'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_OUT"\nprintf \'{"title":"fake"}\'\n',
      {mode: 0o755},
    )
    const prev = process.env.FAKE_ARGS_OUT
    process.env.FAKE_ARGS_OUT = argsOut
    try {
      const {info, infoJsonPath} = await probe(
        path.join(bin, 'fake-ytdlp'),
        'https://example.com/v',
        undefined,
        '/tmp/cookies.txt',
      )
      assert.equal(info.title, 'fake')
      const argv = fs.readFileSync(argsOut, 'utf8').trim().split('\n')
      assert.ok(argv.includes('--cookies'))
      assert.equal(argv[argv.indexOf('--cookies') + 1], '/tmp/cookies.txt')
      await fs.promises.rm(infoJsonPath, {force: true})
    } finally {
      if (prev === undefined) delete process.env.FAKE_ARGS_OUT
      else process.env.FAKE_ARGS_OUT = prev
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('probe() omits --cookies when none are given', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const argsOut = path.join(bin, 'args.txt')
  try {
    fs.writeFileSync(
      path.join(bin, 'fake-ytdlp'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_OUT"\nprintf \'{"title":"fake"}\'\n',
      {mode: 0o755},
    )
    const prev = process.env.FAKE_ARGS_OUT
    process.env.FAKE_ARGS_OUT = argsOut
    try {
      const {info, infoJsonPath} = await probe(path.join(bin, 'fake-ytdlp'), 'https://example.com/v')
      assert.equal(info.title, 'fake')
      const argv = fs.readFileSync(argsOut, 'utf8').trim().split('\n')
      assert.ok(!argv.includes('--cookies'))
      await fs.promises.rm(infoJsonPath, {force: true})
    } finally {
      if (prev === undefined) delete process.env.FAKE_ARGS_OUT
      else process.env.FAKE_ARGS_OUT = prev
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

const AUDIO_CHOICE: DownloadChoice = {
  label: 'solo audio · mp3',
  kind: 'audio',
  args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
}

const DESKTOP_TAIL = [
  // Rate limiting and retry for reliability
  '--sleep-requests',
  '1',
  '--extractor-retries',
  '3',
  '--no-playlist',
  '--no-warnings',
  '--newline',
  '--no-quiet',
  '--progress',
  '--progress-template',
  'download:HERLINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
  '--print',
  'after_move:filepath',
  '--no-simulate',
  '-o',
  path.join(os.homedir(), 'Downloads', '%(title).60s.%(ext)s'),
]

test('buildDownloadArgs() embeds metadata + thumbnail with ffmpeg and passes --ffmpeg-location (REQ-009)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: true, location: '/usr/bin/ffmpeg'},
        embedMetadata: true,
      },
    )
    // golden array — embed block lands between choice.args and the tail;
    // --ffmpeg-location comes from ffmpeg.location at the very end
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      '--embed-metadata',
      '--embed-thumbnail',
      ...DESKTOP_TAIL,
      '--ffmpeg-location',
      '/usr/bin/ffmpeg',
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() skips embed flags without ffmpeg and warns on stderr (REQ-011)', () => {
  const restoreTermux = termuxEnv(false)
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: false},
      embedMetadata: true,
    })
    assert.ok(!args.includes('--embed-metadata'), 'embed flags must be skipped, not passed to yt-dlp')
    assert.ok(!args.includes('--embed-thumbnail'))
    assert.equal(writeMock.mock.callCount(), 1)
    assert.match(String(writeMock.mock.calls[0]?.arguments[0]), /Ffmpeg/)
  } finally {
    writeMock.mock.restore()
    restoreTermux()
  }
})

test('buildDownloadArgs() omits embed flags when embedMetadata is off even with ffmpeg (REQ-010)', () => {
  const restoreTermux = termuxEnv(false)
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: true},
      embedMetadata: false,
    })
    // the off-switch resolved at parse (D3) — nothing to embed, no warn
    assert.ok(!args.includes('--embed-metadata'))
    assert.ok(!args.includes('--embed-thumbnail'))
    assert.equal(writeMock.mock.callCount(), 0)
  } finally {
    writeMock.mock.restore()
    restoreTermux()
  }
})

test('buildDownloadArgs() writes --write-subs --sub-langs and --embed-subs with ffmpeg (REQ-012/013)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: true},
        subs: 'es,en',
      },
    )
    // golden array — subs block lands between choice.args and the tail
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      '--write-subs',
      '--sub-langs',
      'es,en',
      '--embed-subs',
      ...DESKTOP_TAIL,
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() --subs with no langs writes --write-subs only plus --embed-subs (REQ-012)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: true},
      subs: '',
    })
    assert.ok(args.includes('--write-subs'))
    assert.ok(!args.includes('--sub-langs'), 'no langs → all auto-downloadable subs')
    assert.ok(args.includes('--embed-subs'))
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() omits --embed-subs without ffmpeg and warns (REQ-013)', () => {
  const restoreTermux = termuxEnv(false)
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: false},
      subs: 'es',
    })
    // subs still download — only embedding is skipped
    assert.ok(args.includes('--write-subs'))
    assert.ok(args.includes('--sub-langs'))
    assert.equal(args[args.indexOf('--sub-langs') + 1], 'es')
    assert.ok(!args.includes('--embed-subs'))
    assert.equal(writeMock.mock.callCount(), 1)
    assert.match(String(writeMock.mock.calls[0]?.arguments[0]), /Ffmpeg/)
  } finally {
    writeMock.mock.restore()
    restoreTermux()
  }
})

test('buildDownloadArgs() adds no subs flags for an audio-only choice (REQ-014)', () => {
  const restoreTermux = termuxEnv(false)
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice: AUDIO_CHOICE,
      outDir: path.join(os.homedir(), 'Downloads'),
      ffmpeg: {available: true},
      subs: 'es',
    })
    assert.ok(!args.includes('--write-subs'))
    assert.ok(!args.includes('--sub-langs'))
    assert.ok(!args.includes('--embed-subs'))
    assert.equal(writeMock.mock.callCount(), 0, 'audio-only must not warn either')
  } finally {
    writeMock.mock.restore()
    restoreTermux()
  }
})

test('buildDownloadArgs() pins the full block order: cookies, choice, resume, subs, embed (D5)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: true},
        resume: true,
        cookies: '/tmp/cookies.txt',
        embedMetadata: true,
        subs: 'es',
      },
    )
    assert.deepEqual(args, [
      'https://example.com/v',
      '--cookies',
      '/tmp/cookies.txt',
      '-f',
      'bv*+ba/b',
      '--continue',
      '--write-subs',
      '--sub-langs',
      'es',
      '--embed-subs',
      '--embed-metadata',
      '--embed-thumbnail',
      ...DESKTOP_TAIL,
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() with a playlistIndex pins --playlist-start/end and omits --no-playlist (D8)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/pl',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
        playlistIndex: 2,
      },
    )
    // golden array — the playlist window replaces --no-playlist in place
    assert.deepEqual(args, [
      'https://example.com/pl',
      '-f',
      'bv*+ba/b',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      '--playlist-start',
      '2',
      '--playlist-end',
      '2',
      ...DESKTOP_TAIL.slice(DESKTOP_TAIL.indexOf('--no-warnings')),
    ])
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() in playlist mode without an index downloads the whole playlist in one run (D13)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/pl',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
        playlist: true,
      },
    )
    // D13: playlist_count unknown — single yt-dlp run, no --no-playlist and
    // no per-entry window
    assert.deepEqual(args, [
      'https://example.com/pl',
      '-f',
      'bv*+ba/b',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      ...DESKTOP_TAIL.slice(DESKTOP_TAIL.indexOf('--no-warnings')),
    ])
  } finally {
    restoreTermux()
  }
})

test('isBundledBinary() identifies only the ~/.herlink/bin copy (REQ-020)', () => {
  // the bundled standalone binary lives under ~/.herlink/bin (call-time HOME
  // read, termux.ts style)
  assert.equal(isBundledBinary(path.join(os.homedir(), '.herlink', 'bin', 'yt-dlp')), true)
  assert.equal(isBundledBinary(path.join(os.homedir(), '.herlink', 'bin', 'yt-dlp.exe')), true, 'win32 name')
  assert.equal(isBundledBinary('yt-dlp'), false, 'PATH resolution result is never bundled')
  assert.equal(isBundledBinary('/usr/local/bin/yt-dlp'), false, 'a user-managed copy is not bundled')
})

test('effectiveNoUpdate() adds --no-update for the bundled binary (REQ-022 s2)', () => {
  const bundled = path.join(os.homedir(), '.herlink', 'bin', 'yt-dlp')
  const pathBinary = '/usr/local/bin/yt-dlp'
  // bundled → true regardless of the user flag (herlink manages freshness)
  assert.equal(effectiveNoUpdate(false, bundled), true)
  assert.equal(effectiveNoUpdate(true, bundled), true)
  // PATH copy → only the explicit user flag
  assert.equal(effectiveNoUpdate(false, pathBinary), false)
  assert.equal(effectiveNoUpdate(true, pathBinary), true)
})

// Plants a fake yt-dlp at <tmpHome>/.herlink/bin/yt-dlp and points $HOME at
// <tmpHome> so the bundled-path guard resolves to the fake (call-time read).
// Forces desktop env — Termux installs must never self-update (REQ-020).
// Returns a restore fn that always runs in finally.
function withFakeBundledBinary(script: string): {binary: string; restore: () => void} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-home-'))
  const binDir = path.join(home, '.herlink', 'bin')
  fs.mkdirSync(binDir, {recursive: true})
  const binary = path.join(binDir, 'yt-dlp')
  fs.writeFileSync(binary, script, {mode: 0o755})
  const prevHome = process.env.HOME
  process.env.HOME = home
  const restoreTermux = termuxEnv(false)
  return {
    binary,
    restore: () => {
      restoreTermux()
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      fs.rmSync(home, {recursive: true, force: true})
    },
  }
}

test('maybeSelfUpdate() skips a PATH yt-dlp without running -U (REQ-020)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const argsOut = path.join(bin, 'args.txt')
  try {
    fs.writeFileSync(
      path.join(bin, 'yt-dlp'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_OUT"\necho "yt-dlp is up to date (x)"\nexit 0\n',
      {mode: 0o755},
    )
    const prev = process.env.FAKE_ARGS_OUT
    process.env.FAKE_ARGS_OUT = argsOut
    const restorePath = withPath(bin)
    const restoreTermux = termuxEnv(false)
    try {
      const result = await maybeSelfUpdate('yt-dlp')
      assert.deepEqual(result, {checked: false, reason: 'not-bundled'})
      assert.equal(fs.existsSync(argsOut), false, '-U must never run for a PATH binary')
    } finally {
      restoreTermux()
      restorePath()
      if (prev === undefined) delete process.env.FAKE_ARGS_OUT
      else process.env.FAKE_ARGS_OUT = prev
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('maybeSelfUpdate() skips a Termux pkg install without running -U (REQ-020)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const argsOut = path.join(bin, 'args.txt')
  try {
    fs.writeFileSync(
      path.join(bin, 'yt-dlp'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_OUT"\necho "yt-dlp is up to date (x)"\nexit 0\n',
      {mode: 0o755},
    )
    const prev = process.env.FAKE_ARGS_OUT
    process.env.FAKE_ARGS_OUT = argsOut
    const restorePath = withPath(bin)
    const restoreTermux = termuxEnv(true)
    try {
      const result = await maybeSelfUpdate('yt-dlp')
      assert.deepEqual(result, {checked: false, reason: 'termux'})
      assert.equal(fs.existsSync(argsOut), false, '-U must never run for a Termux pkg install')
    } finally {
      restoreTermux()
      restorePath()
      if (prev === undefined) delete process.env.FAKE_ARGS_OUT
      else process.env.FAKE_ARGS_OUT = prev
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('maybeSelfUpdate() reports checked when the bundled binary is up to date, silently (REQ-021)', async () => {
  const fake = withFakeBundledBinary('#!/bin/sh\necho "yt-dlp is up to date (2026.01.01)"\nexit 0\n')
  const statuses: string[] = []
  try {
    const result = await maybeSelfUpdate(fake.binary, status => statuses.push(status))
    assert.deepEqual(result, {checked: true})
    assert.equal(statuses.length, 0, 'up to date must stay silent')
  } finally {
    fake.restore()
  }
})

test('maybeSelfUpdate() reports the new version and emits status when updated (REQ-021)', async () => {
  const fake = withFakeBundledBinary('#!/bin/sh\necho "Updated yt-dlp to 2026.08.10"\nexit 0\n')
  const statuses: string[] = []
  try {
    const result = await maybeSelfUpdate(fake.binary, status => statuses.push(status))
    assert.deepEqual(result, {checked: true, updated: '2026.08.10'})
    assert.equal(statuses.length, 1, 'the update status must surface once')
    assert.match(statuses[0]!, /2026\.08\.10/)
  } finally {
    fake.restore()
  }
})

test('maybeSelfUpdate() treats a non-zero exit as a silent failure (REQ-020)', async () => {
  const fake = withFakeBundledBinary('#!/bin/sh\necho "ERROR: network is down"\nexit 1\n')
  const statuses: string[] = []
  try {
    const result = await maybeSelfUpdate(fake.binary, status => statuses.push(status))
    assert.deepEqual(result, {checked: false, reason: 'failed'})
    assert.equal(statuses.length, 0, 'a failed update must stay silent')
  } finally {
    fake.restore()
  }
})

test('maybeSelfUpdate() treats a pip-installed binary as a silent failure', async () => {
  // a pip/wheel install cannot self-update — yt-dlp says so and exits 0;
  // the message is the reliable signal, never a crash
  const fake = withFakeBundledBinary(
    '#!/bin/sh\necho "It looks like you installed yt-dlp with a package manager, please use that to update"\nexit 0\n',
  )
  const statuses: string[] = []
  try {
    const result = await maybeSelfUpdate(fake.binary, status => statuses.push(status))
    assert.deepEqual(result, {checked: false, reason: 'failed'})
    assert.equal(statuses.length, 0)
  } finally {
    fake.restore()
  }
})

test('maybeSelfUpdate() never throws when the bundled binary is missing (REQ-020)', async () => {
  // bundled path guard passes on the path string, but the file does not exist
  // → spawn error must fall back silently, never crash startup
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-home-'))
  const prevHome = process.env.HOME
  process.env.HOME = home
  const restoreTermux = termuxEnv(false)
  try {
    const result = await maybeSelfUpdate(path.join(home, '.herlink', 'bin', 'yt-dlp'))
    assert.deepEqual(result, {checked: false, reason: 'failed'})
  } finally {
    restoreTermux()
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(home, {recursive: true, force: true})
  }
})

test('buildDownloadArgs() adds --no-update after the choice args when requested (REQ-022)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs(
      {
        url: 'https://example.com/v',
        choice,
        outDir: path.join(os.homedir(), 'Downloads'),
        ffmpeg: {available: false},
        noUpdate: true,
      },
    )
    // golden array — --no-update lands between choice.args and the tail,
    // suppressing yt-dlp's 90-day stale warning (REQ-022)
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      '--no-update',
      // Rate limiting and retry for reliability
      '--sleep-requests',
      '1',
      '--extractor-retries',
      '3',
      ...DESKTOP_TAIL.slice(DESKTOP_TAIL.indexOf('--no-playlist')),
    ])
  } finally {
    restoreTermux()
  }
})

test('probe() passes --no-update to the yt-dlp argv (REQ-022)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const argsOut = path.join(bin, 'args.txt')
  try {
    fs.writeFileSync(
      path.join(bin, 'fake-ytdlp'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_ARGS_OUT"\nprintf \'{"title":"fake"}\'\n',
      {mode: 0o755},
    )
    const prev = process.env.FAKE_ARGS_OUT
    process.env.FAKE_ARGS_OUT = argsOut
    try {
      const fake = path.join(bin, 'fake-ytdlp')
      const withFlag = await probe(fake, 'https://example.com/v', undefined, undefined, true)
      const argv = fs.readFileSync(argsOut, 'utf8').trim().split('\n')
      assert.ok(argv.includes('--no-update'), 'probe must carry --no-update when requested')
      assert.equal(argv.at(-1), 'https://example.com/v', 'the url must stay the last argv element')
      await fs.promises.rm(withFlag.infoJsonPath, {force: true})

      const withoutFlag = await probe(fake, 'https://example.com/v')
      const plainArgv = fs.readFileSync(argsOut, 'utf8').trim().split('\n')
      assert.ok(!plainArgv.includes('--no-update'), 'no --no-update without the flag')
      await fs.promises.rm(withoutFlag.infoJsonPath, {force: true})
    } finally {
      if (prev === undefined) delete process.env.FAKE_ARGS_OUT
      else process.env.FAKE_ARGS_OUT = prev
    }
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('process exit kills every live child and skips completed ones (REQ-par-018)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const startedFile = path.join(bin, 'started.log')
  const termFile = path.join(bin, 'term.log')
  const prevStarted = process.env.FAKE_STARTED_FILE
  const prevTerm = process.env.FAKE_TERM_FILE
  const prevFast = process.env.FAKE_EXIT_FAST
  try {
    // fake yt-dlp as a real program (not a shell — Android mksh defers traps
    // while waiting on a foreground child, so a shell fake would never
    // observe SIGTERM in the test window): appends a "started" marker, traps
    // SIGTERM into a "term" marker synchronously, exits fast (printing valid
    // JSON) when FAKE_EXIT_FAST=1, else stays alive until the exit handler
    // kills it
    fs.writeFileSync(
      path.join(bin, 'fake-ytdlp'),
      [
        '#!/data/data/com.termux/files/usr/bin/node',
        'const fs = require("node:fs")',
        'fs.appendFileSync(process.env.FAKE_STARTED_FILE, "started\\n")',
        'process.on("SIGTERM", () => {',
        '  fs.appendFileSync(process.env.FAKE_TERM_FILE, "term\\n")',
        '  process.exit(0)',
        '})',
        'if (process.env.FAKE_EXIT_FAST === "1") {',
        '  process.stdout.write(\'{"title":"fake"}\')',
        '  process.exit(0)',
        '}',
        'setInterval(() => {}, 1000)',
      ].join('\n'),
      {mode: 0o755},
    )
    process.env.FAKE_STARTED_FILE = startedFile
    process.env.FAKE_TERM_FILE = termFile
    delete process.env.FAKE_EXIT_FAST

    const fake = path.join(bin, 'fake-ytdlp')
    // two children that must stay alive: one probe, one download
    const aliveProbe = probe(fake, 'https://a.example/v').catch(() => {})
    const aliveDownload = download(
      {ytdlp: fake, url: 'https://b.example/v', choice, outDir: '/tmp/Downloads', ffmpeg: {available: false}},
      {onProgress: noop, onProcessing: noop},
    ).catch(() => {})
    await waitForFileLines(startedFile, 2)

    // one child that completes before the exit — its close must remove it
    // from the Set so the exit handler never SIGTERMs a dead pid (s2)
    process.env.FAKE_EXIT_FAST = '1'
    const {infoJsonPath} = await probe(fake, 'https://c.example/v')
    delete process.env.FAKE_EXIT_FAST
    assert.equal(await waitForFileLines(startedFile, 3), 3)

    process.emit('exit')

    assert.equal(await waitForFileLines(termFile, 2), 2, 'both live children must receive SIGTERM')
    const terms = fs.readFileSync(termFile, 'utf8').split('\n').filter(Boolean).length
    assert.equal(terms, 2, 'the completed child must not be killed')
    await aliveProbe
    await aliveDownload
    await fs.promises.rm(infoJsonPath, {force: true})
  } finally {
    if (prevStarted === undefined) delete process.env.FAKE_STARTED_FILE
    else process.env.FAKE_STARTED_FILE = prevStarted
    if (prevTerm === undefined) delete process.env.FAKE_TERM_FILE
    else process.env.FAKE_TERM_FILE = prevTerm
    if (prevFast === undefined) delete process.env.FAKE_EXIT_FAST
    else process.env.FAKE_EXIT_FAST = prevFast
    fs.rmSync(bin, {recursive: true, force: true})
  }
})

test('probe() writes a nonced tmpfile so two same-ms probes never collide (REQ-par-002 s2)', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  const nowMock = mock.method(Date, 'now', () => 1_700_000_000_000)
  try {
    fs.writeFileSync(path.join(bin, 'fake-ytdlp'), '#!/bin/sh\nprintf \'{"title":"fake"}\'\n', {mode: 0o755})
    const [a, b] = await Promise.all([
      probe(path.join(bin, 'fake-ytdlp'), 'https://a.example/v'),
      probe(path.join(bin, 'fake-ytdlp'), 'https://b.example/v'),
    ])
    assert.notEqual(a.infoJsonPath, b.infoJsonPath, 'identical pid+ts must still yield distinct tmpfiles')
    for (const {infoJsonPath} of [a, b]) {
      assert.match(
        path.basename(infoJsonPath),
        new RegExp(`^herlink-info-${process.pid}-\\d+-[0-9a-f]{8}\\.json$`),
        'tmpfile must carry pid, ts and an 8-hex nonce',
      )
      const parsed = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'))
      assert.equal(parsed.title, 'fake', 'each probe must write its own parseable info file')
    }
    await fs.promises.rm(a.infoJsonPath, {force: true})
    await fs.promises.rm(b.infoJsonPath, {force: true})
  } finally {
    nowMock.mock.restore()
    fs.rmSync(bin, {recursive: true, force: true})
  }
})
