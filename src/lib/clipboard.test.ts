import assert from 'node:assert/strict'
import {mock} from 'node:test'
import test from 'node:test'
import {clipboardBackends, readClipboard} from './clipboard.js'

const PREFIX = '/data/data/com.termux/files/usr'

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

function withPath(dir: string): () => void {
  const prevPath = process.env.PATH
  process.env.PATH = dir
  return () => {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
  }
}

test('clipboardBackends() on Termux reads via termux-clipboard-get', () => {
  const restoreTermux = termuxEnv(true)
  try {
    assert.deepEqual(clipboardBackends(), [['termux-clipboard-get', []]])
  } finally {
    restoreTermux()
  }
})

test('clipboardBackends() on desktop keeps the platform default first', () => {
  const restoreTermux = termuxEnv(false)
  try {
    const expectedFirst =
      process.platform === 'darwin' ? 'pbpaste' : process.platform === 'win32' ? 'powershell' : 'wl-paste'
    assert.equal(clipboardBackends()[0]?.[0], expectedFirst)
  } finally {
    restoreTermux()
  }
})

test('readClipboard() on Termux without termux-api degrades to "" and hints', () => {
  const restoreTermux = termuxEnv(true)
  const restorePath = withPath('/nonexistent')
  const writeMock = mock.method(process.stderr, 'write', () => true)
  try {
    assert.equal(readClipboard(), '')
    assert.equal(writeMock.mock.callCount(), 1)
    assert.match(String(writeMock.mock.calls[0]?.arguments[0]), /pkg install termux-api/)
  } finally {
    writeMock.mock.restore()
    restorePath()
    restoreTermux()
  }
})
