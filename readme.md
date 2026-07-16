## Shroud Signal

A shared sector of space, live inside your subreddit. Built for the [Phaser × Reddit hackathon](https://phaser.io/news/2026/06/reddit-and-phaser-launch-a-40-000-game-dev-hackathon) on [Devvit](https://developers.reddit.com/). A spin-off of [Mentaverse](https://mentagame.com), another game I've been developing, reusing its ship art and lore.

No login flow, no accounts, no external database: player identity, position, combat, and scoring all live on Devvit's own Redis, realtime pub/sub, and scheduler primitives, inside the Reddit post that spawned them.

Every control works the same on desktop and mobile: `Space`/laser button to fire lasers, `E`/missile button for missiles, a virtual joystick and on-screen action buttons that are always visible (not just on touch devices, since they also route around Reddit's own page occasionally swallowing keyboard input).

## Game modes

**Free-Play Sectors.** Post **"Chart a New Sector"** from a subreddit's menu and anyone who opens it picks a ship — one of five lines pulled from Mentaverse's starter fleet — then flies it in real time alongside everyone else currently in that post. Fire on other pilots, climb the subreddit-wide leaderboard, and listen for the ambient "galaxy pulse," a scheduled rumor about the Shroud broadcast to every active sector every five minutes. You can revisit the sector anytime to pick a different ship — it's not locked in.

**Battle Arenas (Last One Standing).** A mod can run **"Challenge a Subreddit"** to pit their community against another one: set a player cap per team and a warm-up window, the other subreddit accepts or counters, and once accepted both subreddits get a synced arena post for a best-of-3 series. During warm-up, joining players pick an individual ship or commit their whole team to a squad preset. Eliminated pilots sit out the rest of that round; if a round times out with survivors on both sides it's a tie, and a series tied on round wins after 3 rounds is broken by how long each team's fleet survived (credited per round, not just a flat clock).

In battle arenas, the 5 ship lines are a real choice, not cosmetic: each has its own speed/hull/damage profile and a unique `R`-key ability (Fighter overcharges its weapon, Miner drops proximity mines, Transport shields itself, Pathfinder pings the enemy fleet and shares the reveal with its whole team, Tender heals its nearest ally), and a team can't stack more than 2 of the same line by default, so squad composition is an actual decision. The challenger can set the squad rule to "custom" when creating a challenge, lifting the 2-per-line cap for the whole match (the target subreddit can counter it, like the other terms), and a team can also commit to one of 4 curated squad presets (Balanced Wing, Aggro Rush, Turtle Wall, Recon Strike) instead of picking ships individually.

## About this project

Shroud Signal is a spin-off of [Mentaverse](https://mentagame.com), another game I've been developing, also built in Phaser. Same developer, same universe, just me borrowing my own assets for a hackathon. Nothing here is lifted from anyone else's work.

I just really like Phaser and wanted to build something fun for Reddit's hackathon with it, to show how versatile and cool the engine actually is.

I'm IceMasterT ([GitHub](https://github.com/icemastert), u/Capital_Vegetable_80), and I've got a few more Phaser games in the works:

- A 2.5D beat 'em up starring princesses who are done waiting around to be rescued. Sick of playing damsel in distress, they band together and start rescuing other princesses instead, and when their own kingdom finally gets captured, they flip the script completely: this time it's the princesses saving the prince, and the kingdom, themselves.
- **Viral Vendetta**, a PvP Pokemon/Final Fantasy style battler currently in testing. You fight toxic internet personalities in ridiculous turn based duels, and winning means either torching their reputation or crushing their ego into dust. Petty, cathartic, and genuinely funny.

## How it's built

- **`@devvit/redis`**: per-sector player state (position, rotation, hull, score) as a Redis hash keyed by sector, plus a subreddit-wide leaderboard sorted set. Hull and score use atomic `hIncrBy` counters to stay correct under concurrent hits/scoring.
- **`@devvit/realtime`**: server-to-client pub/sub broadcasting join/move/leave/score/shot/hit/respawn/pulse events to every pilot in a sector.
- **`@devvit/scheduler`**: a cron task that pulses ambient flavor text to every sector active in the last 24 hours.
- **Phaser 4**: flight physics, a starfield, live remote-ship interpolation, a HUD, a leaderboard overlay, laser/missile combat, and a shared virtual-joystick/touch-button input module so desktop and mobile run the same control scheme, all rendered client-side.

Combat and movement are server-authoritative: the server fires from a shooter's own last-known tracked position rather than trusting client-supplied coordinates, and enforces the fire cooldown itself rather than relying on the client. Laser and missile hits both render instantly on the shooter's own screen instead of waiting on the realtime broadcast to round-trip back — that round-trip isn't reliable enough on real mobile networks to gate what you see when you pull the trigger.

`scripts/simulate-battles.ts` is a standalone tool that runs full 10v10 best-of-3 matches through the exact same combat math the server uses, to check win rates per ship line and catch state bugs (crashes, negative hull, stuck rounds) before they ship — it's how the current ship balance was tuned.

## Commands

- `npm run playtest [r/sub]`: watches changes, builds, uploads, and installs on Reddit. Accepts an optional subreddit.
- `npm run build`: builds client and server, including esbuild metafiles.
- `npm run clean`: removes build outputs.
- `npm run test`: runs all tests.
- `npm run format`: fixes lints and formatting.
- `npm run lint`: checks lints and formatting.
- `npm run publish`: cleans, builds, uploads, and files a new app review request.
