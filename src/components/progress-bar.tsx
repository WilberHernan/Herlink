import React from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// Thin "line" styling (the canonical pattern from statusline-bar & similar TUIs):
// ━ for filled, ─ for empty — a single hairlines rather than chunky █/░ blocks,
// filling left-to-right as the download progresses. The percent sits to the
// right in a fixed-width field so "5%" vs "100%" never shifts the line.
export function ProgressBar({percent, width = 14}: {percent: number; width?: number}) {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, percent))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  return (
    <Text>
      <Text color={theme.accent}>{'━'.repeat(filled)}</Text>
      <Text color={theme.muted}>{'─'.repeat(empty)}</Text>
      {/* the percent reads as smaller & more sedate than the bar — muted colour
          plus dim (SGR faint) keeps it understated; terminals have no true
          smaller font, so restraint is how we get the quieter look */}
      <Text color={theme.muted} dimColor>
        {` ${Math.round(clamped * 100)}%`.padStart(5)}
      </Text>
    </Text>
  )
}
