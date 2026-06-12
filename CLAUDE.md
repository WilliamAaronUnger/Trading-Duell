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

The fairness guarantee of the game depends on one idea: the full market (all price paths and all news events) is generated **up front** in `genMarket(seed, ticks)` before round 1 starts, using a seeded PRNG (`mulberry32`). Both rounds then merely *replay* this same data via `tick()` (one tick every `TICK_MS` = 1000 ms; pool data is calibrated for 700 ms ticks and rescaled via `TICK_SCALE`). Consequences when editing:

- Anything random that affects prices or news must use the seeded `rnd()` inside `genMarket`, never `Math.random()`, or the two rounds diverge and the duel becomes unfair.
- `price(sym)` is just an index lookup into `market.paths[sym][tickCount]`; live game code never mutates prices.
- News events carry a `jump` (price shock) and a `drift` over `dur` ticks. The event is *displayed* at its `tick`, but the jump and drift only hit the price `REACT_TICKS` (~8 s) later — that reaction window is the point; don't apply effects at the display tick.
- The 6-digit game code (`gameCode`) *is* the market seed: entering the same code on another device reproduces the identical game. `code % 3` encodes the duration (5/10/15 min via `DURATIONS`), so seed and tick count always match across devices. Don't change `genMarket`'s consumption order of `rnd()` casually — it would silently change what every shared code produces.
- Creating a game opens a lobby overlay; round 1 starts automatically at the *second-next* full wall-clock minute (`openLobby`). Devices that create/join with the same code within the same minute therefore start simultaneously without any server.

### Other things to know

- There are two game modes, chosen on the start screen and held in `mode`. **`"local"`** is the original pass-and-play: `players` has both entries, round 1 → handover overlay → round 2 → `showResult()` compares the two with a crown. **`"remote"`** is one player per device coupled only by the shared code: `players` has a single entry, the match runs exactly one round, and `endRound()` calls `showResultSolo()` (own P&L only — the two devices compare manually). Most match code keys off `mode`; remote always has `round === 0`.
- Player state lives in the `players` array (cash, positions with average entry price, result). `round` indexes the active player.
- Positions support shorting: `pos.qty < 0` is a short with `avg` = average short price. There are three order buttons: buy (covers while short), sell (longs only), and a dedicated short button that opens/increases a short (capped by `maxShortQty`: open short exposure ≤ 1× `totalOf`, no leverage); an order never crosses from long to short or vice versa in one step. Generic formulas like `(cur - avg) * qty` already handle the sign — but percent displays and chart up/down logic must flip for `qty < 0`. The result-exchange payload version (currently `SPCX3.…`) must be bumped whenever stats fields change.
- Game-time differs per mode: **local** is tick-based — the pause button and the breaking-news popup (`newsPaused`) halt `tickCount`. **remote** is wall-clock-anchored — `tick()` derives `tickCount` from `Date.now() - roundAnchor` (where `roundAnchor === startAt` from the lobby), there is no pause button, popups don't block (they auto-close), and skipped ticks are caught up after tab sleep. Anything that must stay in sync across devices has to key off this anchored `tickCount`.
- Each stock has a personality via extra `STOCK_DEFS` traits (`newsMult`, `momentum`, `meanRev`, `spikeP`/`spikeMag`), applied inside `genMarket`'s price loop — still fully seeded. The `char` string is shown under the quote.
- Besides plain news there are two-stage chains (`CHAIN_POOL`: rumor → confirm/deny ~1.5–2.5 min later) and insider tips (`market.tips`): vague heads-ups ~50 s before a real generated event. Tips derive from the seed, so both players/devices get identical ones — fairness holds.
- Mega events (`MEGA_POOL`, ~50% of games, at most one, mid-game): huge jumps (+20–40%, the negative Marktpanik capped at ~−15%) marked `mega:true` on the event. They are deliberately unannounced (excluded from insider-tip candidates) but use a longer fuse — `MEGA_REACT_TICKS` (~20 s) instead of `REACT_TICKS` — so shorts can still cover; that fuse is the safety valve, don't shorten it. `newsMult` is intentionally not applied to mega jumps.
- Per-round trading stats live in `players[i].stats` (filled in `trade()`/`processTick()`) and feed the awards on the handover/result screens — one ordered `AWARDS` list yields the main title (`playerTitle()`: first match) and up to three badges (`playerBadges()`: further non-`tOnly` matches; the duel winner additionally gets `KING_BADGE` prepended) — plus `statsLine()` and the detailed `buildAnalysis()` table in the result modal.
- In remote mode the duel comparison works without a server via `packResult()`/`unpackResult()`: a versioned base64 string (currently `SPCX3.…`) carrying result + stats that players exchange manually; `renderCompare()` then shows the same two-column result view as local mode. The payload embeds `gameCode` so results from a different game are rejected, and externally supplied strings (name, favorite stock) must go through `esc()` before touching `innerHTML`.
- The chart is hand-drawn on a `<canvas>` in `drawChart()` (rolling ~3-minute window, devicePixelRatio-aware).
- The tutorial (start-screen button `tutBtn`) is a guided practice mode behind the `tutorial` flag: `genTutorialMarket()` returns a hand-scripted, deterministic mini market in the same `{paths, events, tips}` shape as `genMarket` (jumps pre-baked into the paths at display tick + `REACT_TICKS`), and a coach bar (`TUT_STEPS`/`tutShow`) walks through six steps. Explanation/action steps freeze game time via `paused`, which is why the script's fixed event ticks always line up with player progress. Hooks: `tutOnTrade` at the end of `trade()`, `tutOnTick` in `tick()`'s local branch, `tutFinish` in `endRound()` — `genMarket` and the duel logic stay untouched.
- `sw.js` uses a network-first/cache-fallback strategy with a versioned cache name (`spcx-duell-v<N>`). When changing cached assets in a way that must reach installed PWAs, bump the `CACHE` version string, and keep the `FILES` list in sync with any added/renamed assets.
