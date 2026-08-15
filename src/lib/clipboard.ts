import {execFileSync} from 'node:child_process'
import {isTermux, TERMUX_API_HINT} from './termux.js'

const COMMANDS: Array<[string, string[]]> =
  process.platform === 'darwin'
    ? [['pbpaste', []]]
    : process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-selection', 'clipboard', '-o']],
          ['xsel', ['--clipboard', '--output']],
        ]

// evaluated per call, not at module load — the env must be read when the
// clipboard is read, so tests can flip the Termux detection between cases
export function clipboardBackends(): Array<[string, string[]]> {
  return isTermux() ? [['termux-clipboard-get', []]] : COMMANDS
}

export function readClipboard(): string {
  for (const [command, args] of clipboardBackends()) {
    try {
      return execFileSync(command, args, {encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore']})
    } catch (error) {
      // hint only when the tool is missing (ENOENT); an empty clipboard exits
      // non-zero without ENOENT and must not show the install hint
      if (isTermux() && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        process.stderr.write(TERMUX_API_HINT + '\n')
      }
    }
  }
  return ''
}
