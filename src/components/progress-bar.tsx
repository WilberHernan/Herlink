import React from 'react'
import {Text} from 'ink'
import {useTheme} from '../theme.js'

// The grainy track (░) appears left-to-right as the download progresses —
// nothing else on screen. No fill block, no base track, no thin line.
export function ProgressBar({percent, width = 30}: {percent: number; width?: number}) {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, percent))
  const filled = Math.round(clamped * width)
  const track = '░'.repeat(filled)
  return (
    <Text>
      <Text color={theme.muted}>{track}</Text>
      {/* fixed-width percent — "5%" vs "100%" must not change the line width */}
      <Text color={theme.muted}> {`${Math.round(clamped * 100)}%`.padStart(4)}</Text>
    </Text>
  )
}
