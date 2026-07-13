export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'themeMode'

const BG = { dark: '#08060A', light: '#F5EFE2' } as const

export const getThemeMode = (): ThemeMode =>
  wx.getStorageSync(STORAGE_KEY) === 'light' ? 'light' : 'dark'

export const getThemeClass = (): string =>
  getThemeMode() === 'light' ? 'theme-light' : ''

// Syncs the native pull-down/overscroll chrome (outside our own WXML tree,
// so CSS variables can't reach it) to the current theme.
const applyNativeChrome = (mode: ThemeMode) => {
  const backgroundColor = BG[mode]
  wx.setBackgroundColor({ backgroundColor, backgroundColorTop: backgroundColor, backgroundColorBottom: backgroundColor })
  wx.setBackgroundTextStyle({ textStyle: mode === 'light' ? 'dark' : 'light' })
}

export const setThemeMode = (mode: ThemeMode) => {
  wx.setStorageSync(STORAGE_KEY, mode)
  applyNativeChrome(mode)
}

export const toggleThemeMode = (): ThemeMode => {
  const next: ThemeMode = getThemeMode() === 'dark' ? 'light' : 'dark'
  setThemeMode(next)
  return next
}

// Call once on app launch so the native chrome matches a theme chosen in a
// previous session (setBackgroundColor doesn't persist across relaunches).
export const applyStoredTheme = () => {
  applyNativeChrome(getThemeMode())
}
