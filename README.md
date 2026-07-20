# WhatsApp Team Inbox

A shared team inbox for customer WhatsApp conversations. The whole team sees every
conversation and replies from the browser.

- **Frontend** — React + Vite SPA on Cloudflare Pages
- **Backend** — Cloudflare Pages Functions (`/functions/api/*`) on the Workers runtime
- **Database** — Supabase Postgres over a direct Postgres connection
- **Messaging** — n8n handles Whapi send/receive; this app never calls Whapi directly

Text messages only. No media handling.

---

## Architecture

```
INBOUND   Customer WhatsApp → Whapi → n8n → Supabase
                                            (wp_chat_conversations + wp_chat_messages)

APP       React (Pages) → Pages Functions /api/* → Supabase

OUTBOUND  app POST /api/send → n8n webhook → Whapi → Customer WhatsApp
```

The browser never holds database credentials. The Functions hold them as encrypted
environment variables and are the only thing that talks to Postgres.

### Workers runtime notes

Pages Functions run on the Workers edge, not Node. So:

- Passwords use **PBKDF2 via `crypto.subtle`** (100k iterations, SHA-256) — no bcrypt.
- JWTs are **HMAC-SHA256 via Web Crypto** — no `jsonwebtoken`.
- The Postgres driver is [`postgres`](https://github.com/porsager/postgres), which runs on
  Workers with the `nodejs_compat` compatibility flag (already set in `wrangler.toml`).

---

## Database

The schema **already exists** in Supabase — this app never creates or migrates tables.
It reads and writes three tables, all prefixed `wp_chat_`:

| Table | Purpose |
| --- | --- |
| `wp_chat_users` | Team members: name, email, `password_hash`, `role` (`admin`/`agent`), `is_active` |
| `wp_chat_conversations` | One row per customer number, with the preview, `unread_count`, and assignment |
| `wp_chat_messages` | Every message, `inbound` or `outbound` |

Phone numbers are stored as digits — E.164 without the plus, e.g. `919669229223`.

All SQL is parameterized; values are never interpolated into query strings.

---

## Environment variables

Set these in **Cloudflare Pages → Settings → Environment variables**, all encrypted:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Supabase Postgres connection string — use the **pooled / session-pooler** string with `sslmode=require` |
| `JWT_SECRET` | A long random string used to sign auth tokens |
| `N8N_OUTBOUND_WEBHOOK_URL` | The n8n webhook that sends the message via Whapi |

The `DATABASE_URL` looks like:

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
```

Find it in Supabase under **Project Settings → Database → Connection string → Session pooler**.

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
4. Add the three environment variables above as **encrypted** values, for both
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
| POST | `/api/send` | any | `{conversation_id, body}` → queues the row, then calls n8n |
| POST | `/api/assign` | admin | `{conversation_id, assigned_user_id}` (null unassigns) |
| GET | `/api/users` | any | Roster for the assign dropdown — never returns password hashes |
| POST | `/api/users/create` | admin | `{name, email, password, role}` |
| POST | `/api/password/change` | any | `{current_password, new_password}` |
| POST | `/api/password/reset` | admin | `{user_id, new_password?}` — omit to get a temp password back |

### Outbound webhook contract

`POST /api/send` sends this to `N8N_OUTBOUND_WEBHOOK_URL`:

```json
{
  "conversation_id": 12,
  "to_number": "919669229223",
  "body": "Hello there",
  "message_id": 481
}
```

The message row is written as `status='queued'` first. If the webhook call throws or
returns non-2xx, the row is flipped to `status='send_failed'` so the failure is visible
in the thread rather than silently lost. n8n should update the row with the Whapi message
id once it has one.

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
    db.js           Postgres connection + parameterized query helpers
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

The n8n workflows, direct Whapi calls, media/attachments, and database migrations are all
handled outside this repository.
