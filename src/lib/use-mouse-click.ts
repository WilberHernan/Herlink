import {useEffect, useRef} from 'react'
import {useStdin, useStdout} from 'ink'

// 1000h = report button presses, 1006h = SGR encoding (`ESC [ < b ; x ; y M`)
// SGR button codes: 0 = left press, 64 = wheel-up (scroll up), 65 = wheel-down (scroll down)
const ENABLE = '\u001B[?1000h\u001B[?1006h'
const DISABLE = '\u001B[?1006l\u001B[?1000l'
const SGR_PRESS = /\u001B\[<(\d+);(\d+);(\d+)M/g

export type MouseEventKind = 'click' | 'wheel-up' | 'wheel-down'

export type MouseEvent = {
  /** 1-based terminal column */
  x: number
  /** 1-based terminal row */
  y: number
  kind: MouseEventKind
}

const BUTTON_TO_KIND: Record<string, MouseEventKind> = {
  '0': 'click',
  '64': 'wheel-up',
  '65': 'wheel-down',
}

/**
 * SGR mouse button code → event kind (Termux translates touch drags and wheel
 * rotation into SGR codes: 64 = wheel-up/scroll up, 65 = wheel-down/scroll
 * down, 0 = plain press). Extracted as a pure lookup so the direction
 * contract is unit-testable.
 */
export function mouseEventKind(button: string): MouseEventKind | undefined {
  return BUTTON_TO_KIND[button]
}

/**
 * Reports terminal mouse events (left presses + wheel/scroll) as 1-based
 * (column, row) terminal cells plus a kind. Termux and other terminals
 * translate touch drags and wheel scrolling into SGR wheel events, which is
 * what makes tactile scrolling through a list work.
 *
 * While active the terminal's native text selection needs a modifier key
 * (option/shift) — the tradeoff for receiving mouse events at all.
 */
export function useMouseClick(onEvent: (event: MouseEvent) => void, isActive: boolean) {
  const handlerRef = useRef(onEvent)
  // sync the latest handler after render, not during — writing ref.current in
  // render is a React rules violation (can read stale/clobbered in a replay)
  useEffect(() => {
    handlerRef.current = onEvent
  })
  const {stdin} = useStdin()
  const {stdout} = useStdout()

  useEffect(() => {
    if (!isActive || !stdin || !stdout || !process.stdin.isTTY) return
    stdout.write(ENABLE)
    const onData = (data: Buffer | string) => {
      for (const match of String(data).matchAll(SGR_PRESS)) {
        const [, button, x, y] = match
        const kind = mouseEventKind(button)
        if (kind) handlerRef.current({x: Number(x), y: Number(y), kind})
      }
    }
    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      stdout.write(DISABLE)
    }
  }, [isActive, stdin, stdout])
}

/**
 * Mouse reports also flow through ink's keypress parsing, which strips the
 * leading ESC and hands the rest (`[<0;34;12M`) to ink-text-input as typed
 * text. Run every onChange value through this to drop the leaked reports.
 */
export const stripMouseReports = (value: string) =>
  value.replace(/\u001B?\[?<\d+;\d+;\d+[Mm]/g, '')
