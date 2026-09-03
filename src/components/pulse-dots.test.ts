import assert from 'node:assert/strict'
import test from 'node:test'

test('PulseDots renders five breathing dots with warm theme colours', async () => {
  const previousForceColor = process.env.FORCE_COLOR
  const previousNoColor = process.env.NO_COLOR
  process.env.FORCE_COLOR = '3'
  delete process.env.NO_COLOR

  try {
    const [{default: React}, {renderToString}, {PulseDots}, {ThemeProvider}] = await Promise.all([
      import('react'),
      import('ink'),
      import('./pulse-dots.js'),
      import('../theme.js'),
    ])

    const renderDots = (mode: 'auto' | 'light' | 'dark', color?: string) =>
      renderToString(
        React.createElement(
          ThemeProvider,
          {
            mode,
            children: React.createElement(
              PulseDots,
              color ? {color} : undefined,
              null,
            ),
          },
        ),
      )

    // Five `●`, each wrapped in its own truecolor span, exactly like the
    // Textual indicator we port (Text.assemble(*dots) then rstrip).
    for (const mode of ['auto', 'light', 'dark'] as const) {
      const out = renderDots(mode)
      const dots = (out.match(/\u25cf/g) ?? []).length
      assert.equal(dots, 5, `five dots in ${mode} mode`)
      // every dot carries a truecolor (24-bit) foreground — no palette escapes
      assert.match(out, /\x1b\[38;2;\d+;\d+;\d+m/g, `24-bit pulse colours in ${mode}`)
    }

    // An explicit color prop is honoured: supplying a distinct accent must
    // change the pulse ramp (e.g. error/success/state colours drive the apex).
    const accentOut = renderDots('auto', '#f0ede8')
    const errorOut = renderDots('auto', '#cf7a7a')
    assert.notEqual(accentOut, errorOut, 'different color prop changes the pulse ramp')

    // Static (non-TTY) output is deterministic and trims trailing space so the
    // dots sit flush against a following message.
    const a = renderDots('auto')
    const b = renderDots('auto')
    assert.equal(a, b, 'non-TTY output is stable across renders')
    assert.ok(!a.endsWith(' '), 'no trailing space after the last dot')

    // Always on-screen content regardless of theme — no neon escape from the
    // warm palette: every rendered colour is a blend toward the accent/white,
    // so it stays in the faithful 8-bit channel range and no pure-neon
    // combination (e.g. saturated red with zero G/B) can appear.
    const rgbs = [...accentOut.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(m =>
      [+m[1]!, +m[2]!, +m[3]!],
    )
    assert.ok(rgbs.length >= 2, 'at least two colour spans (gradient present)')
    for (const [r, g, b] of rgbs) {
      assert.ok(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255, 'channel in range')
      // warm: green+blue stay close to red (grayscale-tinted white, not neons)
      assert.ok(g >= r - 40 && b >= r - 40, 'no saturated neon channel')
    }
    // the ramp's apex must reach a bright warm light (lighten of the ~240
    // accent), not park every dot in the dark base — proves the accent drives
    // the pulse rather than the fallback muted
    const brightest = rgbs.reduce((m, [r, g, b]) => Math.max(m, r, g, b), 0)
    assert.ok(brightest >= 220, 'accent ramp reaches a bright warm apex')
    // the pulse is a real gradient, not a flat uniform colour: the dot colours
    // must differ from one another
    const unique = new Set(rgbs.map(([r, g, b]) => `${r},${g},${b}`))
    assert.ok(unique.size > 1, 'dots trace a gradient, not a flat colour')
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR
    else process.env.FORCE_COLOR = previousForceColor
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
})
