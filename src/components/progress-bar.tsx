import React from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// █ for filled, ░ for empty — fills left-to-right as download progresses.
export function ProgressBar({percent, width = 14}: {percent: number; width?: number}) {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, percent))
  const filled = Math.round(clamped * width)
  const empty = width - filled
  return (
    <Text>
      <Text color={theme.accent}>{'█'.repeat(filled)}</Text>
      <Text color={theme.muted}>{'░'.repeat(empty)}</Text>
      {/* fixed-width percent — "5%" vs "100%" must not change the line width */}
      <Text color={theme.muted}> {`${Math.round(clamped * 100)}%`.padStart(4)}</Text>
    </Text>
  )
}
