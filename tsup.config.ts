import {defineConfig} from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: 'esm',
  target: 'node18',
  clean: true,
  // ffmpeg-static is no longer a dependency (REQ-07); the desktop lazy import
  // stays in ytdlp.ts, so esbuild must not try to bundle the removed package.
  external: ['ffmpeg-static'],
  banner: {js: '#!/usr/bin/env node'},
})
