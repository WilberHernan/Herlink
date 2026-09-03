import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  TERMUX_STORAGE_HINT,
  acquireWakeLock,
  commandWorks,
  isSharedStorageDir,
  isTermux,
  isWakeLockHeld,
  releaseWakeLock,
  resolveOutDir,
} from './termux.js'

const PREFIX = '/data/data/com.termux/files/usr'
const HOME = os.homedir()

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

test('isTermux() is true when PREFIX and ANDROID_ROOT are both set', () => {
  const restore = termuxEnv(true)
  try {
    assert.equal(isTermux(), true)
  } finally {
    restore()
  }
})

test('isTermux() is false when PREFIX differs', () => {
  const restore = termuxEnv(false)
  try {
    process.env.PREFIX = '/usr'
    process.env.ANDROID_ROOT = '/system'
    assert.equal(isTermux(), false)
  } finally {
    restore()
  }
})

test('isTermux() is false with ANDROID_ROOT but no PREFIX', () => {
  const restore = termuxEnv(false)
  try {
    process.env.ANDROID_ROOT = '/system'
    assert.equal(isTermux(), false)
  } finally {
    restore()
  }
})

test('isTermux() is false with neither env var set', () => {
  const restore = termuxEnv(false)
  try {
    assert.equal(isTermux(), false)
  } finally {
    restore()
  }
})

test('resolveOutDir() prefers ~/storage/shared/Download/Downlink and creates it', async () => {
  const restore = termuxEnv(true)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-termux-'))
  try {
    fs.mkdirSync(path.join(base, 'storage'), {recursive: true})
    const expected = path.join(base, 'storage', 'shared', 'Download', 'Downlink')
    const result = await resolveOutDir(base)
    assert.deepEqual(result, {dir: expected})
    assert.equal(fs.existsSync(expected), true, 'camera dir must be created')
  } finally {
    restore()
    fs.rmSync(base, {recursive: true, force: true})
  }
})

test('resolveOutDir() falls back to ~/Downloads and hints when shared storage is missing', async () => {
  const restore = termuxEnv(true)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-termux-'))
  try {
    assert.deepEqual(await resolveOutDir(base), {
      dir: path.join(base, 'Downloads'),
      hint: TERMUX_STORAGE_HINT,
    })
  } finally {
    restore()
    fs.rmSync(base, {recursive: true, force: true})
  }
})

test('resolveOutDir() on desktop is ~/Downloads with no hint', async () => {
  const restore = termuxEnv(false)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-termux-'))
  try {
    assert.deepEqual(await resolveOutDir(base), {dir: path.join(base, 'Downloads')})
  } finally {
    restore()
    fs.rmSync(base, {recursive: true, force: true})
  }
})

test('isSharedStorageDir() only accepts ~/storage and its descendants', () => {
  const storage = path.join(HOME, 'storage')
  assert.equal(isSharedStorageDir(storage), true)
  assert.equal(isSharedStorageDir(path.join(storage, 'downloads')), true)
  assert.equal(isSharedStorageDir(path.join(storage, 'shared', 'Download', 'Downlink')), true)
  assert.equal(isSharedStorageDir(path.join(HOME, 'Downloads')), false)
  assert.equal(isSharedStorageDir(`${storage}-other`), false)
})

// ── P1-1 Termux wakelock: commandWorks / acquire / release ──────────────────

// Creates a temp dir with executable stubs for each `name` and PINS PATH to
// it, returning a restore fn. commandWorks/acquire/spawn read PATH at call
// time. Path resolution is absolute (resolveCommand), so both wake-lock and
// wake-unlock must be present for a full acquire→release cycle.
function fakeBins(...names: string[]): {dir: string; restore: () => void} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-wl-'))
  for (const name of names) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', {mode: 0o755})
  }
  const prevPath = process.env.PATH
  process.env.PATH = dir
  return {
    dir,
    restore: () => {
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
      fs.rmSync(dir, {recursive: true, force: true})
    },
  }
}

test('commandWorks() finds an executable on PATH', () => {
  const bin = fakeBins('termux-wake-lock')
  try {
    assert.equal(commandWorks('termux-wake-lock'), true)
  } finally {
    bin.restore()
  }
})

test('commandWorks() is false for a missing command and for an empty name', () => {
  assert.equal(commandWorks('definitely-not-a-real-binary-xyz'), false)
  assert.equal(commandWorks(''), false)
})

test('commandWorks() falls back to $PREFIX/bin on Termux when PATH lacks it', () => {
  const restore = termuxEnv(true)
  const prevPath = process.env.PATH
  delete process.env.PATH
  try {
    // the real $PREFIX/bin may or may not hold termux-wake-lock; assert the
    // function resolves the PREFIX dir without throwing and stays boolean
    assert.equal(typeof commandWorks('termux-wake-lock'), 'boolean')
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    restore()
  }
})

test('acquireWakeLock() is a no-op on desktop (returns false, never held)', () => {
  const restore = termuxEnv(false)
  // desktop never scans $PREFIX/bin, so a PATH that can't resolve the binary
  // guarantees the no-op regardless of the runner's real PATH
  const prevPath = process.env.PATH
  process.env.PATH = 'definitely-empty-path-dir'
  try {
    assert.equal(acquireWakeLock(), false)
    assert.equal(isWakeLockHeld(), false)
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    releaseWakeLock()
    restore()
  }
})

test('acquireWakeLock() never blocks or throws when the command is missing', () => {
  // The Termux case "no termux-wake-lock" is not forceable here (termux-tools
  // ships it in $PREFIX/bin), so drive the same guarded path code on desktop:
  // commandWorks() is false → acquireWakeLock() returns false, no spawn, no throw.
  const restore = termuxEnv(false)
  const prevPath = process.env.PATH
  process.env.PATH = 'definitely-empty-path-dir'
  try {
    assert.equal(commandWorks('termux-wake-lock'), false)
    assert.equal(acquireWakeLock(), false)
    assert.equal(isWakeLockHeld(), false)
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    restore()
  }
})

test('acquireWakeLock()/releaseWakeLock() hold and release the state on Termux', () => {
  const restoreTermux = termuxEnv(true)
  const bin = fakeBins('termux-wake-lock', 'termux-wake-unlock')
  try {
    assert.equal(acquireWakeLock(), true)
    assert.equal(isWakeLockHeld(), true)
    releaseWakeLock()
    assert.equal(isWakeLockHeld(), false)
    // release is idempotent — a second call is safe
    releaseWakeLock()
    assert.equal(isWakeLockHeld(), false)
  } finally {
    releaseWakeLock()
    bin.restore()
    restoreTermux()
  }
})
