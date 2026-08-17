import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {mock} from 'node:test'
import test from 'node:test'
import {createParallelQueue, runQueue, runScriptable} from './queue.js'
import type {DoneInfo, ParallelQueue, ParallelQueueOptions, QueueDeps} from './queue.js'
import {removePartials} from './ytdlp.js'
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
  // b fails on both attempts (first attempt and retry)
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

test('runQueue retries on transient download error', async () => {
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
      download: async () => {
        downloads++
        if (downloads === 1) throw new Error('transient network error')
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.equal(downloads, 2)
  assert.equal(retries, 1, 'onRetry must fire before the retry attempt')
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/video.mp4'])
  assert.equal(outcome.errors.length, 0)
})

test('runQueue falls back to audio-only once when the video stream is DRM-blocked (403)', async () => {
  const attempts: string[] = []
  let retries = 0
  let audioFallbacks = 0
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: () => choice,
      onRetry: () => retries++,
      onAudioFallback: () => audioFallbacks++,
    },
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        attempts.push(opts.choice.kind)
        if (opts.choice.kind === 'audio') {
          assert.deepEqual(
            opts.choice.args,
            ['-f', 'ba/b'],
            'no-ffmpeg fallback must use the best native audio format, no extraction',
          )
          return '/tmp/Downloads/audio.m4a'
        }
        throw new Error('unable to download video data: HTTP Error 403: Forbidden')
      },
    },
  )
  assert.deepEqual(attempts, ['video', 'video', 'audio'], 'first attempt + retry + audio fallback')
  assert.equal(retries, 1, 'the fresh-extraction retry must fire before the fallback')
  assert.equal(audioFallbacks, 1, 'onAudioFallback must fire exactly once')
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/audio.m4a'])
  assert.equal(outcome.errors.length, 0)
})

test('runQueue does NOT fall back to audio for a non-DRM failure — the error is reported', async () => {
  let audioFallbacks = 0
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      choiceFor: () => choice,
      onAudioFallback: () => audioFallbacks++,
    },
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async () => {
        throw new Error('Some network error')
      },
    },
  )
  assert.equal(audioFallbacks, 0, 'a non-DRM failure must never trigger the fallback')
  assert.deepEqual(outcome.filepaths, [])
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /Some network error/)
})

test('runQueue threads item.playlistIndex into the download (D8)', async () => {
  let seenIndex: number | undefined
  const outcome = await runQueue(
    [{url: 'https://example.com/pl', playlistIndex: 3}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => choice},
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        seenIndex = opts.playlistIndex
        return '/tmp/Downloads/entry.mp4'
      },
    },
  )
  assert.equal(seenIndex, 3, 'playlistIndex must reach the download')
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/entry.mp4'])
})

test('runQueue expands a playlist probe into per-entry downloads when the playlist choice is taken (REQ-019)', async () => {
  const calls: string[] = []
  const outcome = await runQueue(
    [{url: 'https://example.com/pl'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => 'playlist'},
    {
      probe: async () => ({
        info: {title: 'pl', playlist_id: 'PL123', playlist_count: 3},
        infoJsonPath: '/tmp/info.json',
      }),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        calls.push(`download:${opts.playlistIndex}`)
        assert.equal(opts.playlist, true, 'per-entry downloads must be in playlist mode')
        assert.equal(opts.choice.kind, 'video', 'entries download with the best-video choice (like --best)')
        return `/tmp/Downloads/entry-${opts.playlistIndex}.mp4`
      },
    },
  )
  assert.deepEqual(calls, ['download:1', 'download:2', 'download:3'])
  assert.deepEqual(outcome.filepaths, [
    '/tmp/Downloads/entry-1.mp4',
    '/tmp/Downloads/entry-2.mp4',
    '/tmp/Downloads/entry-3.mp4',
  ])
  assert.equal(outcome.errors.length, 0)
})

