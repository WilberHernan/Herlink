import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /necesita un valor/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /tema desconocido/)
  assert.match(parseArgs(['--wat']).error ?? '', /opción desconocida/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /una sola url/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto resolves to the warm palette while light and dark stay explicit', () => {
  assert.equal(themeFor('auto').mode, 'auto')
  assert.equal(themeFor('auto').background, '#0a0a0c')
  assert.equal(themeFor('auto').primary, '#e8e5df')

  assert.equal(themeFor('light').background, '#f5f3ef')
  assert.equal(themeFor('light').primary, '#1a1a1e')
  assert.equal(themeFor('dark').background, '#000000')
  assert.equal(themeFor('dark').primary, '#e8e8e8')
})
