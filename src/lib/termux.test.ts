import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {TERMUX_STORAGE_HINT, isSharedStorageDir, isTermux, resolveOutDir} from './termux.js'

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

test('resolveOutDir() prefers ~/storage/dcim/Camera and creates it', async () => {
  const restore = termuxEnv(true)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-termux-'))
  try {
    fs.mkdirSync(path.join(base, 'storage'), {recursive: true})
    const expected = path.join(base, 'storage', 'dcim', 'Camera')
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
  assert.equal(isSharedStorageDir(path.join(storage, 'dcim', 'Camera')), true)
  assert.equal(isSharedStorageDir(path.join(HOME, 'Downloads')), false)
  assert.equal(isSharedStorageDir(`${storage}-other`), false)
})