test('runQueue surfaces a clear error and downloads nothing for a 0-entry playlist (REQ-019)', async () => {
  let downloads = 0
  const outcome = await runQueue(
    [{url: 'https://example.com/pl'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => 'playlist'},
    {
      probe: async () => ({
        info: {title: 'pl', playlist_id: 'PL123', playlist_count: 0},
        infoJsonPath: '/tmp/info.json',
      }),
      download: async () => {
        downloads++
        return '/tmp/Downloads/x.mp4'
      },
    },
  )
  assert.equal(downloads, 0, 'nothing must download for an empty playlist')
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /no tiene videos/)
  assert.deepEqual(outcome.filepaths, [])
})

test('runQueue falls back to a single whole-playlist run when playlist_count is unknown (D13)', async () => {
  let seen: DownloadArgs | undefined
  const outcome = await runQueue(
    [{url: 'https://example.com/pl'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => 'playlist'},
    {
      probe: async () => ({
        info: {title: 'pl', playlist_id: 'PL123'}, // no playlist_count
        infoJsonPath: '/tmp/info.json',
      }),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        seen = opts
        return '/tmp/Downloads/all.mp4'
      },
    },
  )
  assert.equal(seen?.playlist, true, 'D13 run must be in playlist mode (no --no-playlist)')
  assert.equal(seen?.playlistIndex, undefined, 'unknown count → no per-entry window')
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/all.mp4'])
  assert.equal(outcome.errors.length, 0)
})

