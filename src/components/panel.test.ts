import assert from 'node:assert/strict'
import test from 'node:test'

test('all themes paint native border cells with the theme background', async () => {
  const previousForceColor = process.env.FORCE_COLOR
  const previousNoColor = process.env.NO_COLOR
  process.env.FORCE_COLOR = '3'
  delete process.env.NO_COLOR

  try {
    // Import after forcing truecolor so Chalk's color support is deterministic.
    const [{default: React}, {renderToString, Text}, {Panel}, {ThemeProvider}] = await Promise.all([
      import('react'),
      import('ink'),
      import('./panel.js'),
      import('../theme.js'),
    ])

    const renderPanel = (mode: 'auto' | 'light' | 'dark') =>
      renderToString(
        React.createElement(
          ThemeProvider,
          {
            mode,
            children: React.createElement(Panel, {
              title: 'Download',
              width: 20,
              children: React.createElement(Text, null, 'item'),
            }),
          },
        ),
      )

    // #f5f3ef, #000000, #0a0a0c — light is paper, dark is pure black,
    // auto resolves to the warm matte palette
    assert.match(renderPanel('light'), /\x1b\[48;2;245;243;239m/)
    assert.match(renderPanel('dark'), /\x1b\[48;2;0;0;0m/)
    assert.match(renderPanel('auto'), /\x1b\[48;2;10;10;12m/)
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = previousForceColor
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
})
