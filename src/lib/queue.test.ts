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

test('runQueue processes items strictly in order, firing onItem per index (REQ-017)', async () => {
  const order: string[] = []
  const items: number[] = []
  const outcome = await runQueue(
    [{url: 'https://a.example/v'}, {url: 'https://b.example/v'}, {url: 'https://c.example/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: () => choice,
      onItem: index => items.push(index),
    },
    {
      probe: async (_ytdlp, url) => {
        order.push(`probe:${url}`)
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        order.push(`download:${opts.url}`)
        return opts.url.includes('a.example') ? 'a.mp4' : opts.url.includes('b.example') ? 'b.mp4' : 'c.mp4'
      },
    },
  )
  assert.deepEqual(order, [
    'probe:https://a.example/v',
    'download:https://a.example/v',
    'probe:https://b.example/v',
    'download:https://b.example/v',
    'probe:https://c.example/v',
    'download:https://c.example/v',
  ])
  assert.deepEqual(items, [0, 1, 2])
  assert.deepEqual(outcome.filepaths, ['a.mp4', 'b.mp4', 'c.mp4'])
  assert.equal(outcome.cancelled, false)
})

test('runQueue records a mid-queue failure and continues with remaining items (REQ-017)', async () => {
  const downloads: string[] = []
  const outcome = await runQueue(
    [{url: 'https://a.example/v'}, {url: 'https://b.example/v'}, {url: 'https://c.example/v'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => choice},
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads.push(opts.url)
        if (opts.url.includes('b.example')) throw new Error('b roto')
        return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
      },
    },
  )
  // b fails on both attempts (cached-info and fresh-extraction retry)
  assert.deepEqual(downloads, [
    'https://a.example/v',
    'https://b.example/v',
    'https://b.example/v',
    'https://c.example/v',
  ])
  assert.deepEqual(outcome.filepaths, ['a.mp4', 'c.mp4'])
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /b roto/)
})

test('runQueue records a probe failure and continues with the remaining items (REQ-017)', async () => {
  const downloads: string[] = []
  const outcome = await runQueue(
    [{url: 'https://a.example/v'}, {url: 'https://b.example/v'}, {url: 'https://c.example/v'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => choice},
    {
      probe: async (_ytdlp, url) => {
        if (url.includes('b.example')) throw new Error('probe b roto')
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads.push(opts.url)
        return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
      },
    },
  )
  assert.deepEqual(downloads, ['https://a.example/v', 'https://c.example/v'])
  assert.deepEqual(outcome.filepaths, ['a.mp4', 'c.mp4'])
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /probe b roto/)
})

test('runQueue cancel aborts the current item and skips the remaining queue, keeping finished files (REQ-017)', async () => {
  const controller = new AbortController()
  const downloads: string[] = []
  const outcome = await runQueue(
    [{url: 'https://a.example/v'}, {url: 'https://b.example/v'}, {url: 'https://c.example/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: () => choice,
      signal: controller.signal,
    },
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads.push(opts.url)
        if (opts.url.includes('b.example')) {
          controller.abort()
          throw new Error('aborted')
        }
        return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
      },
    },
  )
  assert.deepEqual(downloads, ['https://a.example/v', 'https://b.example/v'])
  assert.deepEqual(outcome.filepaths, ['a.mp4'])
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.errors.length, 0)
})

test('runQueue awaits an async choiceFor — the TTY picker path resolves the download choice', async () => {
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: async () => choice,
    },
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        assert.deepEqual(opts.choice.args, choice.args)
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/video.mp4'])
  assert.equal(outcome.cancelled, false)
})

test('runQueue treats a choiceFor cancel verdict as a queue cancel, keeping finished files', async () => {
  let downloads = 0
  const outcome = await runQueue(
    [{url: 'https://a.example/v'}, {url: 'https://b.example/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: videoInfo => (videoInfo.title === 'primero' ? choice : 'cancel'),
    },
    {
      probe: async (_ytdlp, url) => ({
        info: info(url.includes('a.example') ? 'primero' : 'segundo'),
        infoJsonPath: '/tmp/info.json',
      }),
      download: async () => {
        downloads++
        return '/tmp/Downloads/a.mp4'
      },
    },
  )
  assert.equal(downloads, 1)
  assert.equal(outcome.cancelled, true)
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/a.mp4'])
})

test('runQueue retries with a fresh extraction when the cached-info download fails', async () => {
  let downloads = 0
  let retries = 0
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: () => choice,
      onRetry: () => retries++,
    },
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
  assert.equal(retries, 1, 'onRetry must fire before the fresh-extraction attempt')
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