test('runQueue records a mid-playlist entry failure and continues with the remaining entries (REQ-019)', async () => {
  const calls: string[] = []
  const outcome = await runQueue(
    [{url: 'https://example.com/pl'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => 'playlist'},
    {
      probe: async () => ({
        info: {title: 'pl', playlist_id: 'PL123', playlist_count: 3},
        infoJsonPath: '/tmp/info.json',
      }),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        calls.push(`download:${opts.playlistIndex}`)
        if (opts.playlistIndex === 2) throw new Error('entrada 2 rota')
        return `/tmp/Downloads/entry-${opts.playlistIndex}.mp4`
      },
    },
  )
  assert.deepEqual(calls, ['download:1', 'download:2', 'download:3'])
  assert.deepEqual(outcome.filepaths, ['/tmp/Downloads/entry-1.mp4', '/tmp/Downloads/entry-3.mp4'])
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /entrada 2 rota/)
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

test('runQueue threads noUpdate into probe and download (REQ-022)', async () => {
  let seenProbeNoUpdate: boolean | undefined
  let seenDownloadNoUpdate: boolean | undefined
  const outcome = await runQueue(
    [{url: 'https://example.com/v'}],
    {
      ytdlp: 'yt-dlp',
      outDir: '/tmp/Downloads',
      ffmpeg: {available: false},
      noUpdate: true,
      choiceFor: () => choice,
    },
    {
      probe: async (_ytdlp, _url, _signal, _cookies, noUpdate) => {
        seenProbeNoUpdate = noUpdate
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        seenDownloadNoUpdate = opts.noUpdate
        return '/tmp/Downloads/video.mp4'
      },
    },
  )
  assert.equal(outcome.filepaths.length, 1)
  assert.equal(seenProbeNoUpdate, true, 'probe must receive noUpdate for stale-warning suppression')
  assert.equal(seenDownloadNoUpdate, true, 'download must receive noUpdate')
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

// ── parallelQueue driver (T3a: cap-3 FIFO pool, per-item abort, cancelAll) ──

const pqChoice: DownloadChoice = {label: '1080p · mp4', kind: 'video', args: ['-f', 'bv*+ba/b']}

// flushes every pending microtask plus a macrotask boundary — enough for a
// chain of fake-async probe → choiceFor → download → task settle to complete
async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {promise, resolve, reject}
}
type Deferred<T> = ReturnType<typeof deferred<T>>

type PqOverrides = Partial<{
  cap: number
  choiceFor: ParallelQueueOptions['choiceFor']
  onItemState: ParallelQueueOptions['onItemState']
  onProgress: ParallelQueueOptions['onProgress']
  onAllDone: ParallelQueueOptions['onAllDone']
}>

function makeParallelQueue(deps: QueueDeps, overrides: PqOverrides = {}): ParallelQueue {
  return createParallelQueue({
    ytdlp: 'yt-dlp',
    outDir: '/tmp/Downloads',
    ffmpeg: {available: false},
    choiceFor: () => pqChoice,
    onItemState: () => {},
    onProgress: () => {},
    onAllDone: () => {},
    ...overrides,
    deps,
  })
}

test('parallelQueue runs at most 3 items concurrently, starting queued items FIFO as slots free (REQ-par-002)', async () => {
  const urls = [
    'https://a.example/v',
    'https://b.example/v',
    'https://c.example/v',
    'https://d.example/v',
    'https://e.example/v',
  ]
  const started: string[] = []
  const gates = new Map<string, Deferred<string>>()
  const statuses: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: (opts: DownloadArgs & {ytdlp: string}) => {
        started.push(opts.url)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        const gate = deferred<string>()
        gates.set(opts.url, gate)
        return gate.promise.then(fp => {
          inFlight--
          return fp
        })
      },
    },
    {onItemState: (itemId, status) => statuses.push(`${itemId}:${status}`)},
  )
  for (const url of urls) queue.start({url})
  await flush()
  assert.deepEqual(started, urls.slice(0, 3), 'exactly 3 items must start immediately')
  assert.equal(inFlight, 3)
  assert.equal(maxInFlight, 3, 'concurrency must never exceed the cap')
  assert.equal(queue.hasActive(), true)
  assert.ok(statuses.includes('item-0:probing'), 'running items must emit probing')
  assert.ok(statuses.includes('item-3:queued'), '4th item must stay queued beyond the cap')
  assert.ok(statuses.includes('item-4:queued'), '5th item must stay queued beyond the cap')

  gates.get(urls[0])!.resolve('/tmp/Downloads/a.mp4')
  await flush()
  assert.deepEqual(started, urls.slice(0, 4), '4th item must start FIFO when the first slot frees')
  assert.equal(inFlight, 3)

  gates.get(urls[1])!.resolve('/tmp/Downloads/b.mp4')
  await flush()
  assert.deepEqual(started, urls, '5th item must start FIFO when the second slot frees')
  assert.equal(inFlight, 3)

  gates.get(urls[2])!.resolve('/tmp/Downloads/c.mp4')
  gates.get(urls[3])!.resolve('/tmp/Downloads/d.mp4')
  gates.get(urls[4])!.resolve('/tmp/Downloads/e.mp4')
  await flush()
  assert.equal(inFlight, 0)
  assert.equal(queue.hasActive(), false)
  assert.ok(statuses.includes('item-0:done'), 'completed items must emit done')
  const outcome = queue.currentOutcome()
  assert.deepEqual(outcome.filepaths, [
    '/tmp/Downloads/a.mp4',
    '/tmp/Downloads/b.mp4',
    '/tmp/Downloads/c.mp4',
    '/tmp/Downloads/d.mp4',
    '/tmp/Downloads/e.mp4',
  ])
  assert.equal(outcome.cancelled, false)
})

test('parallelQueue: a per-item cancel stops only that item — siblings continue (REQ-par-003)', async () => {
  const downloads: string[] = []
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads.push(opts.url)
        return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
      },
    },
    {
      choiceFor: videoInfo => (videoInfo.title === 'https://b.example/v' ? 'cancel' : pqChoice),
    },
  )
  queue.start({url: 'https://a.example/v'})
  queue.start({url: 'https://b.example/v'})
  queue.start({url: 'https://c.example/v'})
  await flush()
  assert.deepEqual(
    downloads,
    ['https://a.example/v', 'https://c.example/v'],
    'the cancelled item must never download, siblings must run',
  )
  assert.equal(queue.hasActive(), false)
  const outcome = queue.currentOutcome()
  assert.deepEqual(outcome.filepaths, ['a.mp4', 'c.mp4'])
  assert.equal(outcome.errors.length, 0)
})

