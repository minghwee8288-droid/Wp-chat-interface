import { useState } from 'react'
import { Send } from 'lucide-react'
import Modal from './Modal.jsx'
import { api } from '../lib/api.js'

/**
 * Start a conversation with a number that has not messaged in yet.
 * The server normalises the number the same way the inbound webhook does, so
 * this never creates a duplicate of an existing conversation.
 */
export default function NewMessageModal({ onClose, onCreated }) {
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)

  const digits = phone.replace(/\D/g, '')

  const submit = async (e) => {
    e.preventDefault()
    setError(null)

    // Mirrors the server's rule so the common typo is caught without a round trip.
    if (digits.length < 8 || digits.length > 15) {
      setError('Enter a valid number in international format, e.g. +91 98765 43210')
      return
    }
    if (!message.trim()) {
      setError('Enter a message to send')
      return
    }

    setSending(true)
    try {
      const data = await api.newConversation({
        phone,
        name: name.trim() || null,
        message: message.trim(),
      })
      onCreated(data.conversation_id)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      title="New message"
      subtitle="Start a conversation with a number."
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="field">
          <label className="label" htmlFor="nm-phone">
            Phone number
          </label>
          <input
            id="nm-phone"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+91 98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            autoFocus
          />
          <span className="field-hint">
            Include the country code. Spaces and symbols are ignored.
          </span>
        </div>

        <div className="field">
          <label className="label" htmlFor="nm-name">
            Contact name <span className="field-optional">optional</span>
          </label>
          <input
            id="nm-name"
            className="input"
            autoComplete="off"
            placeholder="Anita Rao"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="nm-message">
            Message
          </label>
          <textarea
            id="nm-message"
            className="reply-input nm-textarea"
            rows={3}
            placeholder="Write the first message…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? <span className="spinner" /> : <Send size={15} />}
            Send
          </button>
        </div>
      </form>
    </Modal>
  )
}
