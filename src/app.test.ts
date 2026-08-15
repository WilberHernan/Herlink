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
