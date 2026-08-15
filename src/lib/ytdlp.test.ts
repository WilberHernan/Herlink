import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {mock} from 'node:test'
import test from 'node:test'
import {buildDownloadArgs, ensureYtDlp, findFfmpeg, type DownloadChoice} from './ytdlp.js'

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
