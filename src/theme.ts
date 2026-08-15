import React, {createContext, type ReactNode, useContext} from 'react'

export const THEME_MODES = ['auto', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export type Theme = {
  mode: ThemeMode
  /** Legacy accent alias — kept in the type for compatibility, mirrors `text`. */
  primary: string
  /** Legacy alias for muted secondary text. */
  gray: string
  /** Legacy dark ink color, kept in the type for compatibility. */
  dark: string
  /** Full-screen background. */
  background: string
  dimSecondary: boolean
  /** Buttons render as outlined boxes — never filled. */
  inverseButton: boolean
  /** Legacy secondary accent, kept in the type for compatibility. */
  secondary: string
  /** The ONE restrained accent — warm white, used sparingly. */
  accent: string
  success: string
  error: string
  warning: string
  info: string
  /** Frame and border lines — barely visible. */
  border: string
  /** Primary foreground. */
  text: string
  /** Dimmed foreground for secondary text. */
  muted: string
  /** Slightly-raised background — chips, key badges. */
  surface: string
  /** Selected-row background (raised selection). */
  selection: string
  /** Emphasis color — tagline, titles, the downloading line. */
  emphasized: string
}

// Auto (default): matte-black with a warm cast — the cinematic look. No
// champagne gold, no yellow, no purple — the rose reads as engraved light.
const WARM: Omit<Theme, 'mode'> = {
  primary: '#e8e5df',
  gray: '#7a7670',
  dark: '#0a0a0c',
  background: '#0a0a0c',
  dimSecondary: false,
  inverseButton: false,
  secondary: '#9fb0c8',
  accent: '#f0ede8',
  success: '#9cc5a8',
  error: '#cf7a7a',
  warning: '#b3a588',
  info: '#9fb0c8',
  border: '#2a2826',
  text: '#e8e5df',
  muted: '#7a7670',
  surface: '#121216',
  selection: '#1a1a20',
  emphasized: '#f5f3ee',
}

// Dark: PURE matte black — zero warmth, neutral grays, pure white accent.
const BLACK: Omit<Theme, 'mode'> = {
  primary: '#e8e8e8',
  gray: '#6f6f6f',
  dark: '#000000',
  background: '#000000',
  dimSecondary: false,
  inverseButton: false,
  secondary: '#a3b3c9',
  accent: '#fafafa',
  success: '#94c9a8',
  error: '#d08787',
  warning: '#b8ab8c',
  info: '#a3b3c9',
  border: '#1e1e1e',
  text: '#e8e8e8',
  muted: '#6f6f6f',
  surface: '#0b0b0b',
  selection: '#161616',
  emphasized: '#f2f2f2',
}

const LIGHT: Omit<Theme, 'mode'> = {
  primary: '#1a1a1e',
  gray: '#6f6c66',
  dark: '#f5f3ef',
  background: '#f5f3ef',
  dimSecondary: false,
  inverseButton: false,
  secondary: '#4a5a70',
  accent: '#3a3a40',
  success: '#3f7d5c',
  error: '#b05252',
  warning: '#8a7a4a',
  info: '#4a5a70',
  border: '#d8d5ce',
  text: '#1a1a1e',
  muted: '#6f6c66',
  surface: '#ffffff',
  selection: '#e8e8ec',
  emphasized: '#232327',
}

const themes: Record<ThemeMode, Theme> = {
  // auto resolves to the warm matte palette — the app's primary environment
  // is a dark Termux terminal, so the terminal's own colors are no longer
  // needed. dark is the PURE black variant (no warmth).
  auto: {mode: 'auto', ...WARM},
  light: {mode: 'light', ...LIGHT},
  dark: {mode: 'dark', ...BLACK},
}

const ThemeContext = createContext<Theme>(themes.auto)

export function themeFor(mode: ThemeMode): Theme {
  return themes[mode]
}

export function ThemeProvider({mode, children}: {mode: ThemeMode; children: ReactNode}) {
  return React.createElement(ThemeContext.Provider, {value: themeFor(mode)}, children)
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length]!
}
