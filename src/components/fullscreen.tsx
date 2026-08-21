import React, {type ReactNode} from 'react'
import {Box, useWindowSize} from 'ink'
import {useTheme} from '../theme.js'

export function FullScreen({children}: {children: ReactNode}) {
  const theme = useTheme()
  const {columns, rows} = useWindowSize()

  return (
    <Box
      width={columns}
      height={rows - 1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.background}
    >
      {/* single wrapper so centering leftover lands on ONE node: when the
          leftover is odd, yoga gives every direct child a *.5 y-position and
          rounds each one independently — spacer rows collapse into their
          neighbors while extra blanks open up elsewhere */}
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        {children}
      </Box>
    </Box>
  )
}
