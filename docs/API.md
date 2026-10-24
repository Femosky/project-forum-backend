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
| GET | `/posts/duplicates?url=` | Up to 5 earlier posts of the same link in public communities (tracking parameters, `www.` and trailing slashes ignored) |
| GET | `/posts/link-preview?url=` | Signed in: `{ preview: { title, description, image, site } \| null }` for the composer |
| GET | `/posts/:id` | `is_indexable` says whether the page should be indexed (see SEO below) |
| GET | `/posts/:id/related` | `{ related, more_from_community }`: up to 5 light rows each (`short_id, slug, title, community, score, comment_count`) |
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
| GET | `/?sort=popular\|new&category=&q=` | `q` matches name, display name or description |
| GET | `/categories` | `{ categories: [{ id, label, count }] }` for the directory |
| POST | `/` | `name (3-21, letters/digits/_), display_name?, description?, visibility: public\|private, is_nsfw?, rules?, category?` |
| GET | `/:name` | Community, moderators, and `viewer: { is_member, role, is_banned, has_pending_request, muted_until, queue_count }` (`queue_count` for moderators only) |
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
| GET | `/:name/reports?status=open` | Raw report list |
| GET | `/:name/mod-queue` | Open reports grouped by target plus items held by the filters: `{ items: [{ target_type, target_id, updated_at, held_reason, reports: { total, reasons, notes }, report_ids, post? \| comment? \| user? }] }` |
| GET | `/:name/restrictions` | Moderators: current `{ bans, mutes }` |
| POST | `/:name/mutes` | Moderators: `{ username, days (1-365), reason? }`. Muted users can read but not post or comment here |
| DELETE | `/:name/mutes/:username` | |
| GET | `/:name/mod-log` | Every moderator action |

## Moderation and reports

| Method | Path | Notes |
|---|---|---|
| POST | `/reports` | `target_type: post\|comment\|user\|community, target_id, reason_code: spam\|scam\|harassment\|hate\|sexual\|violence\|misinformation\|personal_info\|other, note?` |
| POST | `/reports/:id/resolve` | `{ status: resolved \| dismissed }`; closes every open report on that target |
| GET | `/admin/reports` | Site admins: reports about users and communities |
| POST | `/posts/:id/moderation` | `{ action: remove\|approve\|lock\|unlock\|pin\|unpin, reason? }`; `sponsor`/`unsponsor` for site admins. Remove closes the target's open reports as resolved, approve as dismissed |
| POST | `/comments/:id/moderation` | `{ action: remove\|approve\|lock\|unlock\|pin\|unpin, reason? }` |

## Safety (Phase 5)

Rules live in `src/modules/safety/policy.ts` (numbers) and `filters.ts` (patterns).

- **Held content.** New posts and comments (and edits) are screened. A match is saved with `status: 'pending'` and lands in the mod queue; the author can still open it, nobody else can, and it isn't counted until approved. Moderators see `held_reason` on posts and comments; everyone else gets `null`. Filters: blocklisted domains and phrases, link shorteners, the same post in another community or the same comment under three posts within a day, and, for accounts under a day old with under 10 karma, phone numbers and "DM me / WhatsApp me" style asks.
- **New accounts** (under a day old and under 10 karma) can't post links (`403 new_account_links`). Accounts under a week old with under 10 karma get 3 posts and 10 comments an hour (`429 new_account_limit`). Signups are limited to 5 per IP per day.
- **Anonymous** posts and comments need an account at least a day old, a verified email, karma of 0 or more and no shadow-ban (`403 anonymous_not_allowed`). Moderators of the community still see the author.
- **Mutes** answer `403 muted`; bans `403 banned`.
- The signed-in user (`/auth/me`, login, signup) carries `can_post_links` and `can_post_anonymously` so the composer can explain limits up front.

## Admin `/v1/admin` (site admins only)

