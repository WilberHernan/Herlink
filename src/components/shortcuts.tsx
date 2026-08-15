import React, {type ReactNode} from 'react'
import {Box, Text} from 'ink'
import {useTheme} from '../theme.js'

/**
 * Discreet footer: one line of shortcuts.
 * Keys render in plain `text` (no chips), labels in `muted`, joined by
 * `  ·  ` in `border`. The `${key} ${label}` substring is kept intact so the
 * click-map keeps matching (e.g. `↵ bajar`, `^c salir`). `leading` renders
 * before the items, joined by the same separator.
 */
export function Shortcuts({
  items,
  leading,
}: {
  items: Array<[key: string, label: string]>
  leading?: ReactNode
}) {
  const theme = useTheme()
  return (
    <Box flexDirection="column" alignItems="center">
      <Box>
        <Text>
          {leading ? (
            <>
              {leading}
              <Text color={theme.border}>{'  ·  '}</Text>
            </>
          ) : null}
          {items.map(([key, label], index) => (
            <Text key={`${key}-${label}`}>
              {index > 0 ? <Text color={theme.border}>{'  ·  '}</Text> : null}
              <Text color={theme.text}>{key}</Text>
              <Text color={theme.muted}> {label}</Text>
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  )
}
