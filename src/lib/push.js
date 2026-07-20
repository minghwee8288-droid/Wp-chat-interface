import { api } from './api.js'
import { isIOS, isStandalone } from './pwa.js'

// Web push. Deliberately defensive: iOS only supports this from an installed
// PWA on 16.4+, it is unavailable to EU PWAs on 17.4+, and it silently drops
// subscriptions — so every path here has to degrade rather than throw.

export const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window

/** 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied' */
export function pushState() {
  // On iOS, push exists only once the app is on the home screen. In a Safari
  // tab PushManager may be absent entirely, so check this before support.
  if (isIOS() && !isStandalone()) return 'needs-install'
  if (!PUSH_SUPPORTED) return 'unsupported'
  return Notification.permission
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.ready
}

/**
 * Creates (or reuses) a subscription and registers it server-side.
 * Returns {ok, reason}. Never throws.
 */
export async function subscribeToPush() {
  const state = pushState()
  if (state === 'needs-install') return { ok: false, reason: 'needs-install' }
  if (state === 'unsupported') return { ok: false, reason: 'unsupported' }
  if (state === 'denied') return { ok: false, reason: 'denied' }

  try {
    const reg = await registration()
    if (!reg) return { ok: false, reason: 'unsupported' }

    const { key } = await api.pushKey()
    if (!key) return { ok: false, reason: 'not-configured' }

    let subscription = await reg.pushManager.getSubscription()
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        // Required by every browser, and mandatory on iOS.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
    }

    await api.pushSubscribe(subscription.toJSON())
    return { ok: true }
  } catch (err) {
    // iOS 17.4+ in the EU throws here; so does a revoked permission.
    return { ok: false, reason: 'failed', error: String(err?.message || err) }
  }
}

/** Must be called from a real user gesture — iOS ignores it otherwise. */
export async function requestPushPermission() {
  const state = pushState()
  if (state === 'needs-install') return { ok: false, reason: 'needs-install' }
  if (state === 'unsupported') return { ok: false, reason: 'unsupported' }
  // The prompt can only ever be shown once; after that it is a Settings trip.
  if (state === 'denied') return { ok: false, reason: 'denied' }

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, reason: permission }
    return subscribeToPush()
  } catch (err) {
    return { ok: false, reason: 'failed', error: String(err?.message || err) }
  }
}

export async function disablePush() {
  try {
    const reg = await registration()
    const subscription = reg && (await reg.pushManager.getSubscription())
    if (!subscription) return { ok: true }

    const endpoint = subscription.endpoint
    await subscription.unsubscribe().catch(() => {})
    await api.pushUnsubscribe(endpoint).catch(() => {})
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * Called on every app start once signed in.
 *
 * iOS is known to discard push subscriptions silently while leaving the
 * permission granted, so "permission is granted" is not evidence that a
 * subscription still exists — re-subscribe whenever one is missing.
 */
export async function ensurePushSubscription() {
  if (pushState() !== 'granted') return { ok: false, reason: 'not-granted' }
  return subscribeToPush()
}

/**
 * App badge. iOS 16.4+ supports this for installed PWAs; everywhere else the
 * call simply does not exist, so it is guarded rather than feature-detected
 * per platform.
 */
export function setAppBadge(count) {
  try {
    if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count).catch(() => {})
    else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {})
  } catch {
    /* badge support is cosmetic — never let it surface */
  }
}