| Method | Path | Notes |
|---|---|---|
| GET | `/overview` | Queue size and 24-hour counts |
| GET | `/queue` | Every open report and held item on the site, in the mod-queue shape |
| GET | `/users?q=&filter=all\|suspended\|shadow_banned\|new` | Username or email prefix |
| POST | `/users/:username/suspend` | `{ days?, reason? }` (no days = until lifted). Signs the account out everywhere; an expired suspension is lifted at the next sign-in |
| POST | `/users/:username/unsuspend` | |
| POST | `/users/:username/shadow-ban` | `{ shadow_banned: boolean, reason? }`. Their posts and comments, past and future, are visible only to them; counters are recomputed |
| GET | `/communities?q=` | |
| POST | `/communities/:name/takedown` | `{ reason? }`. The community and its posts disappear (crawlers get 410) |
| POST | `/communities/:name/restore` | |
| GET/POST | `/blocklist` | POST `{ kind: domain\|keyword, value, note? }`. Domains also match subdomains |
| DELETE | `/blocklist/:id` | |
| GET | `/mod-log` | Every moderator and admin action |

## Users and search

| Method | Path | Notes |
|---|---|---|
| GET | `/users/:username` | Public profile |
| GET | `/users/:username/posts`, `/users/:username/comments` | Never includes anonymous content or private communities |
| PATCH | `/users/me` | `display_name, avatar_id` |
| GET | `/users/me/communities` | Joined communities with your role |
| GET | `/users/me/saved?type=posts\|comments` | Saved comments carry `post: { short_id, slug, title, community }` |
| GET | `/users/me/export` | Everything the account wrote or chose, as a JSON download |
| DELETE | `/users/me` | `{ password }`; detaches your name from past content |
| GET | `/search?q=&type=posts\|communities&page=` | Postgres full-text search; supports `"phrases"` and `-exclusions` |
| GET | `/search/autocomplete?q=` | Community and username prefixes |

## Notifications `/v1/notifications`

Created when someone comments on your post (`post_reply`), replies to your comment (`comment_reply`) or mentions you as `@name` or `u/name` in a comment (`mention`, at most 5 per comment). Never for your own comments, from people you blocked, or twice for one comment. Anonymous commenters show as `actor: null`.

| Method | Path | Notes |
|---|---|---|
| GET | `/?cursor=` | Newest first: `{ notifications: [{ id, type, created_at, read_at, actor, post: { short_id, slug, title, community }, comment: { short_id, excerpt } }], next_cursor, unread_count }`. Deleted or removed comments drop out |
| GET | `/unread-count` | `{ count }`, for polling |
| POST | `/read` | `{ ids? }`; no ids marks everything read. Returns the new `{ count }` |

## SEO `/v1/seo`

Data for the web app's sitemaps; the web app caches it.

| Method | Path | Notes |
|---|---|---|
| GET | `/sitemap` | `{ posts, communities, users }`, each a list of `{ page, lastmod }` chunks of up to 50,000 URLs |
| GET | `/status?type=post\|community\|user&id=` | `{ state: 'live', path }`, `{ state: 'gone' }` (deleted or removed) or `{ state: 'missing' }`, so the web app can answer crawlers with 301/404/410 |
| GET | `/sitemap/:kind/:page` | `kind` is `posts` (`community, short_id, slug, lastmod`), `communities` (`name, lastmod`) or `users` (`username, lastmod`) |

A post is indexable when it is active or locked in a public community, isn't a very short text post (under 40 characters of title and body) without replies, and, if its author's account was under a day old when posting, has a reply or an upvote. Users are listed when they have at least one indexable, non-anonymous post. With `INDEXNOW_KEY` set, new indexable posts are pinged to IndexNow (Bing, Yandex); the web app must serve the same key at `/indexnow-key.txt`.

## Operations

- **Rate limits**: signups 5 per day per IP, auth 20 per 15 minutes per IP, writes 60 per minute per account, reads 300 per minute per IP. Auth and write counters live in Postgres (`RATE_LIMIT_STORE=postgres`, the default), so they hold across instances without Redis.
- **Jobs**: pg-boss on the same Postgres runs email sending and link previews. `JOBS_ENABLED=false` runs them inline instead.
- **Logs**: JSON lines via pino, one per request with a request id. Send `X-Request-Id` to set it; it comes back on every response.
- **Seeds**: `npm run seed` (small dev data), `npm run seed:bench` then `npm run bench` (100k posts / 1M comments and timings).
