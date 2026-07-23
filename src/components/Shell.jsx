import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
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
  AlertTriangle,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import { useInbox } from '../context/InboxContext.jsx'
import { useChannel, formatUptime } from '../context/ChannelContext.jsx'
import { initials } from '../lib/format.js'
import { armAudio } from '../lib/chime.js'
import ChangePasswordModal from './ChangePasswordModal.jsx'
import AccountMenuExtras from './AccountMenuExtras.jsx'
import PushDiagnostics from './PushDiagnostics.jsx'

export default function Shell() {
  const { user, isAdmin, logout } = useAuth()
  const { isDark, toggleTheme, soundOn, toggleSound } = useTheme()
  const { totalUnread, mobileView } = useInbox()
  const channel = useChannel()
  const location = useLocation()
  const navigate = useNavigate()

  const [menuOpen, setMenuOpen] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  // TEMPORARY — remove with the push diagnostics panel.
  const [showDiagnostics, setShowDiagnostics] = useState(false)
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

  const title = location.pathname.startsWith('/team')
    ? 'Team'
    : location.pathname.startsWith('/sync')
      ? 'Sync'
      : 'Inbox'

  return (
    <div className="shell" data-mobile-view={mobileView}>
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

        {isAdmin ? (
          <NavLink
            to="/sync"
            className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}
            title="Sync missed messages"
            aria-label="Sync missed messages"
          >
            <RefreshCw size={18} />
          </NavLink>
        ) : null}

        <div className="rail-spacer" />
      </nav>

      <div className="main">
        {/* Shown to agents as well as admins: when the channel is down nothing
            arrives, and an agent staring at a silent inbox needs to know why. */}
        {channel.disconnected ? (
          <div className="channel-banner" role="status">
            <AlertTriangle size={15} />
            <span>
              WhatsApp is disconnected — messages are not being sent or received.
            </span>
          </div>
        ) : null}

        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <div className="topbar-spacer" />

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
            </button>

            {menuOpen ? (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <div className="menu-head-name">{user?.name}</div>
                  <div className="menu-head-email">{user?.email}</div>
                </div>

                {isAdmin ? (
                  <div className={`menu-channel${channel.disconnected ? ' is-down' : ''}`}>
                    {channel.disconnected ? <WifiOff size={14} /> : <Wifi size={14} />}
                    <span style={{ flex: 1 }}>
                      {channel.disconnected ? 'Disconnected' : 'Connected'}
                      {channel.status ? ` · ${channel.status}` : ''}
                    </span>
                    {formatUptime(channel.uptime) ? (
                      <span className="menu-item-state">{formatUptime(channel.uptime)}</span>
                    ) : null}
                  </div>
                ) : null}

                {/* Admin-only, and the only route to team management now that
                    the mobile bottom nav is gone. */}
                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/team')
                    }}
                  >
                    <Users size={15} />
                    Team
                  </button>
                ) : null}

                {isAdmin ? (
                  <button
                    type="button"
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      navigate('/sync')
                    }}
                  >
                    <RefreshCw size={15} />
                    Sync missed messages
                  </button>
                ) : null}

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    // Unmuting counts as the interaction that unblocks Web Audio.
                    armAudio()
                    toggleSound()
                  }}
                >
                  {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  <span style={{ flex: 1 }}>Sound</span>
                  <span className="menu-item-state">{soundOn ? 'On' : 'Off'}</span>
                </button>

                <button
                  type="button"
                  className="menu-item"
                  role="menuitem"
                  onClick={toggleTheme}
                >
                  {isDark ? <Sun size={15} /> : <Moon size={15} />}
                  <span style={{ flex: 1 }}>Theme</span>
                  <span className="menu-item-state">{isDark ? 'Dark' : 'Light'}</span>
                </button>

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

                <AccountMenuExtras
                  onAction={() => setMenuOpen(false)}
                  onOpenDiagnostics={() => setShowDiagnostics(true)}
                />

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

      {showDiagnostics ? (
        <PushDiagnostics onClose={() => setShowDiagnostics(false)} />
      ) : null}
    </div>
  )
}
