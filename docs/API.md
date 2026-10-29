# API v1

Everything lives under `/v1`. Requests and responses are JSON. Auth is cookie-based (`access_token`, 15 minutes, and `refresh_token`, 90 days, both HttpOnly); send requests with `credentials: 'include'`. A `Bearer` access token also works.

**Errors** look like `{ "error": { "code": "validation_failed", "message": "...", "fields": { "title": "..." } } }`. The `code` is stable; the `message` is safe to show. Rate-limited requests get `429` with code `rate_limited`.

**Paging** is by cursor: lists return `next_cursor` (null on the last page); pass it back as `?cursor=`. `limit` defaults to 25 (max 100). Search pages by number (`?page=`, max 10).

**Ids**: any `:id` for posts and comments accepts the UUID or the 8-character short id.

**Viewer fields**: when signed in, posts and comments carry `viewer: { vote, saved, is_author }`. Anonymous content has `author: null` unless you wrote it or moderate that community. Deleted comments read `[deleted]` and removed ones `[removed]`, with `author: null`; they stay in the tree so replies keep their place. A deleted comment with nothing visible beneath it is left out, and deleted ones carry zero counts. A post its author deleted keeps its page while it has comments: `status: 'deleted'`, title kept, empty body, no link, `author: null`, zero counts, read-only. With no comments left it is a 404.

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
| GET | `/stats?days=30` or `?from=YYYY-MM-DD&to=` | `{ range, today, days, top_communities }`. `today` is live (partial); `days` are the nightly `DailyStat` snapshots up to yesterday (missing days are written on the spot): `total_users, new_signups, dau, wau, mau, unique_visitors, page_views, posts, comments, votes, ad_impressions, ad_clicks, countries`. `top_communities` sums `CommunityDailyStat` over the range. Days are Lagos dates; ranges up to a year |
| GET | `/stats/export?days=&from=&to=&kind=daily\|communities` | The same as CSV |
| PATCH | `/communities/:name/ads` | `{ ads_enabled: boolean \| null }`. null follows the default (off in sensitive categories) |
| GET | `/ads` | Advertisers with their campaigns (totals, spend for CPM) and whether AdSense is on and configured |
| POST/PATCH | `/ads/advertisers`, `/ads/advertisers/:id` | `{ name, contact_email?, logo_url?, website?, notes? }` |
| POST | `/ads/campaigns` | `{ advertiser_id, name, kind: direct\|house, status, starts_at?, ends_at?, targeting: { communities[], categories[] }, pricing_model: cpm\|flat, budget_minor?, price_minor?, currency, frequency_cap?, priority, house_share?, payment_url?, paid }`. Money is in minor units (kobo). Empty targeting runs everywhere. `house_share` (0-50, house campaigns): the percent of slots it wins even when paid campaigns want them, for promoting the site's own products |
| GET/PATCH | `/ads/campaigns/:id` | GET adds creatives with totals and the last 30 days |
| POST | `/ads/campaigns/:id/creatives` | `{ format: feed_post\|thread_comment, headline, body?, image_url? (https), click_url, cta_label? }` |
| PATCH | `/ads/creatives/:id` | Same fields plus `is_active`. Pausing resolves open reports on the ad |

## Ads `/v1/ads` (Phase 6)

| Method | Path | Notes |
|---|---|---|
| GET | `/?placement=feed\|thread&community=&post=&count=&seen=` | `{ ads: AdUnit[] }` in priority order: direct campaigns targeting this community or its category, direct run-of-site, house ads, then AdSense. Empty on NSFW, private, sensitive or ad-free communities and on threads that aren't active. `seen=campaignId:n,...` is the viewer's count today, for frequency caps. `Cache-Control: private, no-store` |
| POST | `/events` | `{ impressions: creativeId[] }` (max 50), JSON or plain text. Added to today's `AdDailyStat` row (Lagos time) |
| GET | `/click/:creativeId` | Counts a click and 302s to the advertiser |
| GET | `/stats/:token` | The advertiser's read-only stats: totals, per day, per creative |

Self-promotion: a house campaign with `house_share` takes that percent of slots before paid campaigns (all shares together capped at 50%), still subject to frequency caps, targeting and brand safety; with 0 it only fills slots nobody paid for. The web app labels house ads "From us" instead of "Sponsored". Admin stats count paid (`ad_*`) and house (`house_*`) impressions and clicks separately.

