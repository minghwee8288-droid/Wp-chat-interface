import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Inbox as InboxIcon,
  Users,
  MessageSquare,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  KeyRound,
  LogOut,
  ChevronDown,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { useInbox } from '../context/InboxContext.jsx'
import { initials } from '../lib/format.js'
import { armAudio } from '../lib/chime.js'
import ChangePasswordModal from './ChangePasswordModal.jsx'
import AccountMenuExtras from './AccountMenuExtras.jsx'

export default function Shell() {
  const { user, isAdmin, logout } = useAuth()
  const { isDark, toggleTheme, soundOn, toggleSound } = useTheme()
  const { totalUnread } = useInbox()
  const location = useLocation()

  const [menuOpen, setMenuOpen] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const title = location.pathname.startsWith('/team') ? 'Team' : 'Inbox'

  return (
    <div className="shell">
      <nav className="rail" aria-label="Primary">
        <div className="rail-mark" aria-hidden="true">
          <MessageSquare size={17} />
        </div>

        <NavLink
          to="/inbox"
          className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
          title="Inbox"
          aria-label={totalUnread > 0 ? `Inbox, ${totalUnread} unread` : 'Inbox'}
        >
          <InboxIcon size={19} />
          {totalUnread > 0 ? (
            <span className="rail-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>
          ) : null}
        </NavLink>

        {isAdmin ? (
          <NavLink
            to="/team"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Team"
            aria-label="Team"
          >
            <Users size={19} />
          </NavLink>
        ) : null}

        <div className="rail-spacer" />
      </nav>

      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <div className="topbar-spacer" />

          <button
            type="button"
            className="icon-btn"
            aria-label={soundOn ? 'Mute notification sound' : 'Unmute notification sound'}
            title={soundOn ? 'Sound on' : 'Sound muted'}
            onClick={() => {
              // Unmuting counts as the interaction that unblocks Web Audio.
              armAudio()
              toggleSound()
            }}
          >
            {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Light theme' : 'Dark theme'}
            onClick={toggleTheme}
          >
            {isDark ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          <div className="user-menu" ref={menuRef}>
            <button
              type="button"
              className="user-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="avatar" aria-hidden="true">
                {initials(user?.name)}
              </span>
              <span className="user-name">{user?.name}</span>
              <ChevronDown size={14} style={{ color: 'var(--text-3)' }} />
            </button>

            {menuOpen ? (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div className="menu-head-name">{user?.name}</div>
                  <div className="menu-head-email">{user?.email}</div>
                </div>

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setChangingPassword(true)
                  }}
                >
                  <KeyRound size={15} />
                  Change password
                </button>

                <AccountMenuExtras onAction={() => setMenuOpen(false)} />

                <button
                  type="button"
                  className="menu-item menu-item-danger"
                  role="menuitem"
                  onClick={logout}
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <Outlet />
      </div>

      {changingPassword ? (
        <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      ) : null}
    </div>
  )
}
