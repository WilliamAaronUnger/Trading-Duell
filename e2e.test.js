/* Ende-zu-Ende-Tests: Offline-Modus (beweisbar OHNE Netz) + Online-Raum + Teil-Links.
   Ausführen mit:  node e2e.test.js  – braucht nur Node ≥ 22, keine Abhängigkeiten.
   Simuliert mehrere "Geräte" (DOM-Stub, je eigener Raum-Speicher) gegen den ECHTEN
   worker.js-v3-Handler (D1 über node:sqlite): Raum-Lebenszyklus, Rollen/Leinwand,
   Runden-Serie mit Abend-Wertung, Live-Rennen, Zuspätkommer, Reload, ?room=/?join=. */
const fs = require("fs"), os = require("os"), path = require("path"), {pathToFileURL} = require("url");
const noop = () => {};

(async () => {
  // ---- Worker v3 laden (echter Handler, D1 = echtes SQLite) ----
  const tmp = path.join(os.tmpdir(), "spcx-w-" + process.pid + ".mjs");
  fs.copyFileSync(path.join(__dirname, "worker.js"), tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  const {DatabaseSync} = require("node:sqlite");
  const sq = new DatabaseSync(":memory:");
  const env = {DB: {prepare(sql){ return {_a: [],
    bind(...a){ this._a = a; return this; },
    async first(){ const r = sq.prepare(sql).get(...this._a); return r === undefined ? null : r; },
    async run(){ const i = sq.prepare(sql).run(...this._a); return {success: true, meta: {changes: Number(i.changes)}}; },
    async all(){ return {results: sq.prepare(sql).all(...this._a)}; }};}}};

  // ---- fetch-Stub MIT Zähler: beweist, dass der Offline-Modus nichts sendet ----
  let fetchCount = 0;
  global.fetch = async (url, opts) => { fetchCount++; return worker.fetch(new Request(url, opts), env); };

  // ---- DOM-/Browser-Stub ----
  const els = {};
  const store = {};
  // Canvas-2D-Stub: jede Methode gibt den Proxy selbst zurück, damit verkettete Aufrufe
  // (z. B. createLinearGradient().addColorStop()) im echten drawChart nicht crashen.
  const ctx2d = new Proxy({}, {get: () => (() => ctx2d), set: () => true});
  const mkEl = () => new Proxy(function(){}, {
    get: (t, p) => { if(p === "classList") return {add: noop, remove: noop, toggle: noop, contains: () => false};
      if(p === "style") return t.__style || (t.__style = {});
      if(p === "getContext") return () => ctx2d;
      if(p === "querySelectorAll") return () => []; if(p === "querySelector") return () => mkEl();
      if(["appendChild","addEventListener","setAttribute","focus","prepend","removeChild","scrollIntoView","dispatchEvent","play"].includes(p)) return noop;
      if(p === "dataset") return {}; if(p === "children") return []; if(p === "clientWidth") return 200;
      return t[p] !== undefined ? t[p] : ""; },
    set: (t, p, v) => { t[p] = v; return true; }, apply: () => mkEl()});
  global.document = {getElementById: id => els[id] || (els[id] = mkEl()), querySelectorAll: () => [],
                     querySelector: () => mkEl(), addEventListener: noop, createElement: () => mkEl(), body: mkEl()};
  global.window = {addEventListener: noop, devicePixelRatio: 1,
                   matchMedia: () => ({matches: false, addEventListener: noop}),
                   location: {protocol: "https:", origin: "https://spcx.test", pathname: "/", search: "", href: "https://spcx.test/"}};
  global.location = global.window.location; global.history = {replaceState: noop};
  global.navigator = {serviceWorker: {register: () => ({catch: noop})}};
  global.localStorage = {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => store[k] = v,
                         removeItem: k => delete store[k]};
  global.performance = {now: () => 0}; global.requestAnimationFrame = noop; global.cancelAnimationFrame = noop;
  global.addEventListener = noop; global.setInterval = () => 0; global.clearInterval = noop;
  global.setTimeout = () => 0; global.clearTimeout = noop; global.alert = noop;

  const qr = fs.readFileSync(path.join(__dirname, "qr.js"), "utf8");
  const data = fs.readFileSync(path.join(__dirname, "data.js"), "utf8");
  const game = fs.readFileSync(path.join(__dirname, "game.js"), "utf8");

  const hookFn = async function(){
    const out = {};
    const $id = id => document.getElementById(id);
    const settle = async cond => { for(let i = 0; i < 300 && !cond(); i++) await Promise.resolve(); };
    over = false; sandbox = false; tutorial = false; START_CASH = 25000;

    // ================= OFFLINE-MODUS: nachweislich NULL Netz-Requests =================
    const fc0 = globalThis.__fetchCount();
    mode = "remote"; durationMin = 10; codeIn.value = ""; market = null;
    await $id("startBtn").onclick();
    out["Offline: Spiel angelegt, Markt sofort da"] = market !== null && /^\d{6}$/.test(String(gameCode));
    out["Offline: Minuten-Start gesetzt"] = startAt > Date.now() && startAt % 60000 === 0;
    const offCode = gameCode, offPath = JSON.stringify(market.paths.SPCX.slice(0, 40));
    market = null; codeIn.value = String(offCode); // "zweites Gerät" mit demselben Code
    await $id("startBtn").onclick();
    out["Offline: Beitritt → exakt derselbe Markt"] = JSON.stringify(market.paths.SPCX.slice(0, 40)) === offPath;
    out["Offline: NULL Requests (bewiesen)"] = globalThis.__fetchCount() === fc0;

    // ================= RAUM: Geräte-Simulation =================
    const stash = () => ({mode, room: room && Object.assign({}, room), roomState, roomPhase, roomTickN, roomDurPick,
                          marketSeed, gameCode, durationMin, market, startAt, players, soloP,
                          rankResults, rankRoom, over, round, matchTicks,
                          _rk: localStorage.getItem("trading-duell-room")});
    const restore = c => { ({mode, roomState, roomPhase, roomTickN, roomDurPick,
                             marketSeed, gameCode, durationMin, market, startAt, players, soloP,
                             rankResults, rankRoom, over, round, matchTicks} = c);
      room = c.room && Object.assign({}, c.room);
      if(c._rk == null) localStorage.removeItem("trading-duell-room");
      else localStorage.setItem("trading-duell-room", c._rk); };

    // --- Anna eröffnet den Raum ---
    localStorage.removeItem("trading-duell-room");
    mode = "room"; $id("name1").value = "Anna"; codeIn.value = ""; market = null; roomPhase = "idle";
    await $id("startBtn").onclick();
    out["Raum: eröffnet (p1)"] = !!room && room.p === 1 && /^\d{6}$/.test(room.code);
    await roomTick();
    out["Raum: Roster zeigt Anna (du) mit Krone"] =
      ($id("roomMembers").innerHTML || "").indexOf("Anna") >= 0 && ($id("roomMembers").innerHTML || "").indexOf("👑") >= 0;
    out["Raum: allein → kein Start-Bereich, Warte-Hinweis"] =
      $id("roomStartField").style.display === "none" && $id("roomWaitHint").style.display === "";
    const RC = room.code;
    const A = stash();

    // --- Ben tritt bei (eigenes Gerät) ---
    localStorage.removeItem("trading-duell-room");
    room = null; roomState = null; roomPhase = "idle"; market = null;
    $id("name1").value = "Ben"; codeIn.value = RC;
    await $id("startBtn").onclick();
    out["Raum: Ben beigetreten (p2)"] = !!room && room.p === 2;
    await roomTick();
    const B = stash();

    // --- Cleo tritt bei und wird Leinwand ---
    localStorage.removeItem("trading-duell-room");
    room = null; roomState = null; roomPhase = "idle";
    $id("name1").value = "Cleo"; codeIn.value = RC;
    await $id("startBtn").onclick();
    await $id("roomRoleBtn").onclick();
    await roomTick();
    out["Raum: Cleo ist Leinwand"] = room.role === "wall" &&
      (roomState.members.find(m => m.p === 3) || {}).role === "wall";
    out["Raum: Rollen-Knopf bietet Rückweg an"] = ($id("roomRoleBtn").textContent || "").indexOf("mitspielen") >= 0;
    const C = stash();

    // --- Anna sieht 2 Spieler → startet Runde 1 mit Dauer 5 ---
    restore(A);
    await roomTick();
    out["Raum: Start-Bereich da (2 Spieler, Leinwand zählt nicht)"] = $id("roomStartField").style.display === "";
    roomDurPick = 5;
    await $id("roomStartBtn").onclick();
    out["Runde 1: Countdown, Markt aus geheimem Seed, Dauer 5"] =
      roomPhase === "countdown" && room.played === 1 && durationMin === 5 &&
      marketSeed !== null && market !== null && startAt > Date.now();
    const seed1 = marketSeed, path1 = JSON.stringify(market.paths.SPCX.slice(0, 40));
    out["Runde 1: Seed ≠ Raum-Code (Vorspiel-Schutz)"] = marketSeed !== (+RC >>> 0);
    const A2 = stash();

    // --- Ben erkennt die Runde über den Puls ---
    restore(B);
    await roomTick();
    out["Runde 1: Ben automatisch dabei – gleicher Seed, gleicher Markt"] =
      room.played === 1 && marketSeed === seed1 && JSON.stringify(market.paths.SPCX.slice(0, 40)) === path1;
    const B2 = stash();

    // --- Leinwand bleibt draußen; Runde "läuft" → Live-Stand ---
    restore(C);
    await roomTick();
    out["Runde 1: Leinwand bleibt im Raum"] = roomPhase === "idle" && (room.played || 0) === 0;
    globalThis.__sq.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 20000, RC);
    restore(A2); roomPhase = "playing"; round = 0; over = false; roomTickN = 1; // (im Browser setzt startRound das)
    await roomTick(); // roomTickN→2: meldet eigenen P&L und rendert das Rennen
    out["Rennen: Chips gerendert (Anna + Ben)"] = (($id("raceRow").innerHTML || "").match(/race-chip/g) || []).length === 2;
    const A3 = stash();
    restore(B2); roomPhase = "playing"; round = 0; over = false; roomTickN = 1;
    players[0].cash += 150; // Ben liegt vorn
    await roomTick();
    const B3 = stash();
    restore(C);
    await roomTick();
    const liveHtml = $id("roomLive").innerHTML || "";
    out["Leinwand: Live-Stand sichtbar, Ben vorn"] = $id("roomLiveField").style.display === "" &&
      liveHtml.indexOf("Ben") >= 0 && liveHtml.indexOf("Ben") < liveHtml.indexOf("Anna");
    // Großbild (Phase 3): eigener Markt aus dem Runden-Seed, Board, News, Exit
    out["Großbild: an, richtige Runde, Markt aus Seed"] = wallOn === true && wallRoundN === 1 &&
      !!wallMarket && JSON.stringify(wallMarket.paths.SPCX.slice(0, 40)) === path1;
    out["Großbild: Rangliste zeigt Ben vorn"] = (($id("wallBoard").innerHTML || "").indexOf("Ben") >= 0) &&
      ($id("wallBoard").innerHTML || "").indexOf("Ben") < ($id("wallBoard").innerHTML || "").indexOf("Anna");
    out["Großbild: Zeit + Fokus gerendert"] = ($id("wallTime").textContent || "").indexOf(":") > 0 &&
      DISPLAY_SYMS.includes($id("wallSym").textContent);
    $id("wallExit").onclick();
    out["Großbild: Exit schließt (für diese Runde)"] = wallOn === false;
    await roomTick();
    out["Großbild: bleibt nach Exit zu (dismissed)"] = wallOn === false;
    wallDismissed = 0; // fürs weitere Testgeschehen zurücksetzen

    // --- Runde 1 endet: Ergebnisse → Rangliste + Abend-Wertung ---
    restore(A3); roomPhase = "idle";
    players[0].result = {pnl: 120, total: 25120}; soloP = players[0];
    await roomShareResult(players[0]);
    out["Ergebnis: Rangliste geöffnet, eigenes drin"] = !!rankResults && !!rankResults[1];
    const A4 = stash();
    restore(B3); roomPhase = "idle";
    players[0].result = {pnl: -40, total: 24960}; soloP = players[0];
    await roomShareResult(players[0]);
    restore(A4);
    await roomTick(); // holt Bens Ergebnis in die Rangliste
    const rb = $id("rankBox").innerHTML || "";
    out["Rangliste: füllt sich über den Puls, Anna vorn mit Krone"] =
      !!rankResults[2] && rb.indexOf("👑") >= 0 && rb.indexOf("👑") < rb.indexOf("Anna") &&
      rb.indexOf("Anna") < rb.indexOf("Ben");
    let sb = Object.fromEntries((roomState.scoreboard || []).map(s => [s.p, s]));
    out["Abend-Wertung nach Runde 1: Sieg für Anna"] = sb[1] && sb[1].wins === 1 && sb[1].total === 120;

    // --- Runde 2 (Dauer 15): Serie, frischer Seed, Wertung summiert ---
    globalThis.__sq.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 1").run(Date.now() - 6*60000, RC);
    roomDurPick = 15;
    await $id("roomStartBtn").onclick();
    out["Runde 2: Dauer 15, frischer Seed"] = room.played === 2 && durationMin === 15 && marketSeed !== seed1;
    const A5 = stash();
    restore(B3); roomPhase = "idle";
    await roomTick();
    out["Runde 2: Ben wieder automatisch dabei"] = room.played === 2 && marketSeed === A5.marketSeed;
    players = [newPlayer("Ben", "var(--p2)")]; players[0].result = {pnl: 200, total: 25200}; soloP = players[0];
    roomPhase = "idle";
    await roomShareResult(players[0]);
    restore(A5); roomPhase = "idle";
    players = [newPlayer("Anna", "var(--p1)")]; players[0].result = {pnl: -10, total: 24990}; soloP = players[0];
    await roomShareResult(players[0]);
    await roomTick();
    sb = Object.fromEntries((roomState.scoreboard || []).map(s => [s.p, s]));
    out["Abend-Wertung nach Runde 2: 1:1 Siege, Summen stimmen"] =
      sb[1].wins === 1 && sb[2].wins === 1 && sb[1].total === 110 && sb[2].total === 160;

    // --- Zuspätkommer: Dana kommt mitten in einer laufenden Runde ---
    globalThis.__sq.prepare("UPDATE rounds SET startAt = ? WHERE code = ? AND n = 2").run(Date.now() - 60000, RC);
    localStorage.removeItem("trading-duell-room");
    room = null; roomState = null; roomPhase = "idle"; market = null; marketSeed = null;
    $id("name1").value = "Dana"; codeIn.value = RC; mode = "room";
    await $id("startBtn").onclick();
    await roomTick();
    out["Zuspätkommer: im Raum, aber NICHT in der laufenden Runde"] =
      !!room && room.p === 4 && roomPhase === "idle" && (room.played || 0) === 0;
    out["Zuspätkommer: sieht 'Runde läuft'"] = $id("roomLiveField").style.display === "";

    // --- Reload: Mitgliedschaft übersteht den Neustart ---
    room = null; roomState = null;
    const rec = loadRoomState();
    out["Reload: Raum-Mitgliedschaft ladbar"] = !!rec && rec.code === RC && rec.p === 4;

    // --- ?room=-Link: Emil kommt per Einladung, tritt automatisch bei ---
    localStorage.removeItem("trading-duell-room");
    room = null; roomState = null; roomPhase = "idle";
    $id("name1").value = "Emil"; codeIn.value = "";
    location.search = "?room=" + RC;
    handleShareParams();
    await settle(() => room && room.p === 5);
    out["?room-Link: automatisch beigetreten (p5)"] = !!room && room.p === 5;
    location.search = "";

    // ================= Teil-Links & Einfüge-Toleranz (Offline-Welt) =================
    room = null; mode = "remote";
    sandbox = false; gameCode = 333333; durationMin = DURATIONS[333333 % 3]; marketSeed = null; buildMarket();
    const meP = newPlayer("Ich", "var(--p1)");    meP.result = {pnl: 111.5, total: 25111.5};
    const opP = newPlayer("Gegner", "var(--p2)"); opP.result = {pnl: -50, total: 24950};
    const myCode = packResult(meP), oppCode = packResult(opP);
    const vurl = shareUrl("vs", oppCode);
    out["Einfuegen: roher Code / Nachricht / Link"] =
      extractResultCode(oppCode) === oppCode &&
      extractResultCode("Ergebnis:\n" + oppCode + "\nGruss!") === oppCode &&
      extractResultCode("Vergleich: " + vurl) === oppCode;
    const prot = location.protocol; location.protocol = "file:";
    out["file://: kein Teil-Link"] = shareUrl("join", "123456") === null;
    location.protocol = prot;
    out["unpack ok + fremdes Spiel abgelehnt"] =
      (unpackResult(oppCode, 333333) || {}).name === "Gegner" && !!(unpackResult(oppCode, 111111) || {}).wrongGame;
    let captured = null; renderCompare = (me, opp) => { captured = {me, opp}; };
    localStorage.setItem("trading-duell", JSON.stringify({games: [{code: myCode, durationMin, name: "Ich",
      pnl: 111.5, date: 1750000000000, fav: "SPCX", mode: "remote"}]}));
    cmpFromStats = false;
    openSharedCompare(oppCode);
    out["?vs mit Historie -> Vergleich oeffnet"] = cmpFromStats === true && !!captured;
    localStorage.removeItem("trading-duell");
    codeIn.value = ""; openSharedCompare(oppCode);
    out["?vs ohne Historie -> Code vorbefuellt"] = codeIn.value === "333333";
    location.search = "?join=222333"; codeIn.value = "";
    handleShareParams();
    out["?join -> Beitritts-Code vorbefuellt"] = codeIn.value === "222333";
    location.search = "?vs=quatsch";
    out["kaputter Link wird still ignoriert"] = (() => { try{ handleShareParams(); return true; }catch(e){ return false; } })();
    location.search = "";

    return out;
  };

  globalThis.__fetchCount = () => fetchCount;
  globalThis.__sq = sq;
  (0, eval)(qr + "\n" + data + "\n" + game + "\n;globalThis.__e2e = " + hookFn.toString() + ";");
  const out = await globalThis.__e2e();
  let fail = 0;
  for(const [k, v] of Object.entries(out)){ console.log((v ? "✔" : "✘"), k); if(!v) fail++; }
  console.log(fail ? "\n" + fail + " FEHLER" : "\nENDE-ZU-ENDE OK (" + Object.keys(out).length + " Checks)");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("Harness-Fehler:", e); process.exit(1); });
