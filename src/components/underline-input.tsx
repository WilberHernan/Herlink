import React, {type ReactNode} from 'react'
import {Box, Text} from 'ink'
import {useTheme} from '../theme.js'

/**
 * Total columns the arrow button occupies (arrow glyph + left margin).
 */
export const underlineButtonWidth = () => 3

/**
 * A modern underline-style field: a small muted caption above, an `❯` prompt
 * in accent followed by the content, and a large arrow glyph on the right of
 * the same row — no label, no box, the arrow IS the affordance. It aligns to
 * the top row (the input text), not the center of the two-row block, so it
 * sits level with the text.
 *
 * Clicks are not handled here — the app hit-tests mouse events against the
 * rendered frame (see lib/click-map.ts). `buttonDim` shows the pressed state.
 */
export function UnderlineInput({
  caption,
  width,
  button,
  buttonDim = false,
  children,
}: {
  caption?: string
  width: number
  button?: string
  buttonDim?: boolean
  children: ReactNode
}) {
  const theme = useTheme()
  const buttonW = button ? underlineButtonWidth() : 0
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {caption ? <Text color={theme.muted}>{caption}</Text> : null}
      <Box flexDirection="row" marginTop={caption ? 1 : 0} alignItems="flex-start">
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" height={1} overflow="hidden">
            <Text color={theme.accent}>❯ </Text>
            <Box flexGrow={1} height={1} overflow="hidden">
              {children}
            </Box>
          </Box>
        </Box>
        {button ? (
          <Box marginLeft={2} flexShrink={0}>
            <Text bold color={buttonDim ? theme.muted : theme.accent}>
              ➜
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
