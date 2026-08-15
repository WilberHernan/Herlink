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
  ensureYtDlp,
  findFfmpeg,
  probe,
  removePartials,
  type DownloadChoice,
  type VideoInfo,
} from './ytdlp.js'

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

test('findFfmpeg() on Termux without ffmpeg returns undefined and hints pkg install ffmpeg', async () => {
  const restoreTermux = termuxEnv(true)
  const restorePath = withPath('/nonexistent')
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    assert.equal(await findFfmpeg(), undefined)
    assert.equal(writeMock.mock.callCount(), 1)
    assert.match(String(writeMock.mock.calls[0]?.arguments[0]), /pkg install ffmpeg/)
  } finally {
    writeMock.mock.restore()
    restorePath()
    restoreTermux()
  }
})

test('findFfmpeg() on Termux with ffmpeg on PATH returns undefined without a hint', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-bin-'))
  try {
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
    const restoreTermux = termuxEnv(true)
    const restorePath = withPath(bin)
    const writeMock = mock.method(process.stderr, 'write', () => true)
    try {
      assert.equal(await findFfmpeg(), undefined)
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

test('buildDownloadArgs() adds --restrict-filenames on Termux shared storage', () => {
  const restoreTermux = termuxEnv(true)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'storage', 'downloads'),
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
    })
    assert.ok(!args.includes('--restrict-filenames'))
  } finally {
    restoreTermux()
  }
})

test('buildDownloadArgs() on desktop is unchanged (no --restrict-filenames)', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
    })
    // golden array — pins the exact desktop argument sequence so any future
    // reordering, drop, or unconditional insertion fails this test (REQ-08)
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
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
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      resume: true,
    })
    // golden array — --continue lands right after choice.args, before the tail
    assert.deepEqual(args, [
      'https://example.com/v',
      '-f',
      'bv*+ba/b',
      '--continue',
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
    const args = buildDownloadArgs({
      url: 'https://example.com/v',
      choice,
      outDir: path.join(os.homedir(), 'Downloads'),
      cookies: '/tmp/cookies.txt',
    })
    // golden array — --cookies <file> lands between the url and choice.args
    assert.deepEqual(args, [
      'https://example.com/v',
      '--cookies',
      '/tmp/cookies.txt',
      '-f',
      'bv*+ba/b',
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