test('parallelQueue: one item failure does not cascade — siblings finish (REQ-par-003)', async () => {
  const queue = makeParallelQueue({
    probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
    download: async (opts: DownloadArgs & {ytdlp: string}) => {
      if (opts.url.includes('b.example')) throw new Error('b roto')
      return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
    },
  })
  queue.start({url: 'https://a.example/v'})
  queue.start({url: 'https://b.example/v'})
  queue.start({url: 'https://c.example/v'})
  await flush()
  assert.equal(queue.hasActive(), false)
  const outcome = queue.currentOutcome()
  assert.deepEqual(outcome.filepaths, ['a.mp4', 'c.mp4'])
  assert.equal(outcome.errors.length, 1)
  assert.match(outcome.errors[0]!, /b roto/)
  assert.equal(outcome.cancelled, false)
})

test('parallelQueue cancelAll aborts running items, queued never start, cleanup keeps .part (REQ-par-010/011)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-pq-'))
  try {
    const started: string[] = []
    const running: Array<{url: string; signal?: AbortSignal; dest: string}> = []
    let markAbortHandled!: () => void
    const abortHandled = new Promise<void>(resolve => {
      markAbortHandled = resolve
    })
    const queue = makeParallelQueue({
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: path.join(tmp, 'info.json')}),
      download: (opts: DownloadArgs & {ytdlp: string}, _handlers, signal) => {
        started.push(opts.url)
        const dest = path.join(
          tmp,
          opts.url.includes('a.example') ? 'a.mp4' : opts.url.includes('b.example') ? 'b.mp4' : 'c.mp4',
        )
        // the real download writes these and keeps going; on abort its signal
        // branch runs removePartials — dest + .ytdl removed, .part kept (REQ-par-011)
        fs.writeFileSync(`${dest}.part`, 'partial')
        fs.writeFileSync(dest, 'final')
        fs.writeFileSync(`${dest}.ytdl`, 'meta')
        running.push({url: opts.url, signal, dest})
        return new Promise<string>((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            void removePartials([dest]).then(() => {
              markAbortHandled()
              reject(new Error('Descarga cancelada.'))
            })
          })
        })
      },
    })
    for (const url of [
      'https://a.example/v',
      'https://b.example/v',
      'https://c.example/v',
      'https://d.example/v',
      'https://e.example/v',
    ]) {
      queue.start({url})
    }
    await flush()
    assert.equal(started.length, 3, 'cap 3 before cancel')
    queue.cancelAll()
    await abortHandled
    await flush()
    assert.equal(started.length, 3, 'queued items must never start after cancelAll (REQ-par-010)')
    assert.equal(queue.hasActive(), false, 'pool must drain after cancelAll')
    const outcome = queue.currentOutcome()
    assert.equal(outcome.cancelled, true)
    assert.equal(outcome.aborted, true)
    assert.equal(running.length, 3)
    for (const record of running) {
      assert.equal(record.signal?.aborted, true, `running item ${record.url} must be aborted`)
      assert.ok(!fs.existsSync(record.dest), `${record.dest} must be removed on cancel`)
      assert.ok(!fs.existsSync(`${record.dest}.ytdl`), `${record.dest}.ytdl must be removed on cancel`)
      assert.ok(fs.existsSync(`${record.dest}.part`), `${record.dest}.part must be kept for resume (REQ-par-011)`)
    }
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true})
  }
})

