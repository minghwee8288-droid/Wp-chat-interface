import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Shield, Users } from 'lucide-react'
import Modal from './Modal.jsx'
import { api } from '../lib/api.js'
import { formatNumber, avatarIndex, initials } from '../lib/format.js'

/** "2026-07-21T…" -> "3 minutes ago" */
function relativeAge(iso) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Group membership. This is a stored SNAPSHOT, not live data — membership
 * changes on WhatsApp without telling us, hence the refresh control and the
 * visible age.
 */
export default function GroupMembers({ conversation, onClose }) {
  const [members, setMembers] = useState([])
  const [syncedAt, setSyncedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = await api.groupMembers(conversation.id)
      setMembers(data.members || [])
      setSyncedAt(data.synced_at || null)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [conversation.id])

  useEffect(() => {
    load()
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const data = await api.refreshGroupMembers(conversation.id)
      setMembers(data.members || [])
      setSyncedAt(data.synced_at || null)
      if (data.warning) setError(data.warning)
    } catch (err) {
      setError(err.message)
    } finally {
      setRefreshing(false)
    }
  }

  const age = relativeAge(syncedAt)

  return (
    <Modal
      title={conversation.customer_name || 'Group'}
      subtitle={
        members.length
          ? `${members.length} member${members.length === 1 ? '' : 's'}`
          : 'Group members'
      }
      onClose={onClose}
    >
      <div className="modal-form">
        <div className="member-head">
          <span className="member-age">
            {age ? `Updated ${age}` : 'Never synced'}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={refresh}
            disabled={refreshing}
          >
            {refreshing ? <span className="spinner" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}

        {loading ? (
          <div className="member-empty">
            <span className="spinner" />
          </div>
        ) : members.length === 0 ? (
          <div className="member-empty">
            <Users size={22} />
            <span>No members recorded yet. Try refreshing.</span>
          </div>
        ) : (
          <div className="member-list">
            {members.map((m) => {
              const name = m.member_name || formatNumber(m.member_number)
              return (
                <div className="member-row" key={m.id}>
                  <span className="conv-avatar member-avatar" data-color={avatarIndex(m.member_number)}>
                    {initials(name)}
                  </span>
                  <span className="member-id">
                    <span className="member-name">{name}</span>
                    <span className="member-number">{formatNumber(m.member_number)}</span>
                  </span>
                  {m.is_admin ? (
                    <span className="member-admin" title="Group admin">
                      <Shield size={11} />
                      Admin
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}
