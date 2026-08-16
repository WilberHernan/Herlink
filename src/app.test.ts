import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  createCachedInit,
  doneSummary,
  itemStateTransition,
  resolveInitialOutDir,
  restoreAfterRejectedSubmit,
  screenAfterPickerClose,
  splitSubmittedUrls,
  type ItemState,
} from './app.js'
import type {DoneInfo, ItemStateStatus} from './lib/queue.js'
import type {DownloadProgress} from './lib/ytdlp.js'

test('-o outDir override wins over the default Downloads dir', () => {
  assert.equal(resolveInitialOutDir('/sdcard/Videos', '/home/user'), '/sdcard/Videos')
})

test('without -o the initial outDir is ~/Downloads', () => {
  assert.equal(resolveInitialOutDir(undefined, '/home/user'), path.join('/home/user', 'Downloads'))
})

test('App with initialUrls opens the downloads screen showing init progress (REQ-par-001)', async () => {
  const previousForceColor = process.env.FORCE_COLOR
  const previousNoColor = process.env.NO_COLOR
  process.env.FORCE_COLOR = '3'
  delete process.env.NO_COLOR

  try {
    // Import after forcing truecolor so Chalk's color support is deterministic.
    const [{default: React}, {renderToString}, {App}] = await Promise.all([
      import('react'),
      import('ink'),
      import('./app.js'),
    ])

    const output = renderToString(
      React.createElement(App, {
        initialUrls: ['https://example.com/v'],
        onOutcome: () => {},
      }),
    )
    assert.match(output, /preparando/, 'the downloads screen must show while init starts')
    // REQ-par-001: downloads run in the background, the input stays reachable
    assert.match(output, /volver al input/, 'the downloads screen must offer the way back to the input')
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = previousForceColor
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
})

// ── T4a: submit input splitting (REQ-par-001) ───────────────────────────────

test('splitSubmittedUrls: a single url passes through', () => {
  assert.deepEqual(splitSubmittedUrls('https://example.com/v1'), ['https://example.com/v1'])
})

test('splitSubmittedUrls: whitespace-separated urls all submit (one paste, many links)', () => {
  assert.deepEqual(
    splitSubmittedUrls('https://example.com/v1  https://example.com/v2\thttps://example.com/v3'),
    ['https://example.com/v1', 'https://example.com/v2', 'https://example.com/v3'],
  )
})

test('splitSubmittedUrls: non-url tokens are filtered out', () => {
  assert.deepEqual(splitSubmittedUrls('hola https://example.com/v1 chau'), ['https://example.com/v1'])
})

test('splitSubmittedUrls: empty and whitespace-only values yield no urls', () => {
  assert.deepEqual(splitSubmittedUrls(''), [])
  assert.deepEqual(splitSubmittedUrls('   \n\t  '), [])
})

test('restoreAfterRejectedSubmit: an empty field is restored with the rejected value', () => {
  assert.equal(restoreAfterRejectedSubmit('', 'https://example.com/v1'), 'https://example.com/v1')
})

test('restoreAfterRejectedSubmit: fresh typing in the field is never clobbered', () => {
  assert.equal(
    restoreAfterRejectedSubmit('https://example.com/v2', 'https://example.com/v1'),
    'https://example.com/v2',
  )
})

test('restoreAfterRejectedSubmit: a whitespace-only field is restored too', () => {
  assert.equal(restoreAfterRejectedSubmit('  ', 'https://example.com/v1'), 'https://example.com/v1')
})

// ── T4a: doneSummary (REQ-par-015/016) ──────────────────────────────────────

const doneInfo = (over: Partial<DoneInfo> = {}): DoneInfo => ({
  filepaths: [],
  errors: [],
  cancelled: false,
  aborted: false,
  ...over,
})

test('doneSummary: 1 file → "✓ Descargado" + "Tu archivo está en:" (REQ-par-015)', () => {
  assert.deepEqual(doneSummary(doneInfo({filepaths: ['/home/user/Downloads/a.mp4']})), {
    heading: '✓ Descargado',
    sub: 'Tu archivo está en:',
    errors: [],
  })
})

test('doneSummary: N files → "✓ Descargados {N} archivos" + "Están en:" (REQ-par-015)', () => {
  assert.deepEqual(doneSummary(doneInfo({filepaths: ['/a.mp4', '/b.mp4', '/c.mp4']})), {
    heading: '✓ Descargados 3 archivos',
    sub: 'Están en:',
    errors: [],
  })
})

test('doneSummary: cancelled with files → "✗ Cancelado" + "Se guardaron los archivos ya descargados:" (REQ-par-015)', () => {
  assert.deepEqual(doneSummary(doneInfo({filepaths: ['/a.mp4'], cancelled: true})), {
    heading: '✗ Cancelado',
    sub: 'Se guardaron los archivos ya descargados:',
    errors: [],
  })
})

test('doneSummary: cancelled with none → "✗ Cancelado" + "No se descargó ningún archivo" (REQ-par-015)', () => {
  assert.deepEqual(doneSummary(doneInfo({cancelled: true})), {
    heading: '✗ Cancelado',
    sub: 'No se descargó ningún archivo',
    errors: [],
  })
})

test('doneSummary: every failed item error listed, not only errors[0] (REQ-par-016)', () => {
  const summary = doneSummary(doneInfo({filepaths: ['/a.mp4'], errors: ['boom 1', 'boom 2']}))
  assert.equal(summary.heading, '✓ Descargado')
  assert.deepEqual(summary.errors, ['boom 1', 'boom 2'])
})

test('doneSummary: returned errors array is a copy — caller mutation cannot leak in', () => {
  const info = doneInfo({errors: ['boom']})
  const summary = doneSummary(info)
  info.errors.push('late boom')
  assert.deepEqual(summary.errors, ['boom'])
})

// ── T4a: itemStateTransition (REQ-par-006, D5) ──────────────────────────────

const itemState = (status: ItemStateStatus, over: Partial<ItemState> = {}): ItemState => ({
  status,
  url: 'https://example.com/v',
  ...over,
})

const progress: DownloadProgress = {
  downloadedBytes: 10,
  totalBytes: 100,
  speed: 1000,
  eta: 5,
  part: 0,
  totalParts: 1,
}

test('itemStateTransition: full pipeline probing → picking → downloading → processing → refreshing → done (REQ-par-006)', () => {
  let s = itemStateTransition(itemState('queued'), 'probing')
  assert.equal(s.status, 'probing')
  s = itemStateTransition(s, 'picking')
  assert.equal(s.status, 'picking')
  s = itemStateTransition(s, 'downloading')
  assert.equal(s.status, 'downloading')
  s = itemStateTransition(s, 'processing')
  assert.equal(s.status, 'processing')
  s = itemStateTransition(s, 'refreshing')
  assert.equal(s.status, 'refreshing')
  s = itemStateTransition(s, 'downloading')
  assert.equal(s.status, 'downloading')
  s = itemStateTransition(s, 'done')
  assert.equal(s.status, 'done')
  assert.equal(s.url, 'https://example.com/v', 'url must survive every transition')
})

test('itemStateTransition: "queued" event on a fresh queued row is idempotent (row creation)', () => {
  assert.equal(itemStateTransition(itemState('queued'), 'queued').status, 'queued')
})

test('itemStateTransition: progress event updates progress, keeps status and url', () => {
  const s = itemStateTransition(itemState('downloading'), {type: 'progress', progress})
  assert.equal(s.status, 'downloading')
  assert.equal(s.url, 'https://example.com/v')
  assert.equal(s.progress, progress)
})

test('itemStateTransition: error event flips status to error', () => {
  assert.equal(itemStateTransition(itemState('downloading'), 'error').status, 'error')
})

test('itemStateTransition: picker cancel resolves the item as done (picking → done)', () => {
  assert.equal(itemStateTransition(itemState('picking'), 'done').status, 'done')
})

test('itemStateTransition: invalid transition throws (done → downloading)', () => {
  assert.throws(() => itemStateTransition(itemState('done'), 'downloading'), /invalid itemStateTransition/)
})

test('itemStateTransition: invalid transition throws (queued → downloading)', () => {
  assert.throws(() => itemStateTransition(itemState('queued'), 'downloading'), /invalid itemStateTransition/)
})

test('itemStateTransition: progress while queued throws', () => {
  assert.throws(
    () => itemStateTransition(itemState('queued'), {type: 'progress', progress}),
    /progress event in status queued/,
  )
})

test('itemStateTransition: retry lands refreshing → processing straight into the merge (runItem retry path)', () => {
  assert.equal(itemStateTransition(itemState('refreshing'), 'processing').status, 'processing')
})

test('itemStateTransition: refreshing → audio-fallback is valid (DRM-blocked retry falls back to audio)', () => {
  assert.equal(itemStateTransition(itemState('refreshing'), 'audio-fallback').status, 'audio-fallback')
})

test('itemStateTransition: audio-fallback → processing and audio-fallback → done are valid', () => {
  assert.equal(itemStateTransition(itemState('audio-fallback'), 'processing').status, 'processing')
  assert.equal(itemStateTransition(itemState('audio-fallback'), 'done').status, 'done')
})

test('itemStateTransition: invalid transition throws (downloading → audio-fallback)', () => {
  assert.throws(() => itemStateTransition(itemState('downloading'), 'audio-fallback'), /invalid itemStateTransition/)
})

test('itemStateTransition: multi-entry playlist keeps processing → processing between ffmpeg merges', () => {
  assert.equal(itemStateTransition(itemState('processing'), 'processing').status, 'processing')
})

test('screenAfterPickerClose: resolving the last open picker returns to the run (REQ-par-005)', () => {
  assert.equal(screenAfterPickerClose(0, 'picker'), 'downloads')
})

test('screenAfterPickerClose: a sibling picker stays open — screen keeps the picker', () => {
  assert.equal(screenAfterPickerClose(2, 'picker'), 'picker')
})

test('screenAfterPickerClose: only the picker screen is affected', () => {
  assert.equal(screenAfterPickerClose(0, 'input'), 'input')
  assert.equal(screenAfterPickerClose(0, 'done'), 'done')
})

// ── T4a: createCachedInit (REQ-par-021, D9) ─────────────────────────────────

test('createCachedInit: two get() calls share one promise — run executes once (REQ-par-021)', async () => {
  let runs = 0
  const init = createCachedInit(async () => {
    runs++
    return 'ready'
  })
  const first = init.get()
  const second = init.get()
  assert.equal(first, second, 'a second caller mid-init must await the same pending promise')
  assert.equal(runs, 1)
  assert.equal(await first, 'ready')
})

test('createCachedInit: resolved value is cached — later get() does not re-run', async () => {
  let runs = 0
  const init = createCachedInit(async () => {
    runs++
    return `run-${runs}`
  })
  assert.equal(await init.get(), 'run-1')
  assert.equal(await init.get(), 'run-1')
  assert.equal(runs, 1)
})

test('createCachedInit: rejection does not poison the cache — next get() retries fresh (REQ-par-021 s2)', async () => {
  let runs = 0
  const init = createCachedInit(async () => {
    runs++
    if (runs === 1) throw new Error('init failed')
    return 'recovered'
  })
  await assert.rejects(init.get(), /init failed/)
  assert.equal(await init.get(), 'recovered')
  assert.equal(runs, 2)
})

test('createCachedInit: two callers mid-failed-init surface the same root error', async () => {
  const init = createCachedInit(async () => {
    throw new Error('same root')
  })
  const a = init.get()
  const b = init.get()
  assert.equal(a, b)
  await assert.rejects(a, /same root/)
  await assert.rejects(b, /same root/)
})

test('createCachedInit: explicit reset() forces a fresh run on next get()', async () => {
  let runs = 0
  const init = createCachedInit(async () => {
    runs++
    return 'x'
  })
  await init.get()
  init.reset()
  await init.get()
  assert.equal(runs, 2)
})