test('parallelQueue honors a custom cap — 4 items, cap 2: never more than 2 concurrent, FIFO order (REQ-par-002)', async () => {
  const urls = ['https://a.example/v', 'https://b.example/v', 'https://c.example/v', 'https://d.example/v']
  const started: string[] = []
  const gates = new Map<string, Deferred<string>>()
  let inFlight = 0
  let maxInFlight = 0
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: (opts: DownloadArgs & {ytdlp: string}) => {
        started.push(opts.url)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        const gate = deferred<string>()
        gates.set(opts.url, gate)
        return gate.promise.then(fp => {
          inFlight--
          return fp
        })
      },
    },
    {cap: 2},
  )
  for (const url of urls) queue.start({url})
  await flush()
  assert.deepEqual(started, urls.slice(0, 2), 'exactly 2 items must start with cap 2')
  assert.equal(maxInFlight, 2)
  gates.get(urls[0])!.resolve('/tmp/Downloads/a.mp4')
  await flush()
  assert.deepEqual(started, urls.slice(0, 3), '3rd item must start FIFO')
  gates.get(urls[1])!.resolve('/tmp/Downloads/b.mp4')
  await flush()
  assert.deepEqual(started, urls, '4th item must start FIFO')
  gates.get(urls[2])!.resolve('/tmp/Downloads/c.mp4')
  gates.get(urls[3])!.resolve('/tmp/Downloads/d.mp4')
  await flush()
  assert.equal(inFlight, 0)
  assert.equal(queue.hasActive(), false)
  assert.deepEqual(queue.currentOutcome().filepaths, [
    '/tmp/Downloads/a.mp4',
    '/tmp/Downloads/b.mp4',
    '/tmp/Downloads/c.mp4',
    '/tmp/Downloads/d.mp4',
  ])
})

test('parallelQueue cancelAll on an empty pool is safe and still marks the outcome cancelled', async () => {
  const queue = makeParallelQueue({
    probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
  })
  queue.cancelAll()
  assert.equal(queue.hasActive(), false)
  const outcome = queue.currentOutcome()
  assert.equal(outcome.cancelled, true)
  assert.equal(outcome.aborted, true)
  assert.deepEqual(outcome.filepaths, [])
  assert.deepEqual(outcome.errors, [])
})

test('parallelQueue and runQueue are isolated — a parallel run leaves no state for a sequential run (REQ-par-022 s2)', async () => {
  const pqStarted: string[] = []
  const pqGates = new Map<string, Deferred<string>>()
  const pq = createParallelQueue({
    ytdlp: 'yt-dlp',
    outDir: '/tmp/Downloads',
    ffmpeg: {available: false},
    choiceFor: () => pqChoice,
    onItemState: () => {},
    onProgress: () => {},
    onAllDone: () => {},
    deps: {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: (opts: DownloadArgs & {ytdlp: string}) => {
        pqStarted.push(opts.url)
        const gate = deferred<string>()
        pqGates.set(opts.url, gate)
        return gate.promise
      },
    },
  })
  const pqUrls = ['https://p1.example/v', 'https://p2.example/v', 'https://p3.example/v', 'https://p4.example/v']
  for (const url of pqUrls) pq.start({url})
  await flush()
  assert.equal(pqStarted.length, 3)
  for (const url of [...pqStarted]) pqGates.get(url)!.resolve(`/tmp/Downloads/${url.split('//')[1]}.mp4`)
  await flush()
  assert.equal(pqStarted.length, 4, '4th item must start FIFO after the first three complete')
  pqGates.get(pqUrls[3])!.resolve('/tmp/Downloads/p4.example/v.mp4')
  await flush()
  assert.equal(pq.hasActive(), false)
  assert.equal(pq.currentOutcome().filepaths.length, 4)

  // the sequential run after the parallel one must behave byte-identically
  const seqCalls: string[] = []
  const seqOutcome = await runQueue(
    [{url: 'https://x.example/v'}, {url: 'https://y.example/v'}],
    {ytdlp: 'yt-dlp', outDir: '/tmp/Downloads', ffmpeg: {available: false}, choiceFor: () => pqChoice},
    {
      probe: async (_ytdlp, url) => {
        seqCalls.push(`probe:${url}`)
        return {info: info(), infoJsonPath: '/tmp/info.json'}
      },
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        seqCalls.push(`download:${opts.url}`)
        return opts.url.includes('x.example') ? 'x.mp4' : 'y.mp4'
      },
    },
  )
  assert.deepEqual(seqCalls, [
    'probe:https://x.example/v',
    'download:https://x.example/v',
    'probe:https://y.example/v',
    'download:https://y.example/v',
  ])
  assert.deepEqual(seqOutcome.filepaths, ['x.mp4', 'y.mp4'])
  assert.equal(seqOutcome.cancelled, false)
  assert.equal(pq.currentOutcome().filepaths.length, 4, 'parallel outcome must survive the sequential run')
  assert.equal(pq.hasActive(), false)
})

