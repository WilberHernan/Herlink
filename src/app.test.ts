import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {resolveInitialOutDir} from './app.js'

test('-o outDir override wins over the default Downloads dir', () => {
  assert.equal(resolveInitialOutDir('/sdcard/Videos', '/home/user'), '/sdcard/Videos')
})

test('without -o the initial outDir is ~/Downloads', () => {
  assert.equal(resolveInitialOutDir(undefined, '/home/user'), path.join('/home/user', 'Downloads'))
})

test('App with initialUrls renders the probing phase showing the first url (REQ-015)', async () => {
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
    assert.match(output, /https:\/\/example\.com\/v/, 'the first queue url must appear in the probing phase')
    assert.match(output, /preparando/, 'the probing status must show while the queue starts')
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = previousForceColor
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
})