`AdUnit` is `{ kind: 'direct' \| 'house', id, campaign_id, frequency_cap, creative: { advertiser_name, advertiser_logo, title, body, image_url, cta_label, display_url } }` or `{ kind: 'adsense', id, client, slot_id, format: 'in-feed' \| 'in-article', layout_key }`. Settings: `ADS_ENABLED` (default on) is the master switch; `ADSENSE_ENABLED` plus `ADSENSE_CLIENT_ID`, `ADSENSE_FEED_SLOT`, `ADSENSE_FEED_LAYOUT_KEY` and `ADSENSE_THREAD_SLOT` turn AdSense on. Reports take `target_type: 'ad'` with the creative id; they go to the site queue.

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
| GET | `/search?q=&type=posts\|comments\|communities&community=&page=` | Postgres full-text search; supports `"phrases"` and `-exclusions`. Public active communities only. `community` limits posts and comments to one community ("Search in"). Comments come in the saved-comments shape, with `post: { short_id, slug, title, community }` for the permalink `/c/{community}/{short_id}/{slug}?comment={id}`. When a first page finds fewer than 3: `did_you_mean` (the query with misspelt words swapped for words titles actually use, only if that finds something; else null) and, for posts and comments, `related_communities` (names like the query); a communities search adds the similar names to its results |
| GET | `/search/autocomplete?q=` | Community and username prefixes |

## Trending `/v1/trending`

| Method | Path | Notes |
|---|---|---|
| GET | `/?type=posts\|communities\|topics&limit=` | From snapshots recomputed every 10 minutes; `computed_at` says when. `limit` 1-50, default 20 |

- **posts**: engagement in the last 48 hours (net votes plus 2 per distinct replier) divided by (age in hours + 2)^1.5, for posts under a week old. Needs at least 3 different people and engagement of 3. Each person counts once however often they vote or reply; the author, shadow-banned accounts and new accounts (under a day old and under 10 reputation) don't count. Same post shape as the feed.
- **communities**: 7-day growth (new members + 2 x posts + comments, from at least 3 different people) divided by the square root of (members + 10), so a small community growing fast can lead. Each carries `trending: { new_members, posts, comments }`.
- **topics**: `{ kind: 'term' \| 'flair', term, community, posts, authors }`. Terms are words and two-word phrases from the last 3 days of titles used by at least 3 different people, scored against how common they were in the 30 days before, so everyday words never trend. Flairs are busy flairs with their community. Link a term to `/search?q={term}` and a flair to `/search?q={term}&community={community}`.

Only public, active, non-NSFW communities, and never removed, held, shadow-hidden, sponsored or NSFW posts; items are checked again when served.

## Metrics `/v1/metrics`

| Method | Path | Notes |
|---|---|---|
| POST | `/visit` | `{ path }`, JSON or plain text. One per page view from the browser. Counts a unique visitor (a daily-salted hash of IP and user agent: no cookie, no stored IP) and a page view, for the site and for `/c/{name}` pages their community. Bots are ignored. 204 |

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
| GET | `/status?type=post\|community\|user&id=` | `{ state: 'live', path }`, `{ state: 'gone' }` (removed, or deleted with no comments left) or `{ state: 'missing' }`, so the web app can answer crawlers with 301/404/410 |
| GET | `/sitemap/:kind/:page` | `kind` is `posts` (`community, short_id, slug, lastmod`), `communities` (`name, lastmod`) or `users` (`username, lastmod`) |

A post is indexable when it is active or locked in a public community, isn't a very short text post (under 40 characters of title and body) without replies, and, if its author's account was under a day old when posting, has a reply or an upvote. Users are listed when they have at least one indexable, non-anonymous post. With `INDEXNOW_KEY` set, new indexable posts are pinged to IndexNow (Bing, Yandex); the web app must serve the same key at `/indexnow-key.txt`.

## Operations

- **Rate limits**: signups 5 per day per IP, auth 20 per 15 minutes per IP, writes 60 per minute per account, reads 300 per minute per IP. Auth and write counters live in Postgres (`RATE_LIMIT_STORE=postgres`, the default), so they hold across instances without Redis.
- **Jobs**: pg-boss on the same Postgres runs email sending and link previews, plus the trending snapshot every 10 minutes and the daily stats snapshot at 00:20 Lagos time. `JOBS_ENABLED=false` runs jobs inline instead, and trending and stats are then recomputed when read stale.
- **Counters**: post and comment views, visits and last-active times are buffered in memory and written in batches every `METRICS_FLUSH_SECONDS` (default 45) and on shutdown. The post hot rank counts replies (net votes + half the comment count) and is recomputed when comments come and go.
- **Logs**: JSON lines via pino, one per request with a request id. Send `X-Request-Id` to set it; it comes back on every response.
- **Seeds**: `npm run seed` (small dev data), `npm run seed:bench` then `npm run bench` (100k posts / 1M comments and timings).
