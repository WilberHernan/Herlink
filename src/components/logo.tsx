import React, {useEffect, useRef, useState} from 'react'
import {Box, Text, useStdout} from 'ink'
import {type Theme, useTheme} from '../theme.js'

// The Gentle AI braille rose — copied pixel-identical from
// ~/.config/opencode/tui-plugins/gentle-logo.tsx (roseArt, lines 9-28).
// Engraved style: the rose is static in `text` — all motion lives in the
// name line below it (the hacker scramble). Never hand-redraw the art.
export const ROSE_ART = [
  '             ⣠⣾⣷⣶⣦⣤⣤⣄⣠⣄⣀  ⢀⣀⣀',
  '          ⢀⣴⣿⣿⠿⣋⣭⣭⣯⣭⣍⣭⣿⣟⠛⠛⠿⠿⣿⣷⣄',
  '      ⢀⣴⣾⡟⢻⣿⡟⠁⣼⣿⠏⣵⢻⣿⣻⣿⣿⢿⡻⣿⣿⣶⡌⢿⣿⣷⣦⣤⡄',
  '   ⣤⣶⣾⣿⣿⠏ ⠈⢿⣄ ⢹⣏⠠⠟⣾⣿⣿⣿⣿⣿⠷⣏⣼⠟⢡⣿⡟⠋⢻⣿⣿⡄',
  '   ⠈⣿⣿⣿⣿⡆   ⣽⢧⡘⠈⠳⣦⣍⠛⠛⢦⣉⣴⣛⣫⣭⣴⡟⠋  ⣾⣿⣿⡿',
  '   ⢀⠹⣿⣿⣿⣷⣤⡄ ⠋ ⠙⢆ ⣠⠴⠟⠛⣛⣛⣛⠟⠋⠁⠺⡇ ⣀⣴⣿⣿⡟⠁',
  '   ⠈⣀⠈⠛⠷⠿⣿⣿⣷⣤⣀ ⢠⠋   ⠈⠉⠉    ⣠⣴⣥⠾⠛⠉⣰⣿⣷',
  '          ⠹⣯⣝⠛⠛⠷⢶⣤⣤⣀   ⢀⡠⠖⠋⠉⢉⣀⣀⣴⣾⣿⠿⠟⠃ ⠠⠦',
  '⠁       ⠖  ⠘⠻⢿⣦⣄⡀  ⠉⠛⢦⠠⢊⠤⠴⢒⣛⣛⣩⣽⡿⠟⠁⢀⡀',
  '⠲⠶⣦⠴⠶⠶⠶⠶⡶⠶⢶⣤⣄⡀⠨⠭⠽⠟⣓⢦⣀⠈⢇⡥⠖⠛⠋⠉⠉⠉    ⠈  ⢠⡤',
  '  ⠈⢷ ⠐⠂⢤⣽⣄ ⠰⡎⠙⠳⣄⡀ ⠈⢣⠘⢦⠋⣀⡬⠟⠛⠛⠉⢀⣀⣀⣠⡤⠄⠃',
  '   ⠈⢳⣀⡒⠉⠉⣉⠙⡲⣽⣄ ⣏⠳⡄ ⠘⡇ ⡾⠁ ⢀⡤⠖⣻⣿⡏⢡⡎ ⠰⠄',
  '     ⠛⠻⢦⣄⣉⡁⣀⣀⣈⣙⣺⣌⡇⢠⢀⡇⡾  ⣴⣿⡷⠊ ⢲⣠⠟',
  '          ⠈⠉    ⠈⠳⡄⣸⢱⠇⢀⣰⣯⣭⣥⠭⠾⠛⠃',
  '                  ⡷⠡⡯⢖⠉   ⢠⠤',
  '                ⡠⢊⡴⠤⠂⠃ ⠒',
  '             ⢀⡴⢪⠔⣉⠔⠋',
  '               ⠐⠈',
]
export const ROSE_ROWS = ROSE_ART.length
const NAME = 'Herlink'

// hacker scramble — each letter cycles random terminal chars (binary-heavy
// pool), then locks in left-to-right; the whole word re-scrambles on a
// cadence. The rose stays perfectly still; this line is the only motion.
const SCRAMBLE_CHARS = '01<>-_/\\[]{}—=+*^?'
const FRAME_MS = 40
const SCRAMBLE_EVERY_MS = 7_000
const STEP = 5 // cascade step: frames between one letter locking and the next starting
const JITTER = 3 // start jitter per letter
const MIN_SPIN = 6 // min frames a letter scrambles before locking
const SPIN_SPREAD = 10 // extra random spin frames
const RECHARGE = 0.3 // chance per frame a spinning letter re-rolls its glyph

