const STORAGE_KEY = 'themeMode'

const BG = {
  dark: '#08060A',
  light: '#F5EFE2',
}

const getThemeMode = () =>
  wx.getStorageSync(STORAGE_KEY) === 'light' ? 'light' : 'dark'

const getThemeClass = () =>
  getThemeMode() === 'light' ? 'theme-light' : ''

const applyNativeChrome = (mode) => {
  const backgroundColor = BG[mode]

  wx.setBackgroundColor({
    backgroundColor,
    backgroundColorTop: backgroundColor,
    backgroundColorBottom: backgroundColor,
  })

  wx.setBackgroundTextStyle({
    textStyle: mode === 'light' ? 'dark' : 'light',
  })
}

const setThemeMode = (mode) => {
  wx.setStorageSync(STORAGE_KEY, mode)
  applyNativeChrome(mode)
}

const toggleThemeMode = () => {
  const next = getThemeMode() === 'dark' ? 'light' : 'dark'
  setThemeMode(next)
  return next
}

const applyStoredTheme = () => {
  applyNativeChrome(getThemeMode())
}

module.exports = {
  getThemeMode,
  getThemeClass,
  setThemeMode,
  toggleThemeMode,
  applyStoredTheme,
}
