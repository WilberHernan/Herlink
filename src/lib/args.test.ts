import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', async () => {
  assert.deepEqual(await parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    urls: ['https://example.com/video'],
    themeMode: 'light',
    embedMetadata: true,
    resume: false,
    noUpdate: false,
    retries: 10,
    fragmentRetries: 10,
    retrySleep: '1',
    socketTimeout: 30,
    breakOnExisting: false,
  })
})

test('parses an equals-style theme option after the url', async () => {
  assert.deepEqual(await parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    urls: ['https://example.com/video'],
    themeMode: 'dark',
    embedMetadata: true,
    resume: false,
    noUpdate: false,
    retries: 10,
    fragmentRetries: 10,
    retrySleep: '1',
    socketTimeout: 30,
    breakOnExisting: false,
  })
})

test('collects multiple positional urls in order', async () => {
  assert.deepEqual(await parseArgs(['https://a.example/v', 'https://b.example/v', 'https://c.example/v']), {
    help: false,
    version: false,
    urls: ['https://a.example/v', 'https://b.example/v', 'https://c.example/v'],
    embedMetadata: true,
    resume: false,
    noUpdate: false,
    retries: 10,
    fragmentRetries: 10,
    retrySleep: '1',
    socketTimeout: 30,
    breakOnExisting: false,
  })
})

test('rejects missing, invalid, and unknown options', async () => {
  assert.match((await parseArgs(['--theme'])).error ?? '', /necesita un valor/)
  assert.match((await parseArgs(['--theme', 'sepia'])).error ?? '', /Tema desconocido/)
  assert.match((await parseArgs(['--wat'])).error ?? '', /Opción desconocida/)
})

test('rejects a positional that is not a url, naming it (REQ-015)', async () => {
  const result = await parseArgs(['notaurl'])
  assert.ok(result.error)
  assert.match(result.error, /notaurl/)
  assert.match(result.error, /no parece una url válida/)
  assert.equal(result.urls.length, 0)
  // a valid url next to the junk still fails — no partial run
  const mixed = await parseArgs(['https://example.com/v', 'junk'])
  assert.ok(mixed.error)
  assert.match(mixed.error, /junk/)
})

test('--best and --mp3 are mutually exclusive', async () => {
  assert.match((await parseArgs(['--best', '--mp3', 'https://example.com/v'])).error ?? '', /mutuamente excluyentes/)
  assert.match((await parseArgs(['--mp3', '--best', 'https://example.com/v'])).error ?? '', /mutuamente excluyentes/)
})

test('--best without any url fails asking for one', async () => {
  assert.match((await parseArgs(['--best'])).error ?? '', /necesitan una url/)
  assert.match((await parseArgs(['--mp3'])).error ?? '', /necesitan una url/)
})

test('--best and --mp3 set the scriptable kind', async () => {
  const best = await parseArgs(['--best', 'https://example.com/v'])
  assert.equal(best.error, undefined)
  assert.equal(best.scriptable, 'best')
  const mp3 = await parseArgs(['--mp3', 'https://example.com/v'])
  assert.equal(mp3.error, undefined)
  assert.equal(mp3.scriptable, 'mp3')
})

test('-o, --cookies and --file require a value', async () => {
  assert.match((await parseArgs(['-o'])).error ?? '', /necesita un valor/)
  assert.match((await parseArgs(['--cookies'])).error ?? '', /necesita un valor/)
  assert.match((await parseArgs(['--file'])).error ?? '', /necesita un valor/)
})

