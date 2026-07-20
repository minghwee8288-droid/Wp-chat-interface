import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import { ToastProvider } from './context/ToastContext.jsx'
import { InboxProvider } from './context/InboxContext.jsx'
import { listenForInteraction } from './lib/chime.js'
import Shell from './components/Shell.jsx'
import Login from './pages/Login.jsx'
import Inbox from './pages/Inbox.jsx'
import Team from './pages/Team.jsx'

function RequireAuth({ children }) {
  const { isAuthenticated } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <InboxProvider>
              <Shell />
            </InboxProvider>
          </RequireAuth>
        }
      >
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/team" element={<Team />} />
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
