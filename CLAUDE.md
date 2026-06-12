# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SPCX Trading-Duell: a two-player, pass-and-play stock trading game around a fictional SpaceX IPO. Both players trade the *exact same* pre-generated market one after the other; whoever ends with the higher P&L wins. It ships as an offline-capable PWA. All UI text, comments, and number formatting are in **German** (`de-DE` locale) — keep new user-facing text and code comments in German to match.

## Development

There is no build system, package manager, linter, or test suite. The app is plain HTML/CSS/JS with zero dependencies.

- Run locally: serve the directory with any static server (e.g. `python3 -m http.server`) and open `index.html`. Opening the file directly also works, except the service worker only registers over http(s).
- There are no tests; verify changes by playing the game in a browser.

## Architecture

The entire application — styles, markup, and game logic — lives in a single file: `index.html`. The other files are PWA scaffolding (`sw.js`, `manifest.json`, icons).

The inline `<script>` in `index.html` is organized into commented sections (`/* ====== ... ====== */`) in this order: configuration, helpers, market generation, state, tick loop, trading, rendering, news feed, round/match end, controls.

### Core design: deterministic pre-generated market

The fairness guarantee of the game depends on one idea: the full market (all price paths and all news events) is generated **up front** in `genMarket(seed, ticks)` before round 1 starts, using a seeded PRNG (`mulberry32`). Both rounds then merely *replay* this same data via `tick()` (one tick every `TICK_MS` = 700 ms). Consequences when editing:

- Anything random that affects prices or news must use the seeded `rnd()` inside `genMarket`, never `Math.random()`, or the two rounds diverge and the duel becomes unfair.
- `price(sym)` is just an index lookup into `market.paths[sym][tickCount]`; live game code never mutates prices.
- News events carry a `jump` (immediate price shock) and a `drift` over `dur` ticks; both are applied during generation, and the event list is replayed at the matching tick to show the news popup/feed.
- The 6-digit game code (`gameCode`) *is* the market seed: entering the same code on another device reproduces the identical game. `code % 3` encodes the duration (5/10/15 min via `DURATIONS`), so seed and tick count always match across devices. Don't change `genMarket`'s consumption order of `rnd()` casually — it would silently change what every shared code produces.
- Creating a game opens a lobby overlay; round 1 starts automatically at the *second-next* full wall-clock minute (`openLobby`). Devices that create/join with the same code within the same minute therefore start simultaneously without any server.

### Other things to know

- There are two game modes, chosen on the start screen and held in `mode`. **`"local"`** is the original pass-and-play: `players` has both entries, round 1 → handover overlay → round 2 → `showResult()` compares the two with a crown. **`"remote"`** is one player per device coupled only by the shared code: `players` has a single entry, the match runs exactly one round, and `endRound()` calls `showResultSolo()` (own P&L only — the two devices compare manually). Most match code keys off `mode`; remote always has `round === 0`.
- Player state lives in the `players` array (cash, positions with average entry price, result). `round` indexes the active player.
- The breaking-news popup pauses the game (`newsPaused`) until the player reacts — gameplay time only advances via `tickCount`, so all timing logic should be tick-based, not wall-clock-based.
- The chart is hand-drawn on a `<canvas>` in `drawChart()` (rolling ~3-minute window, devicePixelRatio-aware).
- `sw.js` uses a network-first/cache-fallback strategy with cache name `spcx-duell-v1`. When changing cached assets in a way that must reach installed PWAs, bump the `CACHE` version string, and keep the `FILES` list in sync with any added/renamed assets.