// ── parallelQueue T3b: onAllDone aggregation, picker deferral, playlist slot ──

test('parallelQueue fires onAllDone exactly once when drained, aggregating every item (REQ-par-004)', async () => {
  const urls = ['a', 'b', 'c', 'd', 'e'].map(host => `https://${host}.example/v`)
  const gates = new Map<string, Deferred<string>>()
  const doneCalls: DoneInfo[] = []
  let inFlight = 0
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: (opts: DownloadArgs & {ytdlp: string}) => {
        inFlight++
        const gate = deferred<string>()
        gates.set(opts.url, gate)
        return gate.promise.then(fp => {
          inFlight--
          return fp
        })
      },
    },
    {onAllDone: done => doneCalls.push(done)},
  )
  for (const url of urls) queue.start({url})
  await flush()
  for (const url of urls.slice(0, 3)) gates.get(url)!.resolve(`/tmp/Downloads/${url.split('//')[1]}.mp4`)
  await flush()
  assert.equal(doneCalls.length, 0, 'onAllDone must not fire while items still run')
  gates.get(urls[3])!.resolve('/tmp/Downloads/d.example/v.mp4')
  gates.get(urls[4])!.resolve('/tmp/Downloads/e.example/v.mp4')
  await flush()
  assert.equal(inFlight, 0)
  assert.equal(queue.hasActive(), false)
  assert.equal(doneCalls.length, 1, 'onAllDone must fire exactly once across multiple pump cycles')
  assert.deepEqual(doneCalls[0]!.filepaths, [
    '/tmp/Downloads/a.example/v.mp4',
    '/tmp/Downloads/b.example/v.mp4',
    '/tmp/Downloads/c.example/v.mp4',
    '/tmp/Downloads/d.example/v.mp4',
    '/tmp/Downloads/e.example/v.mp4',
  ])
  assert.equal(doneCalls[0]!.errors.length, 0)
  assert.equal(doneCalls[0]!.cancelled, false)
  assert.equal(doneCalls[0]!.aborted, false)

  // one-shot: a new item after drain must not re-fire onAllDone
  queue.start({url: 'https://f.example/v'})
  await flush()
  gates.get('https://f.example/v')!.resolve('/tmp/Downloads/f.example/v.mp4')
  await flush()
  assert.equal(queue.hasActive(), false)
  assert.equal(doneCalls.length, 1, 'onAllDone must never fire twice for one queue')
})

