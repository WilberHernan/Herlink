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
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => choice},
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
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => choice},
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
        findFfmpeg: async () => ({available: false}),
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
        findFfmpeg: async () => ({available: false}),
      },
    )
    assert.ok(seenArgs.includes('-x'), 'audio choice must extract')
    assert.ok(seenArgs.includes('mp3'), 'audio choice must target mp3')
  } finally {
    log.mock.restore()
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})

test('runQueue threads resume, cookies, embedMetadata and subs into probe and download', async () => {
  let seenProbeCookies: string | undefined
  let seenDownload: DownloadArgs | undefined
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: true, location: '/usr/bin/ffmpeg'},
      resume: true,
      cookies: '/tmp/cookies.txt',
      embedMetadata: true,
      subs: 'es,en',
      choiceFor: () => choice,
    },
    {
      probe: async (_ytdlp, _url, _signal, cookies) => {
        seenProbeCookies = cookies
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        seenDownload = opts
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.equal(outcome.filepaths.length, 1)
  assert.equal(seenProbeCookies, '/tmp/cookies.txt', 'probe must receive cookies for auth')
  assert.equal(seenDownload?.resume, true, 'download must receive resume')
  assert.equal(seenDownload?.cookies, '/tmp/cookies.txt', 'download must receive cookies')
  assert.equal(seenDownload?.embedMetadata, true, 'download must receive embedMetadata')
  assert.equal(seenDownload?.subs, 'es,en', 'download must receive subs')
})

test('runScriptable threads resume, cookies, embedMetadata and subs into the queue driver', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-out-'))
  const log = mock.method(console, 'log', () => {})
  let seenProbeCookies: string | undefined
  let seenDownload: DownloadArgs | undefined
  try {
    const outDir = path.join(tmp, 'videos')
    await runScriptable(
      'yt-dlp',
      [{url: 'https://example.com/v'}],
      {outDir, scriptable: 'best', resume: true, cookies: '/tmp/cookies.txt', embedMetadata: true, subs: 'es,en'},
      {
        probe: async (_ytdlp, _url, _signal, cookies) => {
          seenProbeCookies = cookies
          return {info: info(), infoJsonPath: '/tmp/info.json'}
        },
        download: async (opts: DownloadArgs & {ytdlp: string}) => {
          seenDownload = opts
          return path.join(outDir, 'v.mp4')
        },
        findFfmpeg: async () => ({available: true}),
      },
    )
    assert.equal(seenProbeCookies, '/tmp/cookies.txt', 'scriptable probe must receive cookies')
    assert.equal(seenDownload?.resume, true, 'scriptable download must receive resume')
    assert.equal(seenDownload?.cookies, '/tmp/cookies.txt', 'scriptable download must receive cookies')
    assert.equal(seenDownload?.embedMetadata, true, 'scriptable download must receive embedMetadata')
    assert.equal(seenDownload?.subs, 'es,en', 'scriptable download must receive subs')
  } finally {
    log.mock.restore()
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})
