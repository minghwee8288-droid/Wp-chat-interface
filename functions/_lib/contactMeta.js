/**
 * Who a contact is and where they are from.
 *
 * Plain data with no imports so the New message form (src/) can import the
 * same lists the API validates against — one list, no drift between them.
 * Adding an option here is all it takes; the DB check on contact_type (sql/020)
 * must be widened too when a type is added.
 */

export const CONTACT_TYPES = [
  { value: 'employer', label: 'Employer' },
  { value: 'caregiver', label: 'Caregiver' },
  { value: 'recruiter', label: 'Recruiter' },
  { value: 'client_partner', label: 'Client / Partner' },
  { value: 'staff', label: 'Staff' },
]

// ISO 3166-1 alpha-2 codes, plus OTHER for anyone not listed.
export const COUNTRIES = [
  { value: 'SG', label: 'Singapore' },
  { value: 'PH', label: 'Philippines' },
  { value: 'HK', label: 'Hong Kong' },
  { value: 'ID', label: 'Indonesia' },
  { value: 'MM', label: 'Myanmar' },
  { value: 'KH', label: 'Cambodia' },
  { value: 'MY', label: 'Malaysia' },
  { value: 'IN', label: 'India' },
  { value: 'LK', label: 'Sri Lanka' },
  { value: 'BD', label: 'Bangladesh' },
  { value: 'TH', label: 'Thailand' },
  { value: 'VN', label: 'Vietnam' },
  { value: 'OTHER', label: 'Other' },
]

// Display labels. An unknown value (contact_type was already filled from
// outside this app on some databases) is shown as-is rather than hidden.
export const contactTypeLabel = (v) =>
  v ? CONTACT_TYPES.find((t) => t.value === v)?.label ?? String(v) : null
export const countryLabel = (v) =>
  v ? COUNTRIES.find((c) => c.value === v)?.label ?? String(v) : null

export const isContactType = (v) => CONTACT_TYPES.some((t) => t.value === v)
export const isCountry = (v) => COUNTRIES.some((c) => c.value === v)