test('parallelQueue defers onAllDone while a pick pends, firing after the pick settles with its result (REQ-par-017)', async () => {
  let resolvePick!: (value: DownloadChoice | 'playlist' | 'cancel') => void
  const pick = new Promise<DownloadChoice | 'playlist' | 'cancel'>(resolve => {
    resolvePick = resolve
  })
  let pickedTitle = ''
  const doneCalls: DoneInfo[] = []
  const statuses: string[] = []
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: async (opts: DownloadArgs & {ytdlp: string}) =>
        opts.url.includes('a.example') ? 'a.mp4' : 'b.mp4',
    },
    {
      choiceFor: videoInfo => {
        if (videoInfo.title === 'https://b.example/v') {
          pickedTitle = videoInfo.title
          return pick
        }
        return pqChoice
      },
      onItemState: (itemId, status) => statuses.push(`${itemId}:${status}`),
      onAllDone: done => doneCalls.push(done),
    },
  )
  queue.start({url: 'https://a.example/v'})
  queue.start({url: 'https://b.example/v'})
  await flush()
  assert.equal(pickedTitle, 'https://b.example/v', 'b must be sitting on the open picker')
  assert.equal(queue.pendingPicks(), 1, 'one picker must be open')
  assert.equal(doneCalls.length, 0, 'done must defer while a pick pends')
  assert.equal(queue.hasActive(), true, 'the picking item still holds its slot')
  assert.ok(statuses.includes('item-1:picking'))

  resolvePick(pqChoice)
  await flush()
  assert.equal(queue.pendingPicks(), 0, 'the pick counter must settle after resolution')
  assert.equal(queue.hasActive(), false)
  assert.equal(doneCalls.length, 1, 'done must fire once the pick settles')
  assert.deepEqual(doneCalls[0]!.filepaths, ['a.mp4', 'b.mp4'], 'the picked item result must be included')
  assert.equal(doneCalls[0]!.cancelled, false)
})

test('parallelQueue defers done while a pick pends and drains after the picker cancels that item (REQ-par-009/017)', async () => {
  let resolvePick!: (value: DownloadChoice | 'playlist' | 'cancel') => void
  const pick = new Promise<DownloadChoice | 'playlist' | 'cancel'>(resolve => {
    resolvePick = resolve
  })
  const downloads: string[] = []
  const doneCalls: DoneInfo[] = []
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) => ({info: info(url), infoJsonPath: `/tmp/${url}.json`}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        downloads.push(opts.url)
        return opts.url.includes('a.example') ? 'a.mp4' : 'c.mp4'
      },
    },
    {
      choiceFor: videoInfo => (videoInfo.title === 'https://b.example/v' ? pick : pqChoice),
      onAllDone: done => doneCalls.push(done),
    },
  )
  queue.start({url: 'https://a.example/v'})
  queue.start({url: 'https://b.example/v'})
  queue.start({url: 'https://c.example/v'})
  await flush()
  assert.equal(queue.pendingPicks(), 1)
  assert.equal(doneCalls.length, 0, 'done must defer while the picker is open')
  resolvePick('cancel') // esc on the picker — only b cancels (REQ-par-009)
  await flush()
  assert.deepEqual(downloads, ['https://a.example/v', 'https://c.example/v'], 'only the picked item must cancel')
  assert.equal(queue.pendingPicks(), 0)
  assert.equal(queue.hasActive(), false)
  assert.equal(doneCalls.length, 1, 'done must fire after the picker cancels the pending item')
  assert.deepEqual(doneCalls[0]!.filepaths, ['a.mp4', 'c.mp4'])
  assert.equal(doneCalls[0]!.cancelled, false, 'an item-level cancel must not mark the whole run cancelled')
})

