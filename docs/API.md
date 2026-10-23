# API v1

Everything lives under `/v1`. Requests and responses are JSON. Auth is cookie-based (`access_token`, 15 minutes, and `refresh_token`, 90 days, both HttpOnly); send requests with `credentials: 'include'`. A `Bearer` access token also works.

**Errors** look like `{ "error": { "code": "validation_failed", "message": "...", "fields": { "title": "..." } } }`. The `code` is stable; the `message` is safe to show. Rate-limited requests get `429` with code `rate_limited`.

**Paging** is by cursor: lists return `next_cursor` (null on the last page); pass it back as `?cursor=`. `limit` defaults to 25 (max 100). Search pages by number (`?page=`, max 10).

**Ids**: any `:id` for posts and comments accepts the UUID or the 8-character short id.

**Viewer fields**: when signed in, posts and comments carry `viewer: { vote, saved, is_author }`. Anonymous content has `author: null` unless you wrote it or moderate that community. Deleted comments read `[deleted]` and removed ones `[removed]`, with `author: null`; they stay in the tree so replies keep their place.

## Auth `/v1/auth`

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/signup` | `email, username, password, is_adult: true, turnstile_token?` | 201, signs in, sends a verification email |
| POST | `/login` | `identifier` (email or username), `password`, `turnstile_token?` | After 3 failures Turnstile is required (when configured); after 10, 429 for 15 minutes |
| POST | `/logout` | | Revokes this session |
| POST | `/refresh` | | Rotates the refresh token. Replaying an old one revokes the session |
| GET | `/me` | | The signed-in user |
| POST | `/verify-email` | `token` | From the emailed link |
| POST | `/resend-verification` | | |
| POST | `/forgot-password` | `email` | Same answer whether or not the account exists |
| POST | `/reset-password` | `token, password` | Signs out every device |
| POST | `/change-password` | `current_password?, new_password` | Signs out other devices |
| POST | `/change-email` | `new_email, password` | Emails a confirmation link to the new address |
| POST | `/confirm-email` | `token` | |
| POST | `/google` | `id_token, is_adult?` | Google Identity Services ID token. `is_adult` required for new accounts. 503 until `GOOGLE_CLIENT_ID` is set |
| GET | `/sessions` | | Signed-in devices, `current` marks this one |
| DELETE | `/sessions/:id` | | Sign out one device |
| DELETE | `/sessions` | | Sign out every other device |

## Feed, posts and comments

| Method | Path | Notes |
|---|---|---|
| GET | `/feed?sort=hot\|new\|top&t=hour\|day\|week\|month\|year\|all&scope=home\|all` | Signed in: joined communities (falls back to all). Guests: all public communities |
| POST | `/posts` | `community, type: text\|link, title (3-300), body (≤40k), url?, is_anonymous?, is_nsfw?, flair_id?` |
| GET | `/posts/:id` | |
| PATCH | `/posts/:id` | Author only: `body, is_nsfw, flair_id`. Titles can't change |
| DELETE | `/posts/:id` | Author only |
| PUT | `/posts/:id/vote` | `{ value: 1 \| 0 \| -1 }`. Returns the new counts |
| PUT/DELETE | `/posts/:id/save` | |
| GET | `/posts/:id/comments?sort=best\|top\|new\|old&depth=3&replies=3` | Top-level comments, each with `replies` up to `depth` levels and `replies` per comment. `more_replies` counts what wasn't loaded |
| POST | `/posts/:id/comments` | `body (≤10k), parent_id?, is_anonymous?` |
| GET | `/comments/:id` | One comment with its post |
| GET | `/comments/:id/replies?sort&cursor&depth&replies` | More replies, or "continue thread" past the visible depth |
| PATCH | `/comments/:id` | Author only: `body` |
| DELETE | `/comments/:id` | Author only |
| PUT | `/comments/:id/vote` | `{ value }` |
| PUT/DELETE | `/comments/:id/save` | |

## Communities `/v1/communities`

| Method | Path | Notes |
|---|---|---|
| GET | `/?sort=popular\|new` | |
| POST | `/` | `name (3-21, letters/digits/_), display_name?, description?, visibility: public\|private, is_nsfw?, rules?` |
| GET | `/:name` | Community, moderators, and `viewer: { is_member, role, is_banned, has_pending_request }` |
| PATCH | `/:name` | Moderators |
| GET | `/:name/posts?sort&t` | Pinned posts lead the first "hot" page |
| PUT | `/:name/membership` | Join. Private communities answer 202 and create a join request |
| DELETE | `/:name/membership` | Leave |
| GET | `/:name/join-requests` | Moderators |
| POST | `/:name/join-requests/:id` | `{ decision: accept \| reject }` |
| PUT | `/:name/members/:username/role` | Owner: `{ role: member \| moderator }` |
| POST | `/:name/bans` | Moderators: `{ username, days?, reason? }` (no days = permanent) |
| DELETE | `/:name/bans/:username` | |
| GET/POST | `/:name/flairs` | POST for moderators: `{ name, color? }` |
| DELETE | `/:name/flairs/:id` | |
| GET | `/:name/reports?status=open` | Mod queue |
| GET | `/:name/mod-log` | Every moderator action |

## Moderation and reports

| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | `target_type: post\|comment\|user\|community, target_id, reason_code, note?` |
| POST | `/reports/:id/resolve` | `{ status: resolved \| dismissed }`; closes every open report on that target |
| GET | `/admin/reports` | Site admins: reports about users and communities |
| POST | `/posts/:id/moderation` | `{ action: remove\|approve\|lock\|unlock\|pin\|unpin, reason? }`; `sponsor`/`unsponsor` for site admins |
| POST | `/comments/:id/moderation` | `{ action: remove\|approve\|lock\|unlock\|pin\|unpin, reason? }` |

## Users and search

| Method | Path | Notes |
|---|---|---|
| GET | `/users/:username` | Public profile |
| GET | `/users/:username/posts`, `/users/:username/comments` | Never includes anonymous content or private communities |
| PATCH | `/users/me` | `display_name, avatar_id` |
| GET | `/users/me/communities` | Joined communities with your role |
| GET | `/users/me/saved?type=posts\|comments` | |
| DELETE | `/users/me` | `{ password }`; detaches your name from past content |
| GET | `/search?q=&type=posts\|communities&page=` | Postgres full-text search; supports `"phrases"` and `-exclusions` |
| GET | `/search/autocomplete?q=` | Community and username prefixes |

## Operations

- **Rate limits**: auth 20 per 15 minutes per IP, writes 60 per minute per account, reads 300 per minute per IP. Auth and write counters live in Postgres (`RATE_LIMIT_STORE=postgres`, the default), so they hold across instances without Redis.
- **Jobs**: pg-boss on the same Postgres runs email sending and link previews. `JOBS_ENABLED=false` runs them inline instead.
- **Logs**: JSON lines via pino, one per request with a request id. Send `X-Request-Id` to set it; it comes back on every response.
- **Seeds**: `npm run seed` (small dev data), `npm run seed:bench` then `npm run bench` (100k posts / 1M comments and timings).