test('-o sets the outDir override', async () => {
  const result = await parseArgs(['-o', '/tmp/vids', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.outDir, '/tmp/vids')
})

test('--cookies stores its path and --file appends valid urls after positionals (REQ-016)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-args-'))
  try {
    const cookiesPath = path.join(dir, 'cookies.txt')
    fs.writeFileSync(cookiesPath, '# Netscape HTTP Cookie File\n')
    const filePath = path.join(dir, 'urls.txt')
    fs.writeFileSync(filePath, 'https://b.example/v\n\njunk line\nhttps://c.example/v\n')
    const result = await parseArgs(['--cookies', cookiesPath, '--file', filePath, 'https://a.example/v'])
    assert.equal(result.error, undefined)
    assert.equal(result.cookies, cookiesPath)
    assert.equal(result.file, filePath)
    assert.deepEqual(result.urls, ['https://a.example/v', 'https://b.example/v', 'https://c.example/v'])
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('--file with a missing path fails with a clear file error (REQ-016)', async () => {
  const result = await parseArgs(['--file', './missing-urls.txt', 'https://example.com/v'])
  assert.match(result.error ?? '', /missing-urls\.txt/)
  assert.match(result.error ?? '', /no existe o no es legible/)
})

test('--file yielding zero valid urls fails before any download (REQ-016)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-args-'))
  try {
    const filePath = path.join(dir, 'junk.txt')
    fs.writeFileSync(filePath, 'not a url\n\n@@@\n')
    const result = await parseArgs(['--file', filePath])
    assert.match(result.error ?? '', /no contiene urls válidas/)
    assert.deepEqual(result.urls, [])
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('--file trims whitespace-padded urls and never splits a line into pieces (threat matrix)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-args-'))
  try {
    const filePath = path.join(dir, 'urls.txt')
    fs.writeFileSync(filePath, '  https://example.com/v  \nhttps://example.com/a b\n')
    const result = await parseArgs(['--file', filePath])
    assert.equal(result.error, undefined)
    // the space-y line stays ONE element (never split into 'a' and 'b')
    assert.deepEqual(result.urls, ['https://example.com/v', 'https://example.com/a b'])
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('--best accepts urls from --file (REQ-002)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herlink-args-'))
  try {
    const filePath = path.join(dir, 'urls.txt')
    fs.writeFileSync(filePath, 'https://example.com/v\n')
    const result = await parseArgs(['--best', '--file', filePath])
    assert.equal(result.error, undefined)
    assert.deepEqual(result.urls, ['https://example.com/v'])
    assert.equal(result.scriptable, 'best')
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
})

test('--cookies with a missing file fails with a clear file error (REQ-008)', async () => {
  const result = await parseArgs(['--cookies', './missing-cookies.txt', 'https://example.com/v'])
  assert.match(result.error ?? '', /missing-cookies\.txt/)
  assert.match(result.error ?? '', /no existe o no es legible/)
})

