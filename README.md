# WhatsApp Team Inbox

A shared team inbox for customer WhatsApp conversations. The whole team sees every
conversation and replies from the browser.

- **Frontend** — React + Vite SPA on Cloudflare Pages
- **Backend** — Cloudflare Pages Functions (`/functions/api/*`) on the Workers runtime
- **Database** — Supabase, via `@supabase/supabase-js` over HTTPS
- **Messaging** — the app talks to **Whapi directly**: it calls Whapi's send API for
  outbound, and receives inbound messages on its own webhook endpoint

Text messages only. No media handling.

---

## Architecture

```
INBOUND   Customer WhatsApp → Whapi → POST /api/whapi/webhook/<secret> → Supabase
                                            (wp_chat_conversations + wp_chat_messages)

APP       React (Pages) → Pages Functions /api/* → Supabase

OUTBOUND  app POST /api/send → Whapi /messages/text → Customer WhatsApp
```

The browser never holds database credentials. The Functions hold them as encrypted
environment variables and are the only thing that talks to Postgres.

### Workers runtime notes

Pages Functions run on the Workers edge, not Node. So:

- Passwords use **PBKDF2 via `crypto.subtle`** (100k iterations, SHA-256) — no bcrypt.
- JWTs are **HMAC-SHA256 via Web Crypto** — no `jsonwebtoken`.
- Database access goes through **`@supabase/supabase-js`**, which talks to Supabase over
  HTTPS/`fetch`. Do **not** swap this for a raw Postgres driver: raw TCP sockets to Postgres
  hang on the Workers runtime — requests never complete and the Worker is eventually killed
  with "your Worker's code had hung", and `connect_timeout` does not fire.

Because the Functions use the **service role key**, they bypass row-level security. All
access control is therefore enforced in the endpoint code itself, and the key must never
reach the browser.

---

## Database

The schema **already exists** in Supabase — this app never creates or migrates tables.
It reads and writes three tables, all prefixed `wp_chat_`:

| Table | Purpose |
| --- | --- |
| `wp_chat_users` | Team members: name, email, `password_hash`, `role` (`admin`/`agent`), `is_active` |
| `wp_chat_conversations` | One row per customer number, with the preview, `unread_count`, and assignment |
| `wp_chat_messages` | Every message, `inbound` or `outbound` |

Phone numbers are stored as digits — E.164 without the plus, e.g. `919669228223`.

Queries go through the Supabase query builder, so values are always sent as bound
parameters — never interpolated into a query string.

---

## Environment variables

Set these in **Cloudflare Pages → Settings → Environment variables**, all encrypted:

| Variable | What it is |
| --- | --- |
| `SUPABASE_URL` | The project URL, e.g. `https://your-project-ref.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | The **service role** key — secret, server-side only |
| `JWT_SECRET` | A long random string used to sign auth tokens |
| `WHAPI_TOKEN` | Whapi channel API token, sent as `Authorization: Bearer` |
| `WHAPI_API_URL` | Whapi base URL — `https://gate.whapi.cloud` |
| `WHAPI_WEBHOOK_SECRET` | A long random string that forms the inbound webhook URL |
| `BUSINESS_NUMBER` | Your WhatsApp business number, digits only (e.g. `919000000000`) |

Both Supabase values are in **Project Settings → API**. The service role key is the one
under "Project API keys" marked `service_role` — it bypasses row-level security, so it
belongs only in the Pages Functions environment. It must never appear anywhere in `/src`,
in the built bundle, or in the browser.

Generate a `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the real values
```

`.dev.vars` is gitignored — never commit it.

Vite alone serves the SPA but not the Functions, so use Wrangler to run both together:

```bash
npm run build
npx wrangler pages dev dist
```

That serves the built SPA plus `/functions/api/*` with `.dev.vars` loaded, which is the
only way to exercise the API locally.

For fast UI-only iteration, `npm run dev` gives you Vite's hot reload — API calls will
fail until you switch back to the Wrangler command above.

---

## Deploy

1. Push this repository to GitHub.
2. In Cloudflare, create a **Pages** project connected to the repo.
3. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Add the four environment variables above as **encrypted** values, for both
   Production and Preview.
5. Deploy.

`public/_redirects` (`/* /index.html 200`) is what makes client-side routing work on
deep links like `/team`.

---

## First login

The app has no signup — the first admin is seeded directly in the database.

1. Insert the user (or use an existing row):

   ```sql
   INSERT INTO wp_chat_users (name, email, role, is_active, created_at)
   VALUES ('Your Name', 'you@company.com', 'admin', true, now());
   ```

2. Generate a password hash:

   ```bash
   npm run make-hash
   ```

   It prompts for an email and password, then prints the hash and a ready-to-run
   statement:

   ```sql
   UPDATE wp_chat_users SET password_hash='pbkdf2$100000$...' WHERE email='you@company.com';
   ```

3. Run that in the Supabase SQL editor.
4. Sign in at your Pages URL.

From there, add the rest of the team from the **Team** page — no SQL needed. Admins can
also reset any user's password there, including generating a temporary one to hand over.

---

## Roles

