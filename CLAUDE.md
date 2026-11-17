# Zamindar backend — project context

Single source of context for this repo. State described here was verified on 2026-11-17 against `main` at `fc844ca`; re-check anything marked "as of" before relying on it.

## What this is

Zamindar is a territory game for runners in India: a run imported from Strava becomes a polygon on a map that the runner owns until someone else runs through it. This repo holds the whole product — the Express API and the static web pages it serves.

- Runtime: Node >= 20, Express 4, no build step, no framework on the frontend.
- Data: Supabase (Postgres + PostGIS). Two access paths exist side by side (see "Two database clients").
- Deploy: Railway, environment `vivacious-fascination / production`, auto-deploys from `main`. Last deploy 2026-04-13.
- The GitHub repo is **public**. Do not commit product documents, credentials or anything not meant to be read by outsiders.

## Running it

```
npm ci
npm start          # node src/server.js, PORT defaults to 3000
```

Without `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` the server boots in a mock mode that returns empty data; simple reads work, anything chaining `.eq()`/`.order()` on the mock throws. `npm test` points at `src/tests/pipeline.test.js`, which does not exist — there are no tests.

Environment variables read by the code:

| Variable | Used for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase client (`src/db/client.js`) |
| `DATABASE_URL` | Raw `pg` pool (`src/db/index.js`) — **missing from `.env.example`** |
| `JWT_SECRET` | Session tokens; falls back to a hard-coded dev secret if unset |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI` | OAuth |
| `STRAVA_VERIFY_TOKEN`, `STRAVA_SUBSCRIPTION_ID` | Webhook handshake and event filtering |
| `BASE_URL`, `PORT`, `NODE_ENV` | Misc |

Migrations in `migrations/` (001–012) are applied by hand in the Supabase SQL editor, in order. Nothing records which have been applied; ask before assuming a table exists in production.

## Layout

```
src/server.js                 route mounting
src/routes/auth.js            signup/login/logout, /auth/me, Strava OAuth + initial sync, account deletion
src/routes/webhook.js         Strava webhook receiver
src/routes/map.js             public map data: territories, cities, leaderboard, geojson
src/routes/zones.js           per-user zones, activity, city capture (auth required)
src/routes/social.js          friends (dost), armies (fauj), duels (dwandva) (auth required)
src/routes/territoryZones.js  sub-zone defence: attack / patrol (auth required)
src/services/defenceService.js  defence decay + erosion maths
src/lib/stravaProcessor.js    THE LIVE PIPELINE: Strava activity -> run -> zone
src/db/*.js                   one module per table group
public/index.html             landing + login/signup
public/pick-city.html         city picker shown to new Strava signups
public/zamindar.html          desktop map app
public/zamindar-mobile.html   mobile map app (desktop redirects here under 768px)
```

Route mounts: `/auth`, `/webhook`, `/api/map` (public), `/api/zones`, `/api/social`, `/api/territory-zones`.

### Dead code — do not extend without wiring it in first

`src/lib/territoryEngine.js`, `src/lib/stravaWebhook.js`, `src/lib/realtime.js`, `src/lib/realtimeClient.js`, `src/lib/mapRenderer.js` and `src/db/conflicts.js` are not required by anything the server loads. `territoryEngine.js` holds an older rule set (including a 3-run cap and 30-day window that the product has since dropped). The live rules are in `stravaProcessor.js`.

### Two database clients

- `src/db/client.js` — Supabase JS client. Used by everything except the defence system. Direct selects return PostGIS geometry as WKB hex; convert with `wkx` (see `toGeoJSON` in `routes/map.js` and `routes/zones.js`) or use an RPC that calls `ST_AsGeoJSON`.
- `src/db/index.js` — raw `pg` pool on `DATABASE_URL`. Used only by `routes/territoryZones.js`, which needs transactions and inline PostGIS.

## How a run becomes territory (live path)

`webhook.js` or the initial sync in `auth.js` calls `processStravaActivity`:

1. Reject unless Strava `type === 'Run'`, distance >= 1 km, polyline has >= 5 points.
2. Insert into `runs` (unique on `strava_activity_id`, so replays are skipped).
3. PostGIS builds the polygon: convex hull of the route buffered by 30 m.
4. Insert a permanent row in `zones` (`expires_at` null).
5. Find a city within its capture radius; check the 20%-coverage capture rule.
6. For each overlapping zone owned by someone else, write `zone_overlaps` with fixed scores 60 (defender) / 40 (challenger) and start a 48-hour siege timer.
7. Update the user's aggregate stats.

## Three overlapping conflict systems

These were built at different times and are not reconciled. Decide which one is the game before adding to any of them.

1. **Siege** (`stravaProcessor.js`, tables `zone_overlaps`, `zones.control_score`) — the only one a real run triggers.
2. **Control-score engine** (`territoryEngine.js`) — closest to the written game-engine spec, but dead code.
3. **Sub-zone defence** (`routes/territoryZones.js`, `services/defenceService.js`, migration 012) — defence 0–1 that halves every 7 days, each attacking loop removes 30%, transfer below 0.10, patrol resets to 1.0. Reachable only by calling the API directly: nothing creates the initial `territory_zones` rows, the run pipeline never calls attack/patrol, and no page uses it.

## Game-engine spec vs live code

The owner has a written game-engine PRD (kept outside this repo). Differences that matter:

| Rule | Spec | Live code |
|---|---|---|
| Activity types | run, trail run, walk (walk at 0.6 strength) | `Run` only |
| Min distance | 2 km | 1 km |
| Min duration | 15 min | not checked |
| Min polygon area | 50,000 m² | not checked |
| Max polygon area | clip at 25 km² | not checked |
| Route buffer | 50 m | 30 m |
| Rejected runs | stored with a reason | dropped, console log only |
| Base scores | defender 60 (36 for walk zones), attacker 70 | 60 / 40, no tiebreaker |
| Recency decay | 365 days | none |
| Patrol stacks | >= 50% area coverage, max 3, 10-day half-life, 15% each | absent (system 3 above is a different model) |
| City capture | polygon contains city centre; 3 separate-day runs vs an owner | 20% area coverage |
| City multipliers | Delhi 3.0, Mumbai 2.5, Bengaluru 2.0 … | 1.0–1.5; seed list also differs (has Goa, Indore, Coimbatore; lacks Surat, Nagpur, Varanasi) |
| City expiry | 14 days, nightly job | none; no scheduler exists |
| Army size / roles | 20; commander, lieutenant, soldier | 8; `senapati`, `sipahi` |
| Wars, power score and levels, run reporting, run trimmer | specified | absent |

## Known defects (as of 2026-11-17)

- **Mobile never recognises a logged-in user.** `checkAuth()` in `zamindar-mobile.html` calls `/auth/me` without the `Authorization: Bearer` header the endpoint requires, and reads `display_name` / `zones_owned` where the API returns `displayName` / `zonesOwned`.
- **Social UI field names do not match the API** on both map pages: pages read `friendship_id`, flat `display_name`, `inv.fauj_name` and `role === 'leader'`; the API returns `friendshipId`, nested `requester` / `user` objects, nested `fauj`, and `role: 'senapati'`. Effect: names show as "Runner", accept/remove send `undefined`, the leader never sees the invite box.
- **Desktop and mobile look like different products**: desktop and landing are dark navy/teal (Space Grotesk, dark tiles); mobile is still the earlier light theme.
- User-supplied names are concatenated into `innerHTML` without escaping in both map pages.
- `/api/zones/user/:userId` and `/api/territory-zones/user/:userId` return any user's data to any logged-in user; several `db/*.js` filters interpolate ids into `.or(...)` strings.
- `POST /api/territory-zones/attack` trusts the client's polygon, loop count and distance.
- `JWT_SECRET` has a hard-coded fallback.
- Branch `claude/cms-connector-automation-FPun4` holds an unrelated TypeScript project (`seo-agents/`, ~7,300 lines). It is not part of Zamindar.

## Strava API constraints (checked 2026-11-17)

Strava changed its developer programme in 2026. Figures below come from Strava's announcement and FAQ as reported by search; Strava's own pages could not be opened from the build environment, so confirm on the app's API settings page before planning around them.

- New apps start with capacity for **1 athlete** (the developer).
- **Up to 10 athletes: self-service** from the API settings dashboard, no review.
- **More than 10: Strava review required.** Standard tier covers up to 9,999 athletes; 10,000+ is "Extended Access". No turnaround is promised.
- Standard-tier developers need a **paid Strava subscription** to keep API access (reported effective 2026-06-30).
- Rate limits: 200 requests / 15 min and 2,000 / day by default; 400 / 15 min and 4,000 / day after the self-upgrade.
- Strava's API agreement says data from one athlete may only be shown to that athlete. Sources disagree on whether apps under 10,000 athletes get an exception. This matters here because the public map and leaderboard show other runners' names and Strava-derived territory.

Request cost in this codebase: connecting an athlete costs 1 list call plus up to 20 detail calls; each webhook event costs 1 call (plus a token refresh when expired).

Requirements to meet before submitting for review:

- Handle the webhook's athlete-deauthorisation event (currently ignored) and activity `delete` events (currently ignored).
- Stop returning `strava_id` from the public `/api/map/leaderboard`.
- Decide how other runners' territory may be displayed, and get Strava's answer in writing.

## Conventions

- Vanilla JS in the pages, `var` and function declarations, no modules; all CSS and JS inline in each HTML file.
- User-facing names live in a `LABELS` object at the top of the desktop page script so terminology can change in one place. Mobile has no equivalent yet.
- Hindi product terms: dost = friend, fauj = army, dwandva = duel, zameen = land, senapati = commander, sipahi = soldier.
- Many source files have irregular indentation from in-browser editing; match the surrounding file rather than reformatting.
