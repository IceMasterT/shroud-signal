## Shroud Signal

A shared sector of space, live inside your subreddit. Built for the [Phaser × Reddit hackathon](https://phaser.io/news/2026/06/reddit-and-phaser-launch-a-40-000-game-dev-hackathon) on [Devvit](https://developers.reddit.com/). A spin-off of [Mentaverse](https://mentagame.com), another game I've been developing, reusing its ship art and lore.

Post **"Chart a New Sector"** from a subreddit's menu and anyone who opens it spawns a ship, one of five lines pulled from Mentaverse's starter fleet, flying in real time alongside everyone else currently in that post. Fire on other pilots (`Space` for lasers, `E` for missiles), climb the subreddit-wide leaderboard, and listen for the ambient "galaxy pulse," a scheduled rumor about the Shroud broadcast to every active sector every five minutes.

No login flow, no accounts, no external database: player identity, position, combat, and scoring all live on Devvit's own Redis, realtime pub/sub, and scheduler primitives, inside the Reddit post that spawned them.

A mod can also run **"Challenge a Subreddit"** to pit their community against another one: set a player cap per team and a warm-up window, the other subreddit accepts or counters, and once accepted both subreddits get a synced arena post for a best-of-3 Last One Standing series. Eliminated pilots sit out the rest of that round; if a round times out with survivors on both sides it's a tie, and cumulative survival time breaks a tied series.

In battle arenas, the 5 ship lines are a real choice, not cosmetic: each has its own speed/hull/damage profile and a unique `R`-key ability (Fighter overcharges its weapon, Miner drops proximity mines, Transport shields itself, Pathfinder reveals enemy hull, Tender heals its nearest ally), and a team can't stack more than 2 of the same line, so squad composition is an actual decision. The challenger can set the squad rule to "custom" when creating a challenge, lifting the 2-per-line cap for the whole match (the target subreddit can counter it, like the other terms), and a team can also commit to one of 4 curated squad presets (Balanced Wing, Aggro Rush, Turtle Wall, Recon Strike) instead of picking ships individually.

## About this project

Shroud Signal is a spin-off of [Mentaverse](https://mentagame.com), another game I've been developing, also built in Phaser. Same developer, same universe, just me borrowing my own assets for a hackathon. Nothing here is lifted from anyone else's work.

I just really like Phaser 3 and wanted to build something fun for Reddit's hackathon with Phaser, to show how versatile and cool the engine actually is.

I'm IceMasterT ([GitHub](https://github.com/icemastert), u/Capital_Vegetable_80), and I've got a few more Phaser games in the works:

- A 2.5D beat 'em up starring princesses who are done waiting around to be rescued. Sick of playing damsel in distress, they band together and start rescuing other princesses instead, and when their own kingdom finally gets captured, they flip the script completely: this time it's the princesses saving the prince, and the kingdom, themselves.
- **Viral Vendetta**, a PvP Pokemon/Final Fantasy style battler currently in testing. You fight toxic internet personalities in ridiculous turn based duels, and winning means either torching their reputation or crushing their ego into dust. Petty, cathartic, and genuinely funny.

## How it's built

- **`@devvit/redis`**: per-sector player state (position, rotation, hull, score) as a Redis hash keyed by sector, plus a subreddit-wide leaderboard sorted set. Hull and score use atomic `hIncrBy` counters to stay correct under concurrent hits/scoring.
- **`@devvit/realtime`**: server-to-client pub/sub broadcasting join/move/leave/score/shot/hit/respawn/pulse events to every pilot in a sector.
- **`@devvit/scheduler`**: a cron task that pulses ambient flavor text to every sector active in the last 24 hours.
- **Phaser 4**: flight physics, a starfield, live remote-ship interpolation, a HUD, a leaderboard overlay, and laser/missile combat, rendered client-side.

Combat and movement are server-authoritative: the server fires from a shooter's own last-known tracked position rather than trusting client-supplied coordinates, and enforces the fire cooldown itself rather than relying on the client.

## Commands

- `npm run playtest [r/sub]`: watches changes, builds, uploads, and installs on Reddit. Accepts an optional subreddit.
- `npm run build`: builds client and server, including esbuild metafiles.
- `npm run clean`: removes build outputs.
- `npm run test`: runs all tests.
- `npm run format`: fixes lints and formatting.
- `npm run lint`: checks lints and formatting.
- `npm run publish`: cleans, builds, uploads, and files a new app review request.
