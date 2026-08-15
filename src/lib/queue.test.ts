import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {mock} from 'node:test'
import test from 'node:test'
import {runQueue, runScriptable} from './queue.js'
import type {DownloadArgs, DownloadChoice, VideoInfo} from './ytdlp.js'

const choice: DownloadChoice = {label: '1080p · mp4', kind: 'video', args: ['-f', 'bv*+ba/b']}
const info = (title = 'video'): VideoInfo => ({title})

test('runQueue probes and downloads a single item in order, aggregating the filepath', async () => {
  const calls: string[] = []
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', choiceFor: () => choice},
    {
      probe: async () => {
        calls.push('probe')
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        calls.push(`download:${opts.url}`)
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.deepEqual(calls, ['probe', 'download:https://example.com/v'])
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/video.mp4'])
  assert.equal(outcome.errors.length, 0)
  assert.equal(outcome.cancelled, false)
})

test('runQueue retries with a fresh extraction when the cached-info download fails', async () => {
  let downloads = 0
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', choiceFor: () => choice},
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads++
        if (opts.infoJsonPath) throw new Error('media expirada')
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.equal(downloads, 2)
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/video.mp4'])
  assert.equal(outcome.errors.length, 0)
})

test('runScriptable creates the outDir, downloads with the best choice, and prints the filepath', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-out-'))
  const log = mock.method(console, 'log', () => {})
  try {
    const outDir = path.join(tmp, 'videos')
    const outcome = await runScriptable(
      'yt-dlp',
      [{url: 'https://example.com/v'}],
      {outDir, scriptable: 'best'},
      {
        probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
        download: async (opts: DownloadArgs & {ytdlp: string}) => path.join(outDir, 'v.mp4'),
        findFfmpeg: async () => undefined,
      },
    )
    assert.ok(fs.existsSync(outDir), 'runScriptable must create the outDir')
    assert.deepEqual(outcome.filepaths, [path.join(outDir, 'v.mp4')])
    assert.equal(log.mock.callCount(), 1)
    assert.equal(String(log.mock.calls[0]?.arguments[0]), path.join(outDir, 'v.mp4'))
  } finally {
    log.mock.restore()
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})

test('runScriptable with --mp3 downloads the audio choice', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-out-'))
  const log = mock.method(console, 'log', () => {})
  let seenArgs: string[] = []
  try {
    const outDir = path.join(tmp, 'musica')
    await runScriptable(
      'yt-dlp',
      [{url: 'https://example.com/v'}],
      {outDir, scriptable: 'mp3'},
      {
        probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
        download: async (opts: DownloadArgs & {ytdlp: string}) => {
          seenArgs = opts.choice.args
          return path.join(outDir, 'v.mp3')
        },
        findFfmpeg: async () => undefined,
      },
    )
    assert.ok(seenArgs.includes('-x'), 'audio choice must extract')
    assert.ok(seenArgs.includes('mp3'), 'audio choice must target mp3')
  } finally {
    log.mock.restore()
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})
