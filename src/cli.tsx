import React from 'react'
import {createRequire} from 'node:module'
import {render} from 'ink'
import {App, type Outcome} from './app.js'
import {captureFrames} from './lib/click-map.js'
import {parseArgs} from './lib/args.js'
import {readClipboard} from './lib/clipboard.js'
import {isProbablyUrl} from './lib/platforms.js'
import {runScriptable} from './lib/queue.js'
import {resolveOutDir} from './lib/termux.js'
import {ensureYtDlp} from './lib/ytdlp.js'

// read at runtime from the shipped package.json so npm version bumps
// can't drift from a hardcoded constant
const VERSION: string = createRequire(import.meta.url)('../package.json').version

const HELP = `
  herlink

  Uso
    $ herlink [url]

  Ejemplos
    $ herlink https://youtu.be/dQw4w9WgXcQ
    $ herlink https://x.com/user/status/123456
    $ herlink                 (pide una url)

  Opciones
    --theme <modo>  usa auto, light o dark en esta ejecución
    --best          baja la mejor calidad sin interactividad
    --mp3           baja solo el audio (mp3) sin interactividad
    -o <directorio> carpeta de destino (reemplaza ~/Downloads)
    -h, --help      muestra esta ayuda
    -v, --version   muestra la versión

  Las descargas se guardan en ~/Downloads (~/storage/documents/Videos Termux en Termux).
  Impulsado por yt-dlp — YouTube, X, Instagram, Threads, TikTok y más de 1800 sitios.
`

const args = await parseArgs(process.argv.slice(2))

if (args.error) {
  console.error(`herlink: ${args.error}\nPrueba con “herlink --help” para ver el uso.`)
  process.exit(1)
}

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

if (args.version) {
  console.log(VERSION)
  process.exit(0)
}

const initialUrl = args.urls[0]
const initialThemeMode = args.themeMode ?? 'auto'

const isTTY = Boolean(process.stdout.isTTY)

// scriptable mode: headless, no Ink render, no alt-screen (D10, REQ-003)
if (args.scriptable && !isTTY) {
  try {
    const ytdlp = await ensureYtDlp(status => process.stderr.write(status + '\n'))
    const outDir = args.outDir ?? (await resolveOutDir()).dir
    const outcome = await runScriptable(
      ytdlp,
      args.urls.map(url => ({url})),
      {outDir, scriptable: args.scriptable},
    )
    // runScriptable already printed filepaths (stdout) and errors (stderr)
    process.exit(outcome.errors.length > 0 || outcome.cancelled ? 1 : 0)
  } catch (error) {
    console.error(`herlink: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// no url given — offer the clipboard url (⇥ to paste) when it already holds one
let clipboardUrl: string | undefined
if (!initialUrl && isTTY) {
  const clipped = readClipboard().trim()
  // reject multi-line clipboard content — new URL() silently strips newlines
  if (clipped && !/\s/.test(clipped) && isProbablyUrl(clipped)) clipboardUrl = clipped
}
const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H')
// also switch mouse tracking off — a crash can skip React effect cleanup
const leaveAltScreen = () => process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l')

if (isTTY) {
  enterAltScreen()
  process.on('exit', leaveAltScreen)
  // restore the terminal BEFORE a crash prints, or the stack trace is
  // wiped along with the alternate screen and the app looks like it
  // silently quit
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      leaveAltScreen()
      console.error(error)
      process.exit(1)
    })
  }
}

let outcome: Outcome = {}
const {waitUntilExit} = render(
  <App
    initialUrl={initialUrl}
    clipboardUrl={clipboardUrl}
    initialThemeMode={initialThemeMode}
    outDirOverride={args.outDir}
    onOutcome={result => (outcome = result)}
  />,
  // keep a copy of every frame so clicks can be hit-tested against it
  {stdout: captureFrames(process.stdout)},
)

await waitUntilExit()

if (isTTY) leaveAltScreen()
for (const filepath of outcome.filepaths ?? []) {
  console.log(`✓ descargado → ${filepath}`)
}
