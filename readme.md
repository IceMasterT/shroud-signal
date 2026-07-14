## Shroud Signal

A shared sector of space, live inside your subreddit. Built for the [Phaser × Reddit hackathon](https://phaser.io/news/2026/06/reddit-and-phaser-launch-a-40-000-game-dev-hackathon) on [Devvit](https://developers.reddit.com/), reusing ship art and lore from [Mentaverse](https://github.com/IceMasterT/mentaverse-phaser).

Post **"Chart a New Sector"** from a subreddit's menu and anyone who opens it spawns a ship — one of five lines pulled from Mentaverse's starter fleet — flying in real time alongside everyone else currently in that post. Fire on other pilots (`Space`), climb the subreddit-wide leaderboard, and listen for the ambient "galaxy pulse" — a scheduled rumor about the Shroud broadcast to every active sector every five minutes.

No login flow, no accounts, no external database: player identity, position, combat, and scoring all live on Devvit's own Redis, realtime pub/sub, and scheduler primitives, inside the Reddit post that spawned them.

## How it's built

- **`@devvit/redis`** — per-sector player state (position, rotation, hull, score) as a Redis hash keyed by sector, plus a subreddit-wide leaderboard sorted set. Hull and score use atomic `hIncrBy` counters to stay correct under concurrent hits/scoring.
- **`@devvit/realtime`** — server-to-client pub/sub broadcasting join/move/leave/score/shot/hit/respawn/pulse events to every pilot in a sector.
- **`@devvit/scheduler`** — a cron task that pulses ambient flavor text to every sector active in the last 24 hours.
- **Phaser 4** — flight physics, a starfield, live remote-ship interpolation, a HUD, a leaderboard overlay, and hitscan laser combat, rendered client-side.

Combat and movement are server-authoritative: the server fires from a shooter's own last-known tracked position rather than trusting client-supplied coordinates, and enforces the fire cooldown itself rather than relying on the client.

## Commands

- `npm run playtest [r/sub]`: watches changes, builds, uploads, and installs on Reddit. Accepts an optional subreddit.
- `npm run build`: builds client and server, including esbuild metafiles.
- `npm run clean`: removes build outputs.
- `npm run test`: runs all tests.
- `npm run format`: fixes lints and formatting.
- `npm run lint`: checks lints and formatting.
- `npm run publish`: cleans, builds, uploads, and files a new app review request.
