import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import { InboxProvider } from './context/InboxContext.jsx'
import { ChannelProvider } from './context/ChannelContext.jsx'
import { listenForInteraction } from './lib/chime.js'
import Shell from './components/Shell.jsx'
import Login from './pages/Login.jsx'
import Inbox from './pages/Inbox.jsx'
import Team from './pages/Team.jsx'
import Sync from './pages/Sync.jsx'

/** Cold-start placeholder. Reuses existing classes — no new UI. */
function Booting() {
  return (
    <div className="login-page">
      <span className="spinner" style={{ color: 'var(--text-3)' }} />
    </div>
  )
}

function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

function AppRoutes() {
  const { isLoading } = useAuth()

  // Hold every route until the refresh resolves, otherwise RequireAuth would
  // bounce an authenticated user to /login for a frame — the flash that makes
  // this feel broken.
  if (isLoading) return <Booting />

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <ChannelProvider>
              <InboxProvider>
                <Shell />
              </InboxProvider>
            </ChannelProvider>
          </RequireAuth>
        }
      >
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/team" element={<Team />} />
        <Route path="/sync" element={<Sync />} />
      </Route>
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  )
}

export default function App() {
  // Browsers block Web Audio until the user interacts; arm the chime on the first one.
  useEffect(() => listenForInteraction(), [])

  return (
    <BrowserRouter>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
