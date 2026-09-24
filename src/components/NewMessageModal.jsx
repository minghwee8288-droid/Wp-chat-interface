import { useState } from 'react'
import { Send } from 'lucide-react'
import Modal from './Modal.jsx'
import { api } from '../lib/api.js'
import { useAccounts } from '../context/AccountContext.jsx'
import { CONTACT_TYPES, COUNTRIES } from '../../functions/_lib/contactMeta.js'

/**
 * Start a conversation with a number that has not messaged in yet.
 * The server normalises the number the same way the inbound webhook does, so
 * this never creates a duplicate of an existing conversation.
 */
export default function NewMessageModal({ onClose, onCreated }) {
  const { accounts, hasMultiple, accountId: selectedAccountId } = useAccounts()

  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [contactType, setContactType] = useState('')
  const [country, setCountry] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)

  // Which number the message goes out FROM. Defaults to the account currently
  // selected in the inbox; in the "All accounts" view there is no such choice,
  // so it falls back to the first account the user can use.
  const [accountId, setAccountId] = useState(
    () => selectedAccountId ?? (accounts.length ? accounts[0].id : null)
  )

  const digits = phone.replace(/\D/g, '')

  const submit = async (e) => {
    e.preventDefault()
    setError(null)

    // Mirrors the server's rule so the common typo is caught without a round trip.
    if (digits.length < 8 || digits.length > 15) {
      setError('Enter a valid number in international format, e.g. +91 98765 43210')
      return
    }
    if (!name.trim()) {
      setError('Enter a contact name')
      return
    }
    if (!contactType) {
      setError('Choose who this contact is')
      return
    }
    if (!country) {
      setError('Choose a country of origin')
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
        name: name.trim(),
        contact_type: contactType,
        country_of_origin: country,
        message: message.trim(),
        ...(accountId ? { account_id: accountId } : {}),
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

        {/* Only when there is a real choice to make. */}
        {hasMultiple ? (
          <div className="field">
            <label className="label" htmlFor="nm-account">Send from</label>
            <select
              id="nm-account"
              className="select"
              value={accountId ?? ''}
              onChange={(e) => setAccountId(Number(e.target.value))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.business_number ? ` (+${a.business_number})` : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}

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
            Contact name
          </label>
          <input
            id="nm-name"
            className="input"
            autoComplete="off"
            placeholder="Anita Rao"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div className="field-pair">
          <div className="field">
            <label className="label" htmlFor="nm-type">
              Contact type
            </label>
            <select
              id="nm-type"
              className="select"
              value={contactType}
              onChange={(e) => setContactType(e.target.value)}
              required
            >
              <option value="" disabled>
                Select…
              </option>
              {CONTACT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="nm-country">
              Country of origin
            </label>
            <select
              id="nm-country"
              className="select"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              required
            >
              <option value="" disabled>
                Select…
              </option>
              {COUNTRIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
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
