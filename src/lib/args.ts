import fs from 'node:fs/promises'
import {isThemeMode, type ThemeMode} from '../theme.js'
import {isProbablyUrl} from './platforms.js'

export type CliArgs = {
  help: boolean
  version: boolean
  urls: string[] // positionals + --file survivors, in order
  themeMode?: ThemeMode
  scriptable?: 'best' | 'mp3' // --best/--mp3 mutual exclusion = parse error
  outDir?: string // -o; standalone, not scriptable-only
  cookies?: string // Netscape file; missing/unreadable = parse error (checked in T3)
  subs?: string // '' = all langs
  embedMetadata: boolean // resolved: --no-embed-metadata wins
  resume: boolean // --continue (opt-in, per REQ-005)
  noUpdate: boolean
  file?: string
  error?: string
}

// async on purpose: --file/--cookies need file reads at parse time (D1)
export async function parseArgs(args: string[]): Promise<CliArgs> {
  const result: CliArgs = {
    help: false,
    version: false,
    urls: [],
    embedMetadata: false,
    resume: false,
    noUpdate: false,
  }
  let noEmbed = false // --no-embed-metadata wins regardless of order (D3)

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '-h' || arg === '--help') {
      result.help = true
    } else if (arg === '-v' || arg === '--version') {
      result.version = true
    } else if (arg === '--theme') {
      const value = args[++index]
      if (!value) return {...result, error: '--theme necesita un valor: auto, light o dark'}
      if (!isThemeMode(value)) return {...result, error: `tema desconocido “${value}” — usa auto, light o dark`}
      result.themeMode = value
    } else if (arg.startsWith('--theme=')) {
      const value = arg.slice('--theme='.length)
      if (!isThemeMode(value)) return {...result, error: `tema desconocido “${value}” — usa auto, light o dark`}
      result.themeMode = value
    } else if (arg === '--best' || arg === '--mp3') {
      const kind = arg === '--best' ? 'best' : 'mp3'
      if (result.scriptable && result.scriptable !== kind) {
        return {...result, error: '--best y --mp3 son mutuamente excluyentes'}
      }
      result.scriptable = kind
    } else if (arg === '-o' || arg === '--cookies' || arg === '--file') {
      const value = args[++index]
      if (!value) return {...result, error: `“${arg}” necesita un valor`}
      if (arg === '-o') result.outDir = value
      else if (arg === '--cookies') result.cookies = value
      else result.file = value
    } else if (arg === '--subs') {
      // optional value: consume the next token only when it is neither a flag
      // nor a url — lang lists are comma-strings, urls are positionals (D2)
      const next = args[index + 1]
      if (next && !next.startsWith('-') && !isProbablyUrl(next)) {
        result.subs = next
        index++
      } else {
        result.subs = ''
      }
    } else if (arg.startsWith('--subs=')) {
      result.subs = arg.slice('--subs='.length)
    } else if (arg === '--embed-metadata') {
      if (!noEmbed) result.embedMetadata = true
    } else if (arg === '--no-embed-metadata') {
      noEmbed = true
      result.embedMetadata = false
    } else if (arg === '--continue') {
      result.resume = true
    } else if (arg === '--no-update') {
      result.noUpdate = true
    } else if (arg.startsWith('-')) {
      return {...result, error: `opción desconocida “${arg}”`}
    } else {
      result.urls.push(arg)
    }
  }

  // --file read at parse time (D1, REQ-016): newline-separated urls, junk
  // lines filtered, survivors appended after the positionals
  if (result.file) {
    let content: string
    try {
      content = await fs.readFile(result.file, 'utf8')
    } catch {
      return {...result, error: `el archivo “${result.file}” no existe o no es legible`}
    }
    const fromFile = content
      .split('\n')
      .map(line => line.trim())
      .filter(isProbablyUrl)
    if (fromFile.length === 0) {
      return {...result, error: `“${result.file}” no contiene urls válidas`}
    }
    result.urls.push(...fromFile)
  }

  if (result.scriptable && result.urls.length === 0) {
    return {...result, error: '--best/--mp3 necesitan una url o --file'}
  }
  if (result.cookies) {
    // missing or unreadable cookies file fails at parse, before any probe or
    // download (D1, REQ-008)
    try {
      await fs.access(result.cookies, fs.constants.R_OK)
    } catch {
      return {...result, error: `el archivo de cookies “${result.cookies}” no existe o no es legible`}
    }
  }
  return result
}