test('parallelQueue playlist holds exactly 1 slot, entries sequential, queued videos start mid-iteration (REQ-par-012/013)', async () => {
  const started: string[] = []
  const playlistEntries: number[] = []
  let playlistInFlight = 0
  let maxPlaylistInFlight = 0
  let totalInFlight = 0
  let maxTotalInFlight = 0
  const gates = new Map<string, Deferred<string>>()
  const doneCalls: DoneInfo[] = []
  const queue = makeParallelQueue(
    {
      probe: async (_ytdlp, url) =>
        url.includes('pl.example')
          ? {info: {title: 'pl', playlist_id: 'PL1', playlist_count: 5}, infoJsonPath: '/tmp/pl.json'}
          : {info: info(url), infoJsonPath: `/tmp/${url}.json`},
      download: (opts: DownloadArgs & {ytdlp: string}) => {
        started.push(opts.url)
        totalInFlight++
        maxTotalInFlight = Math.max(maxTotalInFlight, totalInFlight)
        const key = opts.playlist ? `pl:${opts.playlistIndex}` : opts.url
        if (opts.playlist) {
          playlistEntries.push(opts.playlistIndex!)
          playlistInFlight++
          maxPlaylistInFlight = Math.max(maxPlaylistInFlight, playlistInFlight)
        }
        const gate = deferred<string>()
        gates.set(key, gate)
        return gate.promise.then(fp => {
          totalInFlight--
          if (opts.playlist) playlistInFlight--
          return fp
        })
      },
    },
    {
      choiceFor: videoInfo => (videoInfo.title === 'pl' ? 'playlist' : pqChoice),
      onAllDone: done => doneCalls.push(done),
    },
  )
  queue.start({url: 'https://pl.example/pl'})
  queue.start({url: 'https://v1.example/v'})
  queue.start({url: 'https://v2.example/v'})
  queue.start({url: 'https://v3.example/v'})
  await flush()
  assert.deepEqual(playlistEntries, [1], 'the playlist task must start its first entry')
  assert.equal(maxTotalInFlight, 3, 'playlist task + 2 videos must use all 3 slots (REQ-par-012)')
  assert.equal(maxPlaylistInFlight, 1, 'playlist entries must never be concurrent')

  // v1 finishes → the queued v3 starts while the playlist entry 1 is still in flight (REQ-par-013)
  gates.get('https://v1.example/v')!.resolve('/tmp/v1.mp4')
  await flush()
  assert.ok(started.includes('https://v3.example/v'), 'a queued video must start while the playlist iterates')
  assert.deepEqual(playlistEntries, [1], 'the playlist task must still be on entry 1')

  gates.get('https://v2.example/v')!.resolve('/tmp/v2.mp4')
  gates.get('https://v3.example/v')!.resolve('/tmp/v3.mp4')
  await flush()
  for (let i = 1; i <= 5; i++) {
    gates.get(`pl:${i}`)!.resolve(`/tmp/pl-${i}.mp4`)
    await flush()
  }
  assert.deepEqual(playlistEntries, [1, 2, 3, 4, 5], 'entries must download strictly in order, one at a time')
  assert.equal(maxPlaylistInFlight, 1)
  assert.equal(maxTotalInFlight, 3)
  assert.equal(queue.hasActive(), false)
  assert.equal(doneCalls.length, 1)
  assert.equal(doneCalls[0]!.filepaths.length, 8, '5 playlist entries + 3 videos must aggregate')
})

test('parallelQueue aggregates every item error, not only the first (REQ-par-016)', async () => {
  const doneCalls: DoneInfo[] = []
  const queue = makeParallelQueue(
    {
      probe: async () => ({info: info(), infoJsonPath: '/tmp/info.json'}),
      download: async (opts: DownloadArgs & {ytdlp: string}) => {
        if (opts.url.includes('b.example')) throw new Error('b roto')
        if (opts.url.includes('c.example')) throw new Error('c roto')
        return 'a.mp4'
      },
    },
    {onAllDone: done => doneCalls.push(done)},
  )
  queue.start({url: 'https://a.example/v'})
  queue.start({url: 'https://b.example/v'})
  queue.start({url: 'https://c.example/v'})
  await flush()
  assert.equal(queue.hasActive(), false)
  const outcome = queue.currentOutcome()
  assert.deepEqual(outcome.filepaths, ['a.mp4'])
  assert.equal(outcome.errors.length, 2, 'both failing items must contribute their error')
  assert.ok(outcome.errors.some(error => error.includes('b roto')))
  assert.ok(outcome.errors.some(error => error.includes('c roto')))
  assert.equal(doneCalls.length, 1)
  assert.equal(doneCalls[0]!.errors.length, 2, 'done must carry every error, not only errors[0]')
})
