import * as React from 'react'

const KEY = 'wander_theme'

export function useTheme() {
  const [dark, setDark] = React.useState(() =>
    document.documentElement.classList.contains('dark')
  )

  const toggle = React.useCallback(() => {
    setDark((prev) => {
      const next = !prev
      document.documentElement.classList.toggle('dark', next)
      localStorage.setItem(KEY, next ? 'dark' : 'light')
      return next
    })
  }, [])

  return { dark, toggle }
}
