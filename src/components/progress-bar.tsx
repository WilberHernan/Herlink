import React, {useEffect, useRef, useState} from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// Thin "line" styling (the canonical pattern from statusline-bar & similar TUIs):
// ━ for filled, ─ for empty — a single hairlines rather than chunky █/░ blocks,
// filling left-to-right as the download progresses. The percent sits to the
// right in a fixed-width field so "5%" vs "100%" never shifts the line.
// Cinematic spring: bar + percent share one interpolated `shown` value so they
// move in lockstep; critically-damped spring (frequency 18, damping 1.0, ~300-400ms
// settle (370-430ms effective with 16ms discretization), no overshoot) via useEffect+setInterval reusing logo.tsx FRAME_MS pattern.
export function ProgressBar({percent, width = 14}: {percent: number; width?: number}) {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, percent))
  const [shown, setShown] = useState(clamped)
  const velocityRef = useRef(0)
  const targetRef = useRef(clamped)
  const shownRef = useRef(clamped)
  targetRef.current = clamped

  useEffect(() => {
    const FRAME_MS = 16 // ~60fps — reuses logo.tsx:125 FRAME_MS pattern
    const w0 = 18 // frequency 18 rad/s — bubbles/harmonica critically damped
    const zeta = 1.0 // damping ratio 1.0 → no bounce
    const k = w0 * w0
    const c = 2 * zeta * w0
    const dt = FRAME_MS / 1000
    const id = setInterval(() => {
      const target = targetRef.current
      const prev = shownRef.current
      const velocity = velocityRef.current
      if (Math.abs(target - prev) < 0.001 && Math.abs(velocity) < 0.001) {
        velocityRef.current = 0
        shownRef.current = target
        setShown(target)
        return
      }
      const a = -k * (prev - target) - c * velocity
      let nextVelocity = velocity + a * dt
      let next = prev + nextVelocity * dt
      // clamp overshoot (numerical safety — critically damped has none analytically)
      if ((target > prev && next > target) || (target < prev && next < target)) {
        next = target
        nextVelocity = 0
      }
      velocityRef.current = nextVelocity
      shownRef.current = next
      setShown(next)
    }, FRAME_MS)
    return () => clearInterval(id)
  }, [])

  const filled = Math.round(shown * width)
  const empty = width - filled
  return (
    <Text>
      <Text color={theme.accent}>{'━'.repeat(filled)}</Text>
      <Text color={theme.muted}>{'─'.repeat(empty)}</Text>
      {/* the percent reads as smaller & more sedate than the bar — muted colour
          plus dim (SGR faint) keeps it understated; terminals have no true
          smaller font, so restraint is how we get the quieter look */}
      <Text color={theme.muted} dimColor>
        {` ${Math.round(shown * 100)}%`.padStart(5)}
      </Text>
    </Text>
  )
}
