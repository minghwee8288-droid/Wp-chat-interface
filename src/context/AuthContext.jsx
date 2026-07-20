import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, setToken, setUnauthorizedHandler } from '../lib/api.js'

const STORAGE_KEY = 'wpchat.session'

const AuthContext = createContext(null)

// sessionStorage only — never localStorage.
function readSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.token && parsed?.user ? parsed : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => {
    const stored = readSession()
    if (stored) setToken(stored.token)
    return stored
  })

  const logout = useCallback(() => {
    setToken(null)
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* private mode */
    }
    setSession(null)
  }, [])

  // Any 401 from the API layer drops us back to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  const login = useCallback(async (email, password) => {
    const data = await api.login(email, password)
    const next = { token: data.token, user: data.user }
    setToken(next.token)
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* in-memory still works */
    }
    setSession(next)
    return next
  }, [])

  const value = useMemo(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      isAuthenticated: Boolean(session?.token),
      isAdmin: session?.user?.role === 'admin',
      login,
      logout,
    }),
    [session, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