| | Agent | Admin |
| --- | --- | --- |
| See conversations | Only those assigned to them | All |
| Reply | Their conversations | All |
| Assign conversations | No | Yes |
| Team page | Hidden | Yes |
| Add users / reset passwords | No | Yes |
| Change own password | Yes | Yes |

Every rule is enforced **server-side** in each endpoint. The UI hides controls to match,
but the API is the boundary that actually matters.

---

## API

All endpoints live under `/api` and take `Authorization: Bearer <token>` except `/login`.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/api/login` | public | `{email, password}` → `{token, user}` |
| GET | `/api/conversations` | any | Admin: all. Agent: assigned only |
| GET | `/api/messages?conversation_id=N` | any | Thread, ascending. Also marks it read |
| POST | `/api/send` | any | `{conversation_id, body}` → queues the row, then calls Whapi |
| POST | `/api/assign` | admin | `{conversation_id, assigned_user_id}` (null unassigns) |
| GET | `/api/users` | any | Roster for the assign dropdown — never returns password hashes |
| POST | `/api/users/create` | admin | `{name, email, password, role}` |
| POST | `/api/password/change` | any | `{current_password, new_password}` |
| POST | `/api/password/reset` | admin | `{user_id, new_password?}` — omit to get a temp password back |
| POST | `/api/whapi/webhook/<secret>` | **public** | Inbound messages from Whapi |

---

## Whapi

### Outbound

`POST /api/send` writes the message row as `status='queued'` first, updates the
conversation preview, then calls Whapi:

```
POST {WHAPI_API_URL}/messages/text
Authorization: Bearer {WHAPI_TOKEN}
Content-Type: application/json
Accept: application/json

{ "to": "13135555657", "body": "Hello there" }
```

`to` is sent as bare digits. On a 2xx the row flips to `status='sent'` and the returned
message id is stored in `whapi_message_id` when the response includes one. On a non-2xx or
a network failure the row flips to `status='send_failed'` with a short reason in
`error_code`, and the endpoint still returns 200 — the message is already persisted, so the
failure shows up in the thread instead of vanishing.

### Inbound

Paste this into Whapi's **incoming webhook** setting:

```
https://<your-domain>/api/whapi/webhook/<WHAPI_WEBHOOK_SECRET>
```

> **The secret path segment is the only thing protecting this endpoint.** Whapi supports
> neither signed webhooks nor custom auth headers, so the URL itself is the credential.
> Treat it like a password: make it long and random, never commit it, and rotate it by
> changing `WHAPI_WEBHOOK_SECRET` and updating the URL in Whapi. A request with the wrong
> secret gets a 404, so the route's existence is not advertised.

The endpoint always answers **200** for a valid secret — even for a payload it skips or
cannot parse — because any other status makes Whapi retry indefinitely. Problems are logged
instead.

Per message in the `messages` array:

- `from_me: true` is **skipped** — these are echoes of the team's own replies, which
  `/api/send` has already written. Without this every outgoing message would be duplicated.
- Non-`text` types are skipped; media is out of scope.
- The conversation is found or created by `customer_number`. An existing blank
  `customer_name` is filled from `from_name`, but an existing name is never overwritten —
  a human may have corrected it.
- The message is inserted with `direction='inbound'`, `status='received'`, `is_read=false`.
  `whapi_message_id` is UNIQUE, so a Whapi retry is dropped rather than duplicated.
- The conversation preview is updated and `unread_count` incremented — only for messages
  actually inserted, so retries don't inflate the badge.

---

## Behavior

- **Polling** — conversations every 5s, the open thread every 4s. No websockets.
- **Unread** — a red count on the conversation row (bolded), a badge on the Inbox nav
  icon, and a `(N)` prefix on the browser tab. Opening a conversation clears it.
- **Toasts** — each poll is diffed against the previous one; a newer `last_message_at`
  with `last_direction='inbound'` on a conversation you don't have open raises a toast
  and a two-tone Web Audio chime. The mute toggle is in the header (sound on by default),
  and audio stays silent until you've interacted with the page, as browsers require.
- **Search** — filters live by name (case-insensitive) or number. Both sides are stripped
  to digits, so `732` matches `917326198427`.
- **Theme** — light by default, with a light/dark toggle persisted in `sessionStorage`.

No `localStorage` anywhere — session state lives in memory and `sessionStorage` only.

---

## Project layout

```
functions/
  _lib/
    auth.js         requireAuth / requireAdmin / conversation access checks
    db.js           Memoized Supabase client + error unwrapping + email lookup
    whapi.js        Whapi send-text call + number normalization
    hash.js         PBKDF2 hash + verify + temp-password generator
    jwt.js          HS256 sign / verify via Web Crypto
    respond.js      JSON response helpers
  api/              one file per endpoint
src/
  components/       ConversationList, Thread, ReplyBox, AssignControl, Toast, Shell, modals
  context/          Auth, Theme, Toast, Inbox (polling + unread + toast diffing)
  lib/              api.js (fetch wrapper), format.js, chime.js
  pages/            Login, Inbox, Team
scripts/
  make-hash.mjs     CLI to generate a password hash
public/
  _redirects        SPA routing for Pages
```

---

## Out of scope

Media/attachments (text messages only) and database migrations are out of scope — the
schema already exists and is managed outside this repository.