const ART_WIDTH = Math.max(...ROSE_ART.map(row => row.length))

type Phase = 'scramble' | 'idle'
type LetterPlan = {start: number; end: number}

function makePlan(text: string): LetterPlan[] {
  return text.split('').map((_, i) => {
    const start = i * STEP + Math.floor(Math.random() * JITTER)
    const end = start + MIN_SPIN + Math.floor(Math.random() * SPIN_SPREAD)
    return {start, end}
  })
}

const randomChar = () => SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]!

function scrambleCell(
  target: string,
  plan: LetterPlan,
  phase: Phase,
  frame: number,
  spinChar: string,
  theme: Theme,
): {ch: string; color: string} {
  if (phase === 'idle') return {ch: target, color: theme.accent}
  if (frame < plan.start) return {ch: target, color: theme.accent}
  if (frame < plan.end) return {ch: spinChar, color: theme.muted}
  return {ch: target, color: theme.accent}
}

function renderName(phase: Phase, frame: number, plan: LetterPlan[], spinChars: string[], theme: Theme) {
  const cells = NAME.split('').map((target, i) =>
    scrambleCell(target, plan[i]!, phase, frame, spinChars[i] ?? '0', theme),
  )
  const segments: Array<{text: string; color: string}> = []
  for (const cell of cells) {
    const last = segments[segments.length - 1]
    if (last && last.color === cell.color) last.text += cell.ch
    else segments.push({text: cell.ch, color: cell.color})
  }
  return (
    <Text bold>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color}>
          {seg.text}
        </Text>
      ))}
    </Text>
  )
}

export function Logo() {
  const theme = useTheme()
  const {stdout} = useStdout()
  const rows = stdout?.rows && stdout.rows > 1 ? stdout.rows : 24
  const cols = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  // like the plugin: below the full rose needs, fall back to a single line
  const compact = rows < ROSE_ROWS + 8 || cols < 64
  const animated = Boolean(process.stdout.isTTY)
  const [phase, setPhase] = useState<Phase>(animated ? 'scramble' : 'idle')
  const [frame, setFrame] = useState(0)
  const [plan, setPlan] = useState<LetterPlan[]>(() => makePlan(NAME))
  // per-letter glyph remembered between frames — the classic effect re-rolls
  // a spinning letter with probability RECHARGE, not every frame, so the
  // scramble breathes instead of strobing
  const spinChars = useRef<string[]>(NAME.split('').map(randomChar))
  const recycle = () => {
    spinChars.current = spinChars.current.map((ch, i) =>
      Math.random() < RECHARGE ? randomChar() : ch,
    )
  }

  useEffect(() => {
    if (!animated) return
    if (phase === 'idle') {
      const id = setTimeout(() => {
        setPlan(makePlan(NAME))
        setFrame(0)
        setPhase('scramble')
      }, SCRAMBLE_EVERY_MS)
      return () => clearTimeout(id)
    }
    const totalFrames = Math.max(...plan.map(p => p.end))
    const start = Date.now()
    const id = setInterval(() => {
      const f = Math.floor((Date.now() - start) / FRAME_MS)
      if (f >= totalFrames) {
        setFrame(0)
        setPhase('idle')
      } else {
        recycle()
        setFrame(f)
      }
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [phase, animated, plan])

  if (compact) {
    return (
      <Box flexDirection="column" flexShrink={0} alignItems="center">
        <Text bold>
          <Text color={theme.accent}>✦ </Text>
          {renderName(phase, frame, plan, spinChars.current, theme)}
          <Text color={theme.accent}> ✦</Text>
        </Text>
      </Box>
    )
  }

  return (
    // flexShrink=0 — the logo must keep its rows even when a phase's
    // content would overflow the screen, or yoga crushes it first
    <Box flexDirection="column" flexShrink={0} alignItems="center">
      {ROSE_ART.map((row, i) => (
        <Box key={i} width={ART_WIDTH}>
          <Text color={theme.text}>{row}</Text>
        </Box>
      ))}
      <Text>{' '}</Text>
      {renderName(phase, frame, plan, spinChars.current, theme)}
    </Box>
  )
}
