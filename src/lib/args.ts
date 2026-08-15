import {isThemeMode, type ThemeMode} from '../theme.js'

export type CliArgs = {
  help: boolean
  version: boolean
  initialUrl?: string
  themeMode?: ThemeMode
  error?: string
}

export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {help: false, version: false}
  const positional: string[] = []

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
    } else if (arg.startsWith('-')) {
      return {...result, error: `opción desconocida “${arg}”`}
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) return {...result, error: 'se esperaba una sola url'}
  result.initialUrl = positional[0]
  return result
}
