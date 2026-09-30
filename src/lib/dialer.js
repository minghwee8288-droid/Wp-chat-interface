/**
 * Which app places a call on a phone.
 *
 * On desktop a browser extension (Linku) picks up the plain `tel:` anchor and
 * dials through RingQ, so nothing here is involved. A phone has no extension:
 * `tel:` goes straight to the OS dialer, which rings from the SIM (iOS then
 * only asks "Primary / Personal" — both SIM lines, never RingQ). So on mobile
 * the call control asks first and hands the number to the RingQ app directly.
 */

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
// iPadOS reports itself as a Mac, so a touch-capable "Mac" counts as iOS.
export const isIOS =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
export const isAndroid = /Android/i.test(ua)

/** True where there is no dialer extension and the chooser should be shown. */
export const isMobileDialer = isIOS || isAndroid

/** RingQ's Android package id (from its Play Store listing). */
const RINGQ_ANDROID_PACKAGE = 'com.ringq.app'

/**
 * URL that opens the RingQ iOS app on a number. `{number}` is replaced with
 * the local digits.
 *
 * RingQ does not publish its iOS URL scheme; this value is UNVERIFIED. If the
 * RingQ option on an iPhone does nothing, get the correct scheme from RingQ
 * support and change it here — it is the only place it lives.
 */
const RINGQ_IOS_URL = 'ringq://call?number={number}'

/**
 * Link that opens RingQ ready to call `digits`.
 *
 * Android: an intent URL for a `tel:` DIAL pinned to RingQ's package, so
 * Android skips the SIM dialer and routes the number to RingQ. The action is
 * DIAL, not the default VIEW: with VIEW, RingQ opened its keypad but ignored
 * the number. If RingQ is not installed, Chrome falls back to its Play Store
 * page.
 */
export function ringqHref(digits) {
  if (isAndroid) {
    return `intent:${digits}#Intent;scheme=tel;action=android.intent.action.DIAL;package=${RINGQ_ANDROID_PACKAGE};end`
  }
  return RINGQ_IOS_URL.replace('{number}', encodeURIComponent(digits))
}
