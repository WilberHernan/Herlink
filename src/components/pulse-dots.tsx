import React, {useEffect, useState} from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// PulseDots — a soft "breathing" spinner, a port of Textual's loading
// indicator (src/textual/widgets/_loading_indicator.py). Instead of rotating
// braille glyphs (ink-spinner dots) it is five `●` dots whose brightness
// ramps up and fades away along a warm gradient — background → color →
// lighten(color) — with a `(1-blend)²` easing curve and a per-dot stagger.
// The result reads as a quiet pulse of light, not mechanical spinning, which
// matches herlink's hairline + warm-cast cinematic look. Motion is pure color
// (no geometry), so it never fights the thin ━/─ bars elsewhere on screen.
//
// Style guardrails: everything derives from theme tokens (never hardcoded
// neon), ~16 fps (the same "time-based, setInterval-driven" idiom logo.tsx
// uses at FRAME_MS=40), and it freezes to a static state when the output is
// not a TTY so snapshots/tests are deterministic.

/** Number of pulsing dots — mirrors Textual's LoadingIndicator. */
const DOTS = 5
/** Gradient sweep speed in dots-per-second (Textual uses 0.8). */
const SPEED = 0.8
/** Stagger offset between consecutive dots, in phase-turns of the loop
 *  (Textual uses dot_number / 8). */
const STAGGER = 1 / 8
/** Animation cadence — ~16 fps, `auto_refresh = 1/16` in Textual. */
const FRAME_MS = 62

// ── colour helpers (hex only, the shape herlink's theme uses) ─────────────
// No colour library is present, so blending/lightening is a tiny pure
// function here. Everything stays in the warm matte palette.

type RGB = [number, number, number]

/**
 * Parse a hex colour into [r,g,b]. Tolerant of an optional leading `#` and
 * 3/6-digit shorthand (herlink themes only ship 6-digit hex, but the guard
 * keeps us safe). Anything else — `rgba(...)`, `#fff1`, `transparent`,
 * malformed input — yields a neutral fallback ([0,0,0]) so blending can never
 * produce NaN, ignoring the unsupported alpha channel. This is defensive:
 * callers only ever pass theme tokens, but a bad token must not crash the UI.
 */
function hexToRgb(hex: string): RGB {
  const clean = String(hex).trim().replace(/^#/, '')
  // reject anything that isn't 3/6 hex digits (also covers rgba(...) format)
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean)) return [0, 0, 0]
  const value = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean
  const parsed = parseInt(value, 16)
  if (Number.isNaN(parsed)) return [0, 0, 0]
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff]
}

function rgbToHex([r, g, b]: RGB): string {
  const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** Linear blend `t` (0..1) between two hex colours. */
function blend(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t])
}

/** Pull a colour slightly toward pure white by `amt` (0..1). */
function lighten(color: string, amt = 0.1): string {
  return blend(color, '#ffffff', amt)
}

/** Weighted colour at phase position `t` (0..1) along the pulse ramp:
 *  bright base at 0, pure accent at 0.7, topped with a touch of light. */
function rampColor(base: string, accent: string, t: number): string {
  // stops: 0.0 -> base.blend(accent, 0.1), 0.7 -> accent, 1.0 -> lighten(accent)
  const stops: Array<[number, string]> = [
    [0.0, blend(base, accent, 0.1)],
    [0.7, accent],
    [1.0, lighten(accent)],
  ]
  // find the segment containing t and interpolate within it
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]!
    const [t1, c1] = stops[i + 1]!
    if (t <= t1) {
      const span = t1 - t0 || 1
      return blend(c0, c1, (t - t0) / span)
    }
  }
  return accent
}

/** One fully-static frame of the pulse (used for snapshots & non-TTY). */
function pulseFrame(elapsedMs: number, base: string, accent: string): Array<{ch: string; color: string}> {
  const elapsed = elapsedMs / 1000
  const dots: Array<{ch: string; color: string}> = []
  for (let d = 0; d < DOTS; d++) {
    // (%) in JS keeps the dividend's sign, so a negative raw phase (early
    // frames where d*STAGGER exceeds elapsed*SPEED) would wrap into (0,..]
    // rather than [0,1); normalize the remainder to always sit in [0,1).
    const raw = elapsed * SPEED - d * STAGGER
    const blendPos = ((raw % 1) + 1) % 1
    const pos = (1 - blendPos) ** 2 // Textual's easing
    dots.push({ch: '\u25cf', color: rampColor(base, accent, pos)})
  }
  return dots
}

export function PulseDots({color}: {color?: string}) {
  const theme = useTheme()
  const accent = color ?? theme.muted
  const base = theme.background
  const animated = Boolean(process.stdout.isTTY)
  // `frame` counts straight ms so the gradient runs on wall-clock time,
  // independent of exactly when React re-renders — same trick as logo.tsx.
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!animated) return
    const id = setInterval(() => setNow(Date.now()), FRAME_MS)
    return () => clearInterval(id)
  }, [animated])

  const dots = pulseFrame(now - start, base, accent)
  // assemble like Textual's `Text.assemble(*dots)` then rstrip the trailing
  // space so five dots sit flush against the message that follows
  return (
    <Text>
      {dots.map((dot, i) => (
        <Text key={i} color={dot.color}>
          {dot.ch}
          {i < dots.length - 1 ? ' ' : ''}
        </Text>
      ))}
    </Text>
  )
}