test('--subs with a lang list consumes the next token', async () => {
  const result = await parseArgs(['--subs', 'es,en', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.subs, 'es,en')
  assert.deepEqual(result.urls, ['https://example.com/v'])
})

test('--subs followed by a url keeps all langs and the url positional', async () => {
  const result = await parseArgs(['--subs', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.subs, '')
  assert.deepEqual(result.urls, ['https://example.com/v'])
})

test('--subs followed by a flag keeps all langs', async () => {
  const result = await parseArgs(['--subs', '--best', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.subs, '')
  assert.equal(result.scriptable, 'best')
})

test('--subs=langs equals form', async () => {
  const result = await parseArgs(['--subs=es,en', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.subs, 'es,en')
})

test('--no-embed-metadata wins over --embed-metadata in either order', async () => {
  assert.equal((await parseArgs(['--embed-metadata', '--no-embed-metadata', 'https://example.com/v'])).embedMetadata, false)
  assert.equal((await parseArgs(['--no-embed-metadata', '--embed-metadata', 'https://example.com/v'])).embedMetadata, false)
  assert.equal((await parseArgs(['--embed-metadata', 'https://example.com/v'])).embedMetadata, true)
  // default on since the embed change; --no-embed-metadata is the escape
  assert.equal((await parseArgs(['https://example.com/v'])).embedMetadata, true)
})

test('--continue sets resume and --no-update sets noUpdate', async () => {
  const result = await parseArgs(['--continue', '--no-update', 'https://example.com/v'])
  assert.equal(result.error, undefined)
  assert.equal(result.resume, true)
  assert.equal(result.noUpdate, true)
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
test('--retries and --fragment-retries parse with defaults and custom values', async () => {
  const defaults = await parseArgs(['https://example.com/v'])
  assert.equal(defaults.retries, 10)
  assert.equal(defaults.fragmentRetries, 10)
  assert.equal(defaults.retrySleep, '1')
  assert.equal(defaults.socketTimeout, 30)
  const custom = await parseArgs(['--retries', '5', '--fragment-retries', '7', 'https://example.com/v'])
  assert.equal(custom.error, undefined)
  assert.equal(custom.retries, 5)
  assert.equal(custom.fragmentRetries, 7)
  const equals = await parseArgs(['--retries=15', '--fragment-retries=20', 'https://example.com/v'])
  assert.equal(equals.retries, 15)
  assert.equal(equals.fragmentRetries, 20)
})

test('--retries validates non-negative integers', async () => {
  assert.match((await parseArgs(['--retries', 'abc', 'https://example.com/v'])).error ?? '', /entero no negativo/)
  assert.match((await parseArgs(['--retries', '-1', 'https://example.com/v'])).error ?? '', /entero no negativo/)
  assert.match((await parseArgs(['--retries'])).error ?? '', /necesita un valor/)
  assert.match((await parseArgs(['--retries=', 'https://example.com/v'])).error ?? '', /necesita un valor/)
  assert.match((await parseArgs(['--socket-timeout', 'x', 'https://example.com/v'])).error ?? '', /entero no negativo/)
})

test('--retry-sleep parses number and fragment:exp forms', async () => {
  const simple = await parseArgs(['--retry-sleep', '1', 'https://example.com/v'])
  assert.equal(simple.retrySleep, '1')
  const exp = await parseArgs(['--retry-sleep', 'fragment:exp=1:20', 'https://example.com/v'])
  assert.equal(exp.retrySleep, 'fragment:exp=1:20')
  const equals = await parseArgs(['--retry-sleep=fragment:exp=1:20', 'https://example.com/v'])
  assert.equal(equals.retrySleep, 'fragment:exp=1:20')
  assert.match((await parseArgs(['--retry-sleep'])).error ?? '', /necesita un valor/)
})

test('--socket-timeout parses custom value', async () => {
  const r = await parseArgs(['--socket-timeout', '60', 'https://example.com/v'])
  assert.equal(r.socketTimeout, 60)
  const eq = await parseArgs(['--socket-timeout=45', 'https://example.com/v'])
  assert.equal(eq.socketTimeout, 45)
})

test('--download-archive defaults to ~/.herlink/archive.txt when flag has no value', async () => {
  const r = await parseArgs(['--download-archive', 'https://example.com/v'])
  assert.equal(r.error, undefined)
  assert.ok(r.downloadArchive?.endsWith(path.join('.herlink', 'archive.txt')))
  // with explicit path
  const explicit = await parseArgs(['--download-archive', '/tmp/my-archive.txt', 'https://example.com/v'])
  assert.equal(explicit.downloadArchive, '/tmp/my-archive.txt')
  const equalsForm = await parseArgs(['--download-archive=/tmp/a.txt', 'https://example.com/v'])
  assert.equal(equalsForm.downloadArchive, '/tmp/a.txt')
  // followed by another flag should still default
  const flagNext = await parseArgs(['--download-archive', '--best', 'https://example.com/v'])
  assert.ok(flagNext.downloadArchive?.endsWith('archive.txt'))
  assert.equal(flagNext.scriptable, 'best')
})

test('--break-on-existing sets the flag', async () => {
  const r = await parseArgs(['--break-on-existing', 'https://example.com/v'])
  assert.equal(r.breakOnExisting, true)
  const def = await parseArgs(['https://example.com/v'])
  assert.equal(def.breakOnExisting, false)
})

