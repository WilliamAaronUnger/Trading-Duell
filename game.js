"use strict";

/* ====================== Konfiguration ====================== */
let START_CASH = 25000;
/* Pool-Daten (dur, Event-Abstände, Drift pro Tick) sind auf 0,7-s-Ticks kalibriert –
   dieser Faktor rechnet sie auf die aktuelle Tick-Länge um, damit alles in
   Sekunden gemessen gleich bleibt */
/* Vorlauf zwischen News-Anzeige und Kursreaktion: Zeit zum Reagieren */

/* Drift ~neutral: Aktien können im Plus UND im Minus enden – nur SPCX hat minimal IPO-Rückenwind.
   Jede Aktie hat einen eigenen Charakter:
   - newsMult: News-Sprünge wirken stärker/schwächer (Hype-Wert)
   - momentum: jüngerer Trend verstärkt sich selbst (Momentum-Wert)
   - meanRev:  Kurs wird zur Eröffnung zurückgezogen (stabiler Riese)
   - spikeP/spikeMag: seltene, plötzliche Einzelsprünge (Zock-Papier) */
/* type steuert nur die Balance (Dividenden), NICHT die Marktgenerierung:
   dividend = zahlt pro Tick eine kleine Dividende an Long-Halter,
   growth/risk = keine Dividende. */

/* Handelbarer Gesamtmarkt-Index (Sparplan-Strategie). Bewusst AUSSERHALB von
   STOCK_DEFS, damit alle rnd()-Schleifen in genMarket ihn automatisch ausschließen
   (er ist abgeleitet, kein Random-Walk, nie News-Ziel). Sein Pfad wird am Ende von
   genMarket aus den 10 echten Aktien gemittelt. */
/* alle anzeig-/handelbaren Symbole (echte Aktien + Index) */

/* ---- Balance-Stellschrauben (playtest-bedürftig) ---- */

/* News: kleinere Sprünge, dafür längere Drift-Phasen → fließendere Bewegungen.
   Pool bewusst ausbalanciert: SPCX dominiert nicht – auch TSLA/NVDA/RKLB
   bekommen gleich viele und ähnlich kräftige Stories. */


/* Mega-Events: seltene Spezialereignisse mit gewaltigem Sprung (~50 % der
   Spiele, höchstens eines). Statt Vorwarnung gibt es eine lange Zündschnur:
   Der Kurs reagiert erst MEGA_REACT_TICKS (~20 s) nach der Meldung – genug
   Zeit zum Aufspringen UND zum Eindecken offener Shorts. Positive Events
   +20–40 %, die Marktpanik bewusst gedeckelt (Verluste nie vernichtend).
   newsMult wird hier nicht angewendet, damit die Größenordnung planbar bleibt.
   Bewusst NICHT in den Insider-Tipps: Mega-Events bleiben unangekündigt. */

/* Momentum-News: beziehen sich auf die Aktie, die gerade am stärksten läuft (%SYM% wird ersetzt) */

/* Mehrstufige News: erst ein Gerücht (kleiner Effekt), 1,5–2,5 Min später
   die Auflösung – Bestätigung (großer Sprung) oder Dementi (Umkehr) */

/* Generische Vorlagen (%SYM% = Ticker, %NAME% = Firmenname). Garantieren, dass
   JEDE Aktie – auch ohne handgeschriebene Stories – zuverlässig News bekommt.
   Werden in genMarket pro Aktie instanziiert; Magnituden im Band der Einzel-News. */



/* ====================== Helpers ====================== */
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}) + " $";
const sgn = n => (n>=0?"+":"") + fmt(n);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ====================== Markt vorab generieren ====================== */
/* Die Generierung (mulberry32/genMarket/ETF-Ableitungen) und die Impact-Mathe
   liegen in engine.js – EINE Engine für Client UND Worker (Anti-Cheat-Replay).
   market = { paths: {SYM:[preise...]}, events: [{tick, t, txt, tag}] } */
let market = null;

/* ====================== State ====================== */
let players, round, selected, qtyMode;
let chartMode = "line"; // "line" oder "candle" (Kerzenchart), nur Optik
let favorites = DEFAULT_FAVS.slice(); // 4 Watchlist-Favoriten, pro Spiel zurückgesetzt (nur Optik)
let tickCount, matchTicks, paused, over, timer;
let chartRaf = null, lastTickAt = 0; // für flüssige Chart-Animation (rAF-Loop)
/* Zeitanker der laufenden Runde: remote = gemeinsamer Lobby-Start (startAt),
   local = Rundenbeginn. Nur im Remote-Modus spielbestimmend. */
let roundAnchor = 0;

/* Spielmodus: "solo" = Einzelspieler (eine Runde, nur für sich),
   "local" = Mehrspieler am gleichen Gerät (Pass & Play, beide nacheinander),
   "remote" = zwei Geräte OFFLINE (Code = Seed, Minuten-Start, kein Netz-Request),
   "room"   = Online-Raum (Server-Runden mit geheimem Seed, Live-Rennen, Wertung).
   Timing: "solo" und "local" sind tick-basiert (pausierbar); "remote" und "room"
   laufen nach Weltzeit (wallClock()). "solo"/"remote"/"room" zeigen das eigene
   Ergebnis über showResultSolo. */
let mode = "local";
let sandbox = false;
let sandboxCash = 25000;
let sandboxExpert = false; // 🎓-Toggle des Sandbox-Übungsplatzes
/* 🎓 Experten-Modus (IMPACT-PLAN.md): im Raum per Ersteller-Flag der Runde, in der
   Sandbox per Toggle. Schaltet die lokalen Härten (Spread, Handelsstopp, Limit-Orders,
   Short-Dividende, ACT-Haltekosten) und – NUR im Raum – den dynamischen Markt zu. */
let expert = false;

let durationMin = 15;
document.querySelectorAll(".dur[data-m]").forEach(b => b.onclick = () => {
  durationMin = +b.dataset.m;
  document.querySelectorAll(".dur[data-m]").forEach(x => x.classList.toggle("active", x === b));
});

document.querySelectorAll(".solosub").forEach(b => b.onclick = () => {
  sandbox = b.dataset.sb === "true";
  document.querySelectorAll(".solosub").forEach(x => x.classList.toggle("active", x === b));
  applySoloUI();
  updateStartBtn();
});

document.querySelectorAll(".cap").forEach(b => b.onclick = () => {
  sandboxCash = +b.dataset.cap;
  document.querySelectorAll(".cap").forEach(x => x.classList.toggle("active", x === b));
});

$("sbExpertToggle").onclick = function(){
  sandboxExpert = !sandboxExpert;
  this.classList.toggle("on", sandboxExpert);
  this.querySelector(".opt-check").textContent = sandboxExpert ? "☑" : "☐";
};

function applySoloUI(){
  const solo = mode === "solo";
  $("soloSub").style.display  = solo ? "" : "none";
  $("soloHint").style.display = solo ? "" : "none";
  $("capField").style.display = (solo && sandbox) ? "" : "none";
  $("expField").style.display = (solo && sandbox) ? "" : "none";
  $("durField").style.display = (solo && sandbox) ? "none" : "";
  $("soloHint").textContent   = sandbox
    ? "Freies Üben ohne Zeitdruck – kein Rekord-Eintrag."
    : "Du spielst allein und misst dich an deinem eigenen Rekord.";
}

/* Spiel-Code: 6 Ziffern, dient direkt als Markt-Seed.
   Code mod 3 kodiert die Spieldauer (5/10/15 Min), damit beide Geräte
   automatisch dieselbe Tick-Anzahl und damit denselben Markt bekommen. */
let gameCode = null;
/* Raum-Runden: geheimer Markt-Seed vom Server (Code ≠ Seed → niemand kann vorspielen).
   null = klassisch offline, dann ist der Spiel-Code selbst der Seed. */
let marketSeed = null;
/* Weltzeit-verankerte Modi (kein Pausieren, Tick aus Date.now()) */
const wallClock = () => mode === "remote" || mode === "room";

function makeCode(durIdx){
  let c = 100000 + Math.floor(Math.random()*900000);
  c -= c % 3; c += durIdx;
  if(c > 999999) c -= 3;
  return c;
}

/* Start-Button-Text richtet sich nach Modus und (im Remote-Modus) danach,
   ob ein gültiger Code zum Beitreten eingetippt wurde. */
function updateStartBtn(){
  if(mode === "solo"){
    $("startBtn").textContent = sandbox ? "Sandbox starten 🏖️" : "Spiel starten 🔔";
    return;
  }
  if(mode === "local"){ $("startBtn").textContent = "Duell starten 🔔"; return; }
  const valid = /^\d{6}$/.test(codeIn.value);
  if(mode === "room"){
    $("startBtn").textContent = valid ? "Raum beitreten 🌐" : "Raum eröffnen 🌐";
    return;
  }
  $("startBtn").textContent = valid ? "Spiel beitreten 🔔" : "Spiel anlegen 🔔";
}


function setMode(m){
  mode = m;
  document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  $("field2").style.display    = m === "local" ? "" : "none";   // 2. Name nur bei "Gleiches Gerät"
  $("fieldCode").style.display = (m === "remote" || m === "room") ? "" : "none";
  $("durField").style.display  = m === "room" ? "none" : ""; // Raum: Dauer wird IM Raum gewählt
  $("label1").textContent = m === "local" ? "Spieler 1 (beginnt)" : "Dein Name";
  codeIn.placeholder = m === "room" ? "Leer lassen für neuen Raum" : "Leer lassen für neues Spiel";
  if(m !== "remote" && m !== "room"){
    codeIn.value = "";
    document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = false);
  }
  $("modeHint").textContent = MODE_HINTS[m] || "";
  $("codeErr").textContent = "";
  updateStartBtn();
  applySoloUI();
}
document.querySelectorAll(".mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));

/* Oberste Ebene: Einzelspieler vs. Mehrspieler. Mehrspieler blendet die
   Unterauswahl (gleiches/zwei Geräte) ein. */
function setTop(t){
  document.querySelectorAll(".mtop").forEach(b => b.classList.toggle("active", b.dataset.top === t));
  if(t === "single"){
    $("modeSub").style.display = "none";
    setMode("solo");
  }else{
    sandbox = false;
    document.querySelectorAll(".solosub").forEach(b => b.classList.toggle("active", b.dataset.sb === "false"));
    $("modeSub").style.display = "";
    const sub = document.querySelector(".mode.active");
    setMode(sub ? sub.dataset.mode : "local");
  }
}
document.querySelectorAll(".mtop").forEach(b => b.onclick = () => setTop(b.dataset.top));

const codeIn = $("codeIn");
codeIn.addEventListener("input", () => {
  codeIn.value = codeIn.value.replace(/\D/g, "");
  $("codeErr").textContent = "";
  const valid = /^\d{6}$/.test(codeIn.value);
  // Bei gültigem Code ist die Dauer vorgegeben – Buttons sperren und anzeigen
  document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = valid);
  if(valid){
    durationMin = DURATIONS[+codeIn.value % 3];
    document.querySelectorAll(".dur[data-m]").forEach(x => x.classList.toggle("active", +x.dataset.m === durationMin));
  }
  updateStartBtn();
});

function buildMarket(){
  matchTicks = sandbox
    ? Math.round(60 * 60000 / TICK_MS)
    : Math.round(durationMin * 60000 / TICK_MS);
  market = genMarket(marketSeed == null ? gameCode : marketSeed, matchTicks);
}

function newPlayer(name, color){
  return {name, cash:START_CASH, pos:{}, color, result:null, pendingDiv:0, orders:[],
          stats:{trades:0, buys:0, sells:0, shorts:0, volume:0, realized:0, best:null, worst:null,
                 allIns:0, newsTrades:0, tipTrades:0, bestPct:0, investedTicks:0, perSym:{},
                 peak:START_CASH, trough:START_CASH, maxDD:0, feesPaid:0, dividends:0, slip:0, contra:0}};
}

/* ====================== Lokaler Speicher (Namen + Rekord) ====================== */
/* Bewusst winzig: nur die zuletzt genutzten Namen und der beste je auf diesem
   Gerät erzielte P&L – ein einziger JSON-Schlüssel, wenige hundert Byte.
   Über "Daten löschen" komplett entfernbar. localStorage kann fehlen oder
   gesperrt sein (Privatmodus), darum alles defensiv in try/catch. */
const STORE_KEY = "trading-duell";
const GAME_KEY  = "trading-duell-game";   // laufendes Spiel (Snapshot)
const ROOM_KEY  = "trading-duell-room";   // Raum-Mitgliedschaft
/* Einmalige Migration der früheren Schlüsselnamen (spcx-duell*) auf die neuen,
   damit Rekord, laufendes Spiel und Raum-Mitgliedschaft nach der Umbenennung
   erhalten bleiben. Läuft nur, solange der alte Schlüssel noch existiert. */
try{
  [["spcx-duell", STORE_KEY], ["spcx-duell-game", GAME_KEY], ["spcx-duell-room", ROOM_KEY]].forEach(([o,n]) => {
    const v = localStorage.getItem(o);
    if(v != null){ if(localStorage.getItem(n) == null) localStorage.setItem(n, v); localStorage.removeItem(o); }
  });
}catch(e){}
const loadStore = () => { try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }catch(e){ return {}; } };
const saveStore = s => { try{ localStorage.setItem(STORE_KEY, JSON.stringify(s)); }catch(e){} };

/* Laufendes Spiel sichern, damit man nach Neuladen/Schließen fortsetzen kann.
   Der Markt selbst wird NICHT gespeichert – er entsteht deterministisch neu aus
   dem Code; nur Spielzustand (Bargeld, Positionen, Stats, Tick) wandert rein.
   Eigener Schlüssel, getrennt von Namen/Rekord. Tutorial wird nie gesichert. */
function saveSnapshot(phase){
  if(tutorial || sandbox || (over && phase !== "handover")) return;
  try{
    localStorage.setItem(GAME_KEY, JSON.stringify({
      v:2, mode, gameCode, durationMin, round,
      startAt: wallClock() ? startAt : 0,
      marketSeed, room, roomPhase, // Raum-Runde: Seed + Mitgliedschaft fürs Wiederaufnehmen
      expert, cash: START_CASH,    // 🎓-Regeln + Startkapital der Runde
      tradeLog,                    // Anti-Cheat-Log übersteht den Reload (sonst Ablehnung)
      tickCount, players, phase: phase || "play", ts: Date.now()
    }));
  }catch(e){}
}
function loadSnapshot(){
  try{
    const s = JSON.parse(localStorage.getItem(GAME_KEY));
    if(!s || s.v !== 2) return null;
    if(!["local","remote","solo","room"].includes(s.mode)) return null;
    if(typeof s.gameCode !== "number" || !Array.isArray(s.players) || !s.players.length) return null;
    if(Date.now() - s.ts > 24*3600*1000) return null; // alte Stände nicht wiederbeleben
    return s;
  }catch(e){ return null; }
}
const clearSnapshot = () => { try{ localStorage.removeItem(GAME_KEY); }catch(e){} };

/* Namen merken (beim Spielstart aufgerufen) */
function rememberNames(){
  const s = loadStore();
  s.n1 = $("name1").value.trim().slice(0,14);
  s.n2 = $("name2").value.trim().slice(0,14);
  saveStore(s);
}

/* Rekord aktualisieren, wenn ein abgeschlossenes Ergebnis den Bestwert schlägt.
   Tutorial zählt nicht (wird vom Aufrufer ausgeschlossen). */
function updateRecord(p){
  const s = loadStore();
  if(!s.best || p.result.pnl > s.best.pnl){
    s.best = {pnl: p.result.pnl, name: p.name.slice(0,14), dur: durationMin, date: Date.now()};
    saveStore(s);
  }
}

/* Abgeschlossenes Spiel in die lokale Historie schreiben (neueste zuerst, max. 20).
   Der eingebettete packResult-Code macht jeden Eintrag teil- und vergleichbar. */
function appendGameHistory(p){
  const s = loadStore();
  if(!Array.isArray(s.games)) s.games = [];
  s.games.unshift({date: Date.now(), pnl: p.result.pnl, total: p.result.total,
                   durationMin, name: p.name.slice(0,14), mode, fav: favSym(p), code: packResult(p)});
  if(s.games.length > 20) s.games.length = 20;
  saveStore(s);
}

/* Startbildschirm: Namen vorbelegen, Rekordzeile, Fortsetzen- + Löschen-Button */
function applyStore(){
  const s = loadStore();
  if(s.n1) $("name1").value = s.n1;
  if(s.n2) $("name2").value = s.n2;
  const rec = $("recLine");
  if(s.best){
    rec.innerHTML = `🏆 Rekord: <b>${sgn(s.best.pnl)}</b> · ${esc(s.best.name)} · ${s.best.dur} Min`;
    rec.style.display = "";
  }else{
    rec.style.display = "none";
  }
  const snap = loadSnapshot();
  $("resumeBtn").style.display = snap ? "" : "none";
  $("clearBtn").style.display = (s.n1 || s.n2 || s.best || snap) ? "" : "none";
}

$("clearBtn").onclick = () => {
  try{ localStorage.removeItem(STORE_KEY); }catch(e){}
  clearSnapshot();
  $("name1").value = "Spieler 1";
  $("name2").value = "Spieler 2";
  applyStore();
};

/* Gesichertes Spiel fortsetzen: Markt deterministisch aus dem Code neu erzeugen,
   Spielzustand zurückspielen und an der gemerkten Tick-Position weitermachen. */
$("resumeBtn").onclick = () => {
  const snap = loadSnapshot();
  if(!snap){ applyStore(); return; }
  tutorial = false;
  mode = snap.mode;
  gameCode = snap.gameCode;
  durationMin = snap.durationMin;
  marketSeed = (typeof snap.marketSeed === "number") ? snap.marketSeed : null;
  expert = !!snap.expert;                 // 🎓-Regeln der Runde wiederherstellen
  START_CASH = snap.cash || 25000;
  journal = []; effPaths = null;          // Journal kommt frisch über den Raum-Puls
  tradeLog = Array.isArray(snap.tradeLog) ? snap.tradeLog : [];
  if(snap.room){ room = snap.room; roomPhase = 'playing'; saveRoomState(); startRoomTimer(); }
  matchTicks = Math.round(durationMin * 60000 / TICK_MS);
  market = genMarket(marketSeed == null ? gameCode : marketSeed, matchTicks);
  players = snap.players;
  round = snap.round;
  if(wallClock()) startAt = snap.startAt;
  $("startScreen").classList.remove("show");

  if(snap.phase === "handover"){
    // Lokal: Spieler 1 ist fertig, Übergabe an Spieler 2 wiederherstellen
    over = true;
    $("matchScreen").classList.add("show");
    showHandover(players[0]);
    return;
  }

  startRound(round);          // baut die Runden-UI auf und startet den Tick-Loop
  tickCount = snap.tickCount;  // echte Position wiederherstellen (startRound setzt 0)
  saveSnapshot("play");        // korrigierten Tick sofort sichern (startRound schrieb 0)
  replayNewsUpTo(tickCount);   // vergangene Meldungen still in den Feed zeichnen
  renderAll();
};

applyStore();
setTop("single"); // Startauswahl: Einzelspieler – mode-Variable an die UI angleichen

$("startBtn").onclick = async () => {
  rememberNames();
  marketSeed = null; // frischer Zustand für jedes neue Spiel
  journal = []; effPaths = null;
  if(mode === "solo"){
    // Einzelspieler: ein Spieler, eine Runde, sofortiger Start (keine Lobby).
    // 🎓 Experten-Modus gibt es solo nur im Sandbox-Übungsplatz (nur lokale Härten,
    // kein dynamischer Markt – der braucht Mitspieler + Server).
    expert = sandbox && sandboxExpert;
    START_CASH = sandbox ? sandboxCash : 25000;
    gameCode = makeCode(DURATIONS.indexOf(durationMin));
    buildMarket();
    players = [newPlayer($("name1").value.trim() || "Spieler 1", "var(--p1)")];
    startRound(0);
    return;
  }
  expert = false;
  START_CASH = 25000;
  if(mode === "local"){
    gameCode = makeCode(DURATIONS.indexOf(durationMin));
    buildMarket();
    players = [
      newPlayer($("name1").value.trim() || "Spieler 1", "var(--p1)"),
      newPlayer($("name2").value.trim() || "Spieler 2", "var(--p2)"),
    ];
    startRound(0);
    return;
  }

  const raw = codeIn.value.trim();
  if(raw && !/^\d{6}$/.test(raw)){
    $("codeErr").textContent = "Der Code hat 6 Ziffern.";
    return;
  }

  // Online-Raum: eröffnen oder beitreten – der EINZIGE Weg, der den Server nutzt
  if(mode === "room"){
    const btn = $("startBtn"), oldTxt = btn.textContent;
    btn.disabled = true; btn.textContent = "Verbinde …";
    try{
      await (raw ? joinRoom(raw) : createRoom());
    }catch(e){
      $("codeErr").textContent = String(e && e.message).includes("409")
        ? "Beitritt nicht möglich – der Raum ist voll."
        : "Raum nicht erreichbar – Internet prüfen oder Code kontrollieren.";
    }finally{
      btn.disabled = false; btn.textContent = oldTxt; updateStartBtn();
    }
    return;
  }

  // Mehrere Geräte (OFFLINE): komplett ohne Netz – gleicher Code = gleicher Markt,
  // Start zur übernächsten vollen Minute, Ergebnistausch per Code/QR.
  const joined = !!raw;
  if(joined){
    gameCode = +raw;
    durationMin = DURATIONS[gameCode % 3];
  }else{
    gameCode = makeCode(DURATIONS.indexOf(durationMin));
  }
  buildMarket();
  players = [newPlayer(
    $("name1").value.trim() || (joined ? "Spieler 2" : "Spieler 1"),
    joined ? "var(--p2)" : "var(--p1)"
  )];
  openLobby(joined);
};

/* ====================== Lobby (zeitversetzter Start) ====================== */
/* Start immer zur übernächsten vollen Minute. Geben beide Geräte den Code
   innerhalb derselben Minute ein, landen sie auf demselben Startzeitpunkt
   und spielen zeitgleich – ganz ohne Server. */
let lobbyTimer = null, startAt = 0;

/* Spieltipps für die Wartezeit (Lobby + Vorlauf). Reine Optik – kein rnd()/Fairness-Bezug. */
let tipTimer = null, tipIdx = 0, tipEls = [];
function startTips(ids){
  stopTips();
  tipEls = ids;
  tipIdx = Math.floor(Math.random() * TIPS.length); // nur Anzeige → Math.random ok
  const show = () => { const t = TIPS[tipIdx++ % TIPS.length]; for(const id of tipEls){ const el = $(id); if(el) el.textContent = t; } };
  show();
  tipTimer = setInterval(show, 4500);
}
function stopTips(){ clearInterval(tipTimer); tipTimer = null; }

const hhmm = ms => {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
};

function openLobby(joined){
  // Offline-Duell (Mehrere Geräte): Start zur übernächsten vollen Minute – serverloser
  // Gleichstand: beide Geräte mit demselben Code in derselben Minute = gleicher Start.
  startAt = (Math.floor(Date.now()/60000) + 2) * 60000;
  $("lobbyEyebrow").textContent = joined ? "Spiel beigetreten" : "Spiel angelegt";
  $("lobbyHead").textContent = joined ? "Auf die Plätze!" : "Bereitmachen!";
  $("lobbyCode").textContent = String(gameCode).padStart(6, "0");
  $("lobbyShare").textContent = "📤 Einladung teilen";
  $("lobbySub").innerHTML = joined
    ? "Exakt dasselbe Spiel wie auf dem anderen Gerät – gleiche Kurse, gleiche News.<br>" +
      "Wurde es dort in derselben Minute angelegt, startet ihr zeitgleich."
    : `Code fürs zweite Gerät – dort vor <b style="color:var(--text)">${hhmm(startAt - 60000)}</b> Uhr
       beitreten, dann startet ihr zeitgleich.`;
  // QR-Code des Einladungs-Links zeigen (nur wenn es eine teilbare http(s)-URL gibt)
  const joinUrl = shareUrl("join", String(gameCode).padStart(6, "0"));
  const qrOk = joinUrl && typeof drawQR === "function" && drawQR($("lobbyQR"), joinUrl, {size:200});
  $("lobbyQRWrap").style.display = qrOk ? "" : "none";
  $("lobbyStartRow").style.display = "";
  $("lobbyTime").textContent = hhmm(startAt);
  clearInterval(lobbyTimer);
  updateLobby();
  lobbyTimer = setInterval(updateLobby, 250);
  $("lobby").classList.add("show");
  startTips(["lobbyTip", "preTip"]); // Tipps während der Wartezeit (auch im Vorlauf-Fenster)
}

function updateLobby(){
  const left = startAt - Date.now();
  if(left <= 0){
    clearInterval(lobbyTimer);
    $("lobby").classList.remove("show");
    $("preStart").classList.remove("show");
    startRound(0); // exakt bei startAt – kein lokales Delay, alle Geräte synchron
    return;
  }
  if(left <= 5000){
    // Letzte 5 s: ins Vorlauf-Fenster wechseln. An die Weltuhr geankert, daher zählen
    // alle Geräte denselben Wert und starten gleichzeitig bei startAt.
    $("lobby").classList.remove("show");
    $("preNum").textContent = Math.ceil(left/1000);
    $("preStart").classList.add("show");
  }
  $("lobbyCount").textContent = Math.ceil(left/1000) + " s";
}

$("lobbyCancel").onclick = () => {
  clearInterval(lobbyTimer);
  stopTips();
  $("lobby").classList.remove("show");
};

/* ====================== Online-Raum (Cloudflare Worker) ====================== */
/* Der Raum ist der Treffpunkt des Abends: einmal beitreten, Runden auf Befehl des
   Erstellers, Abend-Wertung, Rolle 🎮/🖥️ frei wählbar. Der Raum-Modus ist der EINZIGE
   Pfad, der den Server nutzt – Solo/Lokal/Offline machen keinerlei Netz-Requests. */

/* Kleine fetch-Hülle mit Timeout; Fehler werfen und werden vom Aufrufer behandelt. */
async function api(path, opts, timeoutMs){
  if(!ONLINE_API) throw new Error("offline");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 4000);
  try{
    const res = await fetch(ONLINE_API + path, Object.assign({signal: ctl.signal}, opts));
    if(!res.ok) throw new Error("http " + res.status);
    return res;
  }finally{ clearTimeout(t); }
}
const apiJson = async (path, opts) => (await api(path, opts)).json();

/* Mitgliedschaft: {code, token, p, role, name, played, ts} – überlebt Reloads/App-Wechsel */
let room = null, roomState = null, roomTimer = null, roomPhase = "idle", roomTickN = 0, roomDurPick = null;
let roomExpertPick = false, roomCashPick = 25000; // Ersteller-Wahl für die nächste Runde
/* Blockorder-Journal der laufenden Expert-Runde (vom Server gestempelt, anonym) und
   die daraus abgeleiteten Effektiv-Pfade (Basis × Impact-Overlay). effPaths ist NUR
   im Expert-Raum gesetzt – alle anderen Modi laufen unverändert auf market.paths. */
let journal = [], effPaths = null;
/* Anti-Cheat: jede ausgeführte Order der Raum-Runde wird mitgeschrieben
   ([tick, sym, side, qty, block10]) und am Ende MIT dem Ergebnis eingereicht –
   der Server spielt das Log nach und errechnet das P&L selbst (worker.js v5). */
let tradeLog = [], roomSus = {}, roomBot = {}, submitFail = false;
/* Einladung (QR + Link) ist einklappbar: automatisch offen, solange man allein ist,
   danach zu – bis jemand den Knopf antippt (dann bleibt die Wahl bestehen). */
let roomInviteOpen = true, roomInviteTouched = false;
function applyRoomInvite(){
  $("roomInvite").style.display = roomInviteOpen ? "" : "none";
  $("roomInviteBtn").textContent = roomInviteOpen ? "▲ Einladung ausblenden" : "📤 Einladung";
}
$("roomInviteBtn").onclick = () => { roomInviteTouched = true; roomInviteOpen = !roomInviteOpen; applyRoomInvite(); };
function saveRoomState(){
  if(!room) return;
  try{ localStorage.setItem(ROOM_KEY, JSON.stringify(Object.assign({}, room, {ts: Date.now()}))); }catch(e){}
}
const clearRoomState = () => { try{ localStorage.removeItem(ROOM_KEY); }catch(e){} };
function loadRoomState(){
  try{
    const r = JSON.parse(localStorage.getItem(ROOM_KEY));
    if(!r || !/^\d{6}$/.test(r.code || "") || !r.token || !r.p) return null;
    if(Date.now() - r.ts > 24*3600*1000) return null;
    return r;
  }catch(e){ return null; }
}

async function createRoom(){
  const j = await apiJson("/room", {method: "POST",
    body: JSON.stringify({name: $("name1").value.trim()})});
  room = {code: j.code, token: j.token, p: j.p, role: "player",
          name: $("name1").value.trim() || "Spieler 1", played: 0};
  saveRoomState();
  showRoomScreen();
}
async function joinRoom(code){
  const old = loadRoomState();
  if(old && old.code === code){ room = old; }        // eigene Mitgliedschaft wiederverwenden
  else{
    const j = await apiJson("/room/" + code + "/join", {method: "POST",
      body: JSON.stringify({name: $("name1").value.trim()})});
    room = {code, token: j.token, p: j.p, role: "player",
            name: $("name1").value.trim() || ("Spieler " + j.p), played: 0};
  }
  saveRoomState();
  showRoomScreen();
}
function showRoomScreen(){
  $("startScreen").classList.remove("show");
  $("statsScreen").classList.remove("show");
  $("matchScreen").classList.remove("show");
  $("roomScreen").classList.add("show");
  $("roomCodeBig").textContent = room ? room.code : "";
  const url = shareUrl("room", room ? room.code : "");
  const qrOk = url && typeof drawQR === "function" && drawQR($("roomQR"), url, {size:200});
  $("roomQRWrap").style.display = qrOk ? "" : "none";
  roomInviteOpen = true; roomInviteTouched = false; applyRoomInvite(); // frisch: Einladung offen
  $("roomBackBtn").style.display = "none";
  window.scrollTo(0, 0);
  startRoomTimer();
  roomTick();
}
function startRoomTimer(){
  clearInterval(roomTimer);
  roomTimer = setInterval(roomTick, 2500);
}
function leaveRoom(msg){
  clearInterval(roomTimer); roomTimer = null;
  stopWall();
  room = null; roomState = null; roomPhase = "idle"; roomDurPick = null;
  clearRoomState();
  $("roomBackBtn").style.display = "none"; // Mitgliedschaft weg → kein Rückkehr-Knopf
  $("roomScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  if(msg) $("codeErr").textContent = msg;
}
$("roomLeaveBtn").onclick = () => leaveRoom("");
$("roomShareBtn").onclick = async function(){
  if(!room) return;
  const url = shareUrl("room", room.code);
  const txt = `🚀 Trading Duell – komm in unseren Raum!\nRaum-Code: ${room.code}` +
              (url ? `\nZum Beitreten antippen: ${url}` : "");
  try{
    this.textContent = (await shareOut(txt)) === "geteilt" ? "✅ Geteilt!" : "✅ Kopiert!";
    setTimeout(() => { this.textContent = "📤 Einladung teilen"; }, 1800);
  }catch(e){
    if(e && e.name === "AbortError") return;
    window.prompt("Zum Kopieren markieren:", txt);
  }
};
$("roomRoleBtn").onclick = async function(){
  if(!room) return;
  const target = room.role === "wall" ? "player" : "wall";
  try{
    await apiJson("/room/" + room.code + "/role",
      {method: "POST", body: JSON.stringify({token: room.token, role: target})});
    room.role = target; saveRoomState();
    roomTick();
  }catch(e){
    $("roomHint").textContent = target === "player"
      ? "Kein Spieler-Platz mehr frei (max. 20)." : "Wechsel gerade nicht möglich.";
  }
};
document.querySelectorAll(".rdur").forEach(b => b.onclick = () => {
  roomDurPick = +b.dataset.m;
  if(roomState) renderRoomScreen(roomState);
});
/* Runden-Optionen (nur Ersteller): 🎓-Toggle + 💰-Startkapital für die NÄCHSTE Runde */
$("expertToggle").onclick = () => {
  roomExpertPick = !roomExpertPick;
  if(roomState) renderRoomScreen(roomState);
};
document.querySelectorAll(".rcash").forEach(b => b.onclick = () => {
  roomCashPick = +b.dataset.c;
  document.querySelectorAll(".rcash").forEach(x => x.classList.toggle("active", x === b));
});
$("roomStartBtn").onclick = async function(){
  if(!room) return;
  this.disabled = true; $("roomErr").textContent = "";
  try{
    const rd = await apiJson("/room/" + room.code + "/start",
      {method: "POST", body: JSON.stringify({token: room.token, dur: roomDurPick || undefined,
        expert: roomExpertPick || undefined, cash: roomExpertPick ? roomCashPick : undefined})});
    startRoomRound(rd);
  }catch(e){
    $("roomErr").textContent = "Start nicht möglich – läuft noch eine Runde, oder es fehlen Spieler.";
  }finally{ this.disabled = false; }
};

/* Der eine Puls des Raums (~2,5 s): Herzschlag + Aggregat. Verteilt die Daten je nach
   Phase: Raum-Ansicht, Runden-Erkennung, Live-Rennen, Ranglisten-Nachzügler. */
async function roomTick(){
  if(!room) return;
  let st;
  try{ st = await apiJson("/room/" + room.code + "?me=" + room.token); }
  catch(e){
    if(String(e && e.message).includes("404")) leaveRoom("Der Raum ist abgelaufen – bitte einen neuen eröffnen.");
    return; // kurzer Aussetzer: nächster Puls
  }
  if(!room) return;
  roomState = st;
  roomSus = st.sus || {};   // 🤨-Verdachts-Flags der laufenden Runde (Server-Orakel-Check)
  roomBot = st.bot || {};   // 🤖-Verdachts-Flags (Server-Timing-Heuristik)
  const rd = st.round;
  /* Expert-Runde: Blockorder-Journal übernehmen. Neue Einträge landen als Meldung im
     Feed; die Effektiv-Pfade werden neu aufgebaut (Wirkung erst REACT_TICKS nach dem
     Server-Stempel – alle Geräte rechnen aus demselben Journal denselben Kurs). */
  if(st.trades && expert && roomPhase === "playing" && st.trades.length > journal.length){
    const seen = journal.length;
    journal = st.trades;
    rebuildEff();
    if(!over) for(let i = seen; i < journal.length; i++) announceBlock(journal[i]);
  }
  // Neue Runde erkannt → mitspielen (nur Spieler-Rolle, nur wenn der Start frisch ist;
  // Zuspätkommer und Leinwände bleiben im Raum und sehen den Live-Stand)
  if(roomPhase === "idle" && rd && rd.n > (room.played || 0) &&
     room.role === "player" && Date.now() <= rd.startAt + 30000){
    startRoomRound(rd);
    return;
  }
  if(roomPhase === "playing"){
    if(room.role === "player" && rd && !over && players[round]){
      roomTickN++;
      if(roomTickN % 2 === 0){ // ~alle 5 s den eigenen Stand melden
        const own = totalOf(players[round]) - START_CASH;
        await api("/room/" + room.code + "/round/" + (room.played || rd.n) + "/pnl/" + room.p,
            {method: "PUT", body: JSON.stringify({pnl: Math.round(own * 100) / 100}),
             headers: {"x-token": room.token}}).catch(() => {});
      }
    }
    renderRace(st);
  }
  // Leinwand-Rolle: Großbild an, solange eine Runde läuft (inkl. Countdown-Fenster)
  if(room.role === "wall" && rd){
    const nw = Date.now();
    const runningW = nw >= rd.startAt - 8000 && nw < rd.startAt + rd.dur * 60000;
    if(runningW) ensureWall(rd);
    else if(wallOn) stopWall();
    if(wallOn){
      // Expert-Runde: Journal in Effektiv-Pfade + Squeeze-Liste übersetzen
      if(rd.expert && st.trades && st.trades.length !== wallJournal.length){
        wallJournal = st.trades;
        const res = buildEffPaths(wallMarket, wallJournal, wallInfo.startAt, wallTicksTotal());
        wallEff = res.eff; wallSqueezes = res.squeezes;
      }
      renderWallBoard(st);
    }
  }else if(wallOn) stopWall();
  // Runden-Rangliste offen: eingetroffene Ergebnisse der Mitspieler nachladen
  if(rankRoom && st.results){
    let added = false;
    for(const p in st.results){
      if(rankResults[p]) continue;
      const o = unpackResult(st.results[p]);
      if(o && !o.wrongGame && (o.seed === undefined || o.seed === (marketSeed >>> 0))){
        rankResults[p] = o; added = true;
      }
    }
    if(added) renderRanking();
  }
  renderRoomScreen(st);
}

function renderRoomScreen(st){
  if(!room) return;
  const names = {}; st.members.forEach(m => names[m.p] = m.name);
  // Mitglieder
  let mh = "";
  for(const m of st.members){
    mh += `<div class="room-member"><span class="rdot${m.online ? " on" : ""}"></span>` +
          `<span class="rm-name">${m.p === 1 ? "👑 " : ""}${esc(m.name)}${m.p === room.p ? " (du)" : ""}</span>` +
          `<span class="rm-role">${m.role === "wall" ? "🖥️ Leinwand" : "🎮"}</span></div>`;
  }
  $("roomMembers").innerHTML = mh;
  // Abend-Wertung (sobald es Ergebnisse gibt)
  const sb = (st.scoreboard || []).slice().sort((a, b) => b.wins - a.wins || b.total - a.total);
  if(sb.length){
    $("roomScore").innerHTML = sb.map((s, i) =>
      `<div class="rank-row${s.p === room.p ? " me" : ""}">
        <span class="rank-pos">${i === 0 ? "👑" : (i + 1) + "."}</span>
        <span class="rank-name">${esc(names[s.p] || ("Spieler " + s.p))} · ${s.wins} ${s.wins === 1 ? "Sieg" : "Siege"}${
          s.sus ? ` <span title="${s.sus} Runde(n) verdächtig nah am theoretischen Maximum">🤨${s.sus > 1 ? "×" + s.sus : ""}</span>` : ""}${
          s.bot ? ` <span title="${s.bot} Runde(n) mit Roboter-Timing (Einstiege vor unangekündigten News / Sofort-Reaktionen)">🤖${s.bot > 1 ? "×" + s.bot : ""}</span>` : ""}</span>
        <span class="rank-pnl" style="color:${s.total >= 0 ? "var(--up)" : "var(--down)"}">${sgn(s.total)}</span></div>`).join("");
    $("roomScoreField").style.display = "";
  }else $("roomScoreField").style.display = "none";
  // Läuft gerade eine Runde (und wir stehen im Raum)? → Live-Stand für Leinwand/Zuspätkommer
  const now = Date.now();
  const rd = st.round;
  const running = rd && now >= rd.startAt - 1000 && now < rd.startAt + rd.dur * 60000;
  if(running && roomPhase === "idle"){
    const left = Math.max(0, rd.startAt + rd.dur * 60000 - now);
    $("roomLiveLabel").textContent =
      `Runde ${rd.n} läuft – noch ${Math.floor(left/60000)}:${String(Math.floor(left % 60000 / 1000)).padStart(2, "0")}`;
    const rows = Object.keys(st.pnls || {}).map(p => ({p: +p, v: st.pnls[p]})).sort((a, b) => b.v - a.v);
    $("roomLive").innerHTML = rows.length
      ? rows.map((r, i) =>
          `<div class="rank-row"><span class="rank-pos">${i === 0 ? "👑" : (i + 1) + "."}</span>
           <span class="rank-name">${esc(names[r.p] || "?")}</span>
           <span class="rank-pnl" style="color:${r.v >= 0 ? "var(--up)" : "var(--down)"}">${sgn(r.v)}</span></div>`).join("")
      : '<div class="mode-hint">Gleich kommen die ersten Meldungen …</div>';
    $("roomLiveField").style.display = "";
  }else $("roomLiveField").style.display = "none";
  // Start-Bereich: nur Ersteller, ≥2 Spieler, keine laufende Runde
  const playersN = st.members.filter(m => m.role === "player").length;
  const canStart = room.p === 1 && playersN >= 2 && !running && roomPhase === "idle";
  $("roomStartField").style.display = canStart ? "" : "none";
  if(canStart){
    const pick = roomDurPick || st.dur;
    document.querySelectorAll(".rdur").forEach(b => b.classList.toggle("active", +b.dataset.m === pick));
  }
  // Runden-Optionen: eigener Block unterhalb des Start-Bereichs, NUR für den Ersteller
  $("roomOptField").style.display = canStart ? "" : "none";
  if(canStart){
    $("expertToggle").classList.toggle("on", roomExpertPick);
    $("expertToggle").querySelector(".opt-check").textContent = roomExpertPick ? "☑" : "☐";
    $("expertCash").style.display = roomExpertPick ? "" : "none";
    document.querySelectorAll(".rcash").forEach(b => b.classList.toggle("active", +b.dataset.c === roomCashPick));
  }
  const waiting = roomPhase === "idle" && !running && !canStart;
  $("roomWaitHint").style.display = waiting ? "" : "none";
  if(waiting) $("roomWaitHint").textContent = room.p === 1
    ? "Warte auf Mitspieler – mindestens 2 Spieler nötig …"
    : "Der Ersteller startet die nächste Runde …";
  $("roomRoleBtn").textContent = room.role === "wall" ? "🎮 Wieder mitspielen" : "🖥️ Dieses Gerät als Leinwand";
  // Teilnehmerzahl + Einladung automatisch ein-/ausklappen (offen, solange man allein ist)
  const total = st.members.length;
  $("roomCount").textContent = total + (total === 1 ? " Person" : " Personen");
  if(!roomInviteTouched){ roomInviteOpen = playersN < 2; applyRoomInvite(); }
}

/* ====================== Leinwand: Großbild während der Runde ======================
   Ein Leinwand-Gerät baut den Markt selbst aus dem Runden-Seed (kein Extra-Datenstrom)
   und rendert: Auto-Fokus-Chart (heißester Wert), Mini-Chart-Wand, Live-Rangliste,
   Restzeit und News – Breaking News als Vollbild-Einblendung. Rein lesend. */
let wallOn = false, wallRoundN = 0, wallMarket = null, wallInfo = null,
    wallRaf = 0, wallNewsSeen = 0, wallDismissed = 0, wallFlashUntil = 0,
    wallFocus = null, wallFocusUntil = 0, wallChartMode = "line", wallSlowAt = 0;
/* Expert-Runden auf der Leinwand: eigenes Journal + Effektiv-Pfade (gleiche
   deterministische Formeln wie beim Spieler, nur mit dem Runden-Anker) */
let wallJournal = [], wallEff = null, wallSqueezes = [], wallSqSeen = 0,
    wallBlockSeen = 0, wallBlockUntil = 0;
const wallPaths = () => wallEff || wallMarket.paths;

function wallTicksTotal(){ return Math.round(wallInfo.dur * 60000 / TICK_MS); }
function wallTickNow(){
  return Math.max(0, Math.min(wallTicksTotal(), Math.floor((Date.now() - wallInfo.startAt) / TICK_MS)));
}
/* Weltzeit-genaue Tick-Position samt Sub-Tick-Fortschritt (0..1) für die glatte
   Interpolation des Fokus-Charts – analog zum Spieler-Chart, nur wall-clock statt lastTickAt. */
function wallClockTick(){
  const total = wallTicksTotal();
  const el = (Date.now() - wallInfo.startAt) / TICK_MS;
  if(el <= 0) return {t: 0, prog: 0};
  if(el >= total) return {t: total, prog: 1};
  const t = Math.floor(el);
  return {t, prog: el - t};
}
function ensureWall(rd){
  if(wallDismissed === rd.n) return;                 // für diese Runde bewusst geschlossen
  if(wallOn && wallRoundN === rd.n) return;
  wallRoundN = rd.n;
  wallInfo = {n: rd.n, dur: rd.dur, startAt: rd.startAt, seed: rd.seed >>> 0};
  wallMarket = genMarket(wallInfo.seed, wallTicksTotal());
  wallJournal = []; wallEff = null; wallSqueezes = []; wallBlockSeen = 0; wallBlockUntil = 0;
  // beim Einstieg mitten in der Runde: Vergangenes nicht als Feuerwerk nachholen
  wallNewsSeen = wallMarket.events.filter(e => e.tick <= wallTickNow()).length;
  wallSqSeen = -1; // -1 = beim ersten Journal-Empfang auf den Ist-Stand setzen
  buildWallMinis();
  $("wallRoom").textContent = room ? room.code : "";
  $("wallRound").textContent = rd.n;
  $("wallFlash").style.display = "none"; wallFlashUntil = 0;
  wallOn = true;
  wallFocus = null; wallFocusUntil = 0; wallSlowAt = 0;
  $("roomScreen").classList.remove("show");
  $("wallScreen").classList.add("show");
  if(!wallRaf) wallFrame();   // sofort einmal zeichnen und die rAF-Schleife anstoßen (keine Doppel-Schleife)
}
function stopWall(){
  if(!wallOn) return;
  wallOn = false;
  if(wallRaf){ cancelAnimationFrame(wallRaf); wallRaf = 0; }
  $("wallScreen").classList.remove("show");
  if(room) $("roomScreen").classList.add("show");
}
$("wallExit").onclick = () => { wallDismissed = wallRoundN; stopWall(); };
document.querySelectorAll("#wallToggle .ctg").forEach(b => b.onclick = () => {
  wallChartMode = b.dataset.w;
  document.querySelectorAll("#wallToggle .ctg").forEach(x => x.classList.toggle("active", x === b));
});

/* Frisch von einer News getroffener (nicht marktweiter) Wert der letzten ~25 Ticks */
function wallNewsHit(t){
  let hit = null;
  for(const e of wallMarket.events)
    if(e.ev.t !== "ALL" && e.tick <= t && t - e.tick < 25) hit = e.ev.t;
  return hit;
}
/* Größte Bewegung der letzten ~90 Ticks (Fallback ohne aktuelle News) */
function wallFocusSym(t){
  let best = "SPCX", bm = -1;
  const back = Math.min(t, 90);
  if(back < 2) return best;
  for(const s of DISPLAY_SYMS){
    const p = wallPaths()[s];
    const m = Math.abs(p[t] / p[t - back] - 1);
    if(m > bm){ bm = m; best = s; }
  }
  return best;
}
/* Fokuswahl mit „Verweildauer": News ziehen den Blick sofort auf sich, sonst wird
   der größte Bewegen gehalten – aber mindestens ein paar Sekunden, damit die
   Leinwand nicht zwischen Werten flackert. */
function wallPickFocus(t, now){
  const hit = wallNewsHit(t);
  if(hit){
    if(hit !== wallFocus){ wallFocus = hit; wallFocusUntil = now + 7000; }
    else wallFocusUntil = Math.max(wallFocusUntil, now + 4000);
    return wallFocus;
  }
  if(wallFocus && now < wallFocusUntil) return wallFocus;
  const best = wallFocusSym(t);
  if(best !== wallFocus){ wallFocus = best; wallFocusUntil = now + 6000; }
  else wallFocusUntil = now + 3000;
  return wallFocus;
}
/* Kompakter Linien-Painter (Leinwand hat eigene Canvases, unabhängig vom Spiel-Chart) */
function drawWallLine(cv, path, t, back){
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 300, H = cv.clientHeight || 120;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const b = Math.min(t, back);
  const data = wallMarketSlice(path, t, b);
  if(data.length < 2) return;
  let mn = Math.min(...data), mx = Math.max(...data);
  if(mx - mn < 1e-9) mx = mn + 1;
  const X = i => i / (data.length - 1) * (W - 6) + 3;
  const Y = v => H - 5 - (v - mn) / (mx - mn) * (H - 10);
  const up = data[data.length - 1] >= data[0];
  ctx.strokeStyle = up ? "#3DDC97" : "#FF5C72";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
  ctx.stroke();
  ctx.lineTo(X(data.length - 1), H); ctx.lineTo(X(0), H); ctx.closePath();
  ctx.fillStyle = up ? "rgba(61,220,151,.12)" : "rgba(255,92,114,.12)";
  ctx.fill();
}
const wallMarketSlice = (path, t, back) => path.slice(Math.max(0, t - back), t + 1);

function buildWallMinis(){
  $("wallMinis").innerHTML = DISPLAY_SYMS.map(s =>
    `<div class="wall-mini"><canvas id="wm-${s}"></canvas>
     <div class="wm-l"><b>${s}</b><span class="wm-skew" id="wmsk-${s}"></span><span id="wmc-${s}"></span></div></div>`).join("");
}
/* rAF-Schleife: das Fokus-Chart wird jeden Frame glatt interpoliert (wie der Spieler-
   Chart), die schwereren Teile (Mini-Wand, Rangliste-Text, News, Restzeit) laufen
   gedrosselt ~3×/s über wallSlow(). */
function wallFrame(){
  if(!wallOn || !wallMarket){ wallRaf = 0; return; }
  wallRaf = requestAnimationFrame(wallFrame);
  const now = Date.now();
  const {t, prog} = wallClockTick();
  const sym = wallPickFocus(t, now);
  // Fokus-Chart über den echten Spieler-Renderer (Kerzen/Linie, Live-Marker, Fläche);
  // in Expert-Runden auf den Effektiv-Pfaden (Blockorders/Squeeze sichtbar)
  drawChart({canvas: $("wallChart"), sym, market: {paths: wallPaths()}, tick: t, prog,
             pos: null, chartMode: wallChartMode, big: true});
  const p = wallPaths()[sym];
  const live = t >= 1 ? p[t-1] + (p[t] - p[t-1]) * prog : (p[0] || 0);
  const ch = (live / p[0] - 1) * 100;
  $("wallSym").textContent = sym;
  $("wallPx").textContent = fmt(live);
  const che = $("wallChg");
  che.textContent = (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%";
  che.style.color = ch >= 0 ? "var(--up)" : "var(--down)";
  if(now - wallSlowAt >= 320){ wallSlowAt = now; wallSlow(now, t, sym); }
}
function wallSlow(now, t, focus){
  // Restzeit (bzw. Countdown vor dem Start)
  const leftMs = wallInfo.startAt > now
    ? wallInfo.startAt - now
    : Math.max(0, wallInfo.startAt + wallInfo.dur * 60000 - now);
  $("wallTime").textContent = (wallInfo.startAt > now ? "Start in " : "") +
    Math.floor(leftMs / 60000) + ":" + String(Math.floor(leftMs % 60000 / 1000)).padStart(2, "0");
  // Mini-Wand (kompakte Sparklines); Fokus-Wert hervorgehoben, Herden-Schieflage daneben
  for(const s of DISPLAY_SYMS){
    const cv = $("wm-" + s);
    if(!cv) continue;
    if(cv.parentElement) cv.parentElement.classList.toggle("hot", s === focus);
    drawWallLine(cv, wallPaths()[s], t, 150);
    const q = wallPaths()[s], c2 = (q[t] / q[0] - 1) * 100;
    const el = $("wmc-" + s);
    el.textContent = (c2 >= 0 ? "+" : "") + c2.toFixed(1) + "%";
    el.style.color = c2 >= 0 ? "var(--up)" : "var(--down)";
    const sk = $("wmsk-" + s);
    if(sk){
      const trs = wallJournal.length ? wallJournal.filter(x => x.sym === s) : null;
      const v = trs && trs.length ? skewAt(trs, t, wallInfo.startAt) : 0;
      sk.textContent = Math.abs(v) < 0.1 ? "" :
        (v > 0 ? "🐂" : "🐻").repeat(Math.min(3, Math.ceil(Math.abs(v) * 3)));
    }
  }
  // News-Band + Vollbild-Einblendung für frische Meldungen
  const evs = wallMarket.events.filter(e => e.tick <= t);
  let band = evs.length ? "📰 " + evs[evs.length - 1].ev.txt : null;
  if(evs.length > wallNewsSeen){
    const e = evs[evs.length - 1];
    wallNewsSeen = evs.length;
    $("wallFlashText").textContent = (e.mega ? "🚨 " : "📰 ") + e.ev.txt;
    $("wallFlash").style.display = "";
    wallFlashUntil = now + (e.mega ? 8000 : 4500);
  }
  // Frische Blockorders übernehmen kurz das News-Band (anonym – wer war's?!)
  if(wallJournal.length > wallBlockSeen){
    wallBlockSeen = wallJournal.length;
    wallBlockUntil = now + 7000;
  }
  if(wallBlockUntil > now && wallJournal.length){
    const tr = wallJournal[wallJournal.length - 1];
    band = tr.side === "buy"
      ? `🐘 Blockorder: Jemand kauft groß ${tr.sym} ein!`
      : `🐘 Blockorder: Jemand wirft ${tr.sym} im großen Stil ab!`;
  }
  if(band) $("wallNews").textContent = band;
  // Squeeze/Blasen-Crash: Vollbild-Flash, sobald die Wirkung zündet
  const due = wallSqueezes.filter(q => q.hitTick <= t);
  if(wallSqSeen < 0) wallSqSeen = due.length; // Einstieg mitten in der Runde: nicht nachholen
  if(due.length > wallSqSeen){
    const q = due[due.length - 1];
    wallSqSeen = due.length;
    $("wallFlashText").textContent = q.short
      ? `🔥 SHORT SQUEEZE: ${q.sym}!` : `💥 BLASE PLATZT: ${q.sym}!`;
    $("wallFlash").style.display = "";
    wallFlashUntil = now + 6000;
  }
  if(wallFlashUntil && now > wallFlashUntil){
    $("wallFlash").style.display = "none";
    wallFlashUntil = 0;
  }
}
/* Rangliste der Leinwand aus dem Raum-Puls speisen */
function renderWallBoard(st){
  const names = {};
  (st.members || []).forEach(m => names[m.p] = m.name);
  const rows = Object.keys(st.pnls || {}).map(p => ({p: +p, v: st.pnls[p]})).sort((a, b) => b.v - a.v);
  $("wallBoard").innerHTML = rows.length
    ? rows.map((r, i) =>
        `<div class="wall-row"><span class="wall-pos">${i === 0 ? "👑" : (i + 1) + "."}</span>
         <span class="wall-nm">${esc(names[r.p] || "?")}</span>
         <span class="wall-v" style="color:${r.v >= 0 ? "var(--up)" : "var(--down)"}">${sgn(r.v)}</span></div>`).join("")
    : '<div class="mode-hint">Gleich geht\'s los …</div>';
}

/* Runde angenommen: Markt aus dem Runden-Seed bauen und auf das gemeinsame
   wall-clock startAt herunterzählen (3-2-1 übernimmt das Vorlauf-Fenster). */
function startRoomRound(rd){
  if(!room || room.role !== "player") return;
  if(rd.n <= (room.played || 0)) return;
  if(Date.now() > rd.startAt + 30000) return; // zu spät – ab der nächsten Runde dabei
  room.played = rd.n; saveRoomState();
  roomPhase = "countdown";
  sandbox = false; tutorial = false;
  expert = !!rd.expert;                                  // 🎓-Flag der Runden-Ressource
  START_CASH = expert && rd.cash ? rd.cash : 25000;      // Startkapital nur per Expert wählbar
  journal = []; effPaths = null;
  tradeLog = []; submitFail = false;                     // frisches Anti-Cheat-Log je Runde
  durationMin = rd.dur;
  gameCode = +room.code;          // Anzeige + Payload-Prüfung laufen über den Raum-Code
  marketSeed = rd.seed >>> 0;     // der geheime Seed der Runde
  buildMarket();
  players = [newPlayer(room.name || ("Spieler " + room.p),
                       room.p === 1 ? "var(--p1)" : "var(--p2)")];
  startAt = rd.startAt;
  clearInterval(lobbyTimer);
  updateLobby();
  lobbyTimer = setInterval(updateLobby, 250);
}

/* Ergebnis der Runde abliefern (write-once; ?pnl speist die Abend-Wertung),
   dann die Runden-Rangliste öffnen – sie füllt sich über den Raum-Puls. */
async function roomShareResult(p){
  if(!room) return;
  const n = room.played || 0;
  if(!n) return;
  try{
    // Anti-Cheat (worker.js v5): Ergebnis + komplettes Trade-Log – der Server
    // spielt das Log nach und übernimmt SEIN P&L in Wertung und Rangliste.
    await api("/room/" + room.code + "/round/" + n + "/result/" + room.p +
              "?pnl=" + (Math.round(p.result.pnl * 100) / 100),
              {method: "PUT", body: JSON.stringify({res: packResult(p), log: tradeLog}),
               headers: {"x-token": room.token}});
  }catch(e){
    // 409 = schon abgeliefert (z. B. nach Resume) – unkritisch.
    // 422 = Server-Replay widerspricht → Ergebnis zählt nicht (Hinweis in der Rangliste).
    if(String(e && e.message).includes("422")) submitFail = true;
  }
  startRanking(p);
}

/* ===== Runden-Rangliste (Raum) ===== */
let rankResults = null, rankRoom = null;
function startRanking(p){
  rankRoom = {n: room.played || 0, members: (roomState && roomState.members) || []};
  rankResults = {};
  const own = unpackResult(packResult(p)); // eigenes Ergebnis in derselben Form wie die fremden
  own.self = true;
  rankResults[room.p] = own;
  $("cmpBox").style.display = "none";
  showRankView();
  renderRanking();
}
function showRankView(){
  $("resTitle").textContent = "Rangliste · Runde " + (rankRoom ? rankRoom.n : "");
  document.querySelector(".res-row").style.display = "none";
  $("analysis").style.display = "none";
  $("rankBack").style.display = "none";
  $("rankBox").style.display = "";
}
function renderRanking(){
  const roster = (rankRoom ? rankRoom.members : []).filter(m => m.role === "player");
  const rows = roster.map(pl => ({p: pl.p, name: pl.name, res: rankResults[pl.p] || null}))
    .sort((a, b) => (b.res ? b.res.result.pnl : -Infinity) - (a.res ? a.res.result.pnl : -Infinity));
  const done = rows.filter(r => r.res).length;
  $("resSub").textContent = (submitFail
      ? "⚠️ Dein Ergebnis wurde vom Server NICHT bestätigt (Replay-Prüfung) und zählt nicht. "
      : "") + (done >= roster.length
    ? "Alle Ergebnisse da – identischer Markt für alle." +
      (expert ? " Bewertung per Schlussauktion zum fairen Kurs." : "")
    : done + " von " + roster.length + " Ergebnissen da – der Rest erscheint automatisch …");
  const own = rankResults && room ? rankResults[room.p] : null;
  let html = "";
  rows.forEach((r, i) => {
    const pos = r.res ? (i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1) + ".") : "⏳";
    // Expert: abweichender Journal-Hash = anderes Blockorder-Journal gespielt (Sync-Problem)
    let warn = r.res && own && !r.res.self && r.res.jhash !== undefined &&
                 own.jhash !== undefined && r.res.jhash !== own.jhash
      ? ' <span title="Abweichendes Blockorder-Journal – Überlagerung war nicht identisch">⚠️</span>' : "";
    // 🤨: Server-Orakel-Check – Ergebnis verdächtig nah am theoretischen Maximum
    if(roomSus && roomSus[r.p])
      warn += ' <span title="Verdächtig nah am theoretisch möglichen Maximum">🤨</span>';
    // 🤖: Server-Timing-Heuristik – Orders passen verdächtig exakt zu kommenden News
    if(roomBot && roomBot[r.p])
      warn += ' <span title="Roboter-Timing: Einstiege vor unangekündigten News bzw. Sofort-Reaktionen">🤖</span>';
    const pnl = r.res
      ? `<span style="color:${r.res.result.pnl >= 0 ? "var(--up)" : "var(--down)"}">${sgn(r.res.result.pnl)}</span>`
      : '<span style="color:var(--muted);font-weight:400">spielt noch …</span>';
    html += `<div class="rank-row${r.res && !r.res.self ? " tap" : ""}${r.res && r.res.self ? " me" : ""}" data-rp="${r.p}">
      <span class="rank-pos">${pos}</span>
      <span class="rank-name">${esc(r.name)}${r.res && r.res.self ? " (du)" : ""}${warn}</span>
      <span class="rank-pnl">${pnl}</span></div>`;
  });
  $("rankBox").innerHTML = html;
  // Fertige Mitspieler antippen → gewohnter Zwei-Spalten-Vergleich
  $("rankBox").querySelectorAll(".rank-row.tap").forEach(row => {
    row.onclick = () => showRankDetail(+row.dataset.rp);
  });
}
function showRankDetail(p){
  const o = rankResults && rankResults[p];
  if(!o) return;
  $("rankBox").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  renderCompare(soloP, o);
  $("resTitle").textContent = "Vergleich mit " + o.name;
  $("rankBack").style.display = "";
}
$("rankBack").onclick = () => { showRankView(); renderRanking(); };

/* ===== Live-Rennen: Chips in der Topbar, gespeist aus dem Raum-Puls ===== */
function startRace(){
  stopRace();
  if(mode !== "room" || !room) return;
  $("raceRow").innerHTML = "";
  $("raceRow").style.display = "";
}
function stopRace(){
  $("raceRow").style.display = "none";
}
function renderRace(st){
  if(mode !== "room" || !room || !st || !players[round]) return;
  const roster = (st.members || []).filter(m => m.role === "player");
  if(roster.length < 2) return;
  const own = totalOf(players[round]) - START_CASH;
  const rows = roster.map(m => ({
    p: m.p, name: m.name, me: m.p === room.p,
    v: m.p === room.p ? own : (st.pnls && st.pnls[m.p] !== undefined ? st.pnls[m.p] : null),
  })).sort((a, b) => (b.v === null ? -Infinity : b.v) - (a.v === null ? -Infinity : a.v));
  let html = "";
  rows.forEach((r, i) => {
    const val = r.v === null ? "…" : sgn(r.v);
    const cls = r.v === null ? "" : (r.v >= 0 ? " up" : " down");
    html += `<span class="race-chip${r.me ? " me" : ""}">${i === 0 && r.v !== null ? "👑 " : ""}` +
            `${esc(r.name)} <b class="rc${cls}">${val}</b></span>`;
  });
  $("raceRow").innerHTML = html;
}


/* Einladung teilen: Link mit vorbefülltem Beitritts-Code (?join=…) – der Gegner
   tippt ihn an und muss nur noch seinen Namen eingeben und beitreten. */
$("lobbyShare").onclick = async function(){
  const code = String(gameCode).padStart(6, "0");
  const url = shareUrl("join", code);
  const txt = `🚀 Trading Duell – ich fordere dich heraus!\nSpiel-Code: ${code} · ${durationMin} Minuten` +
              (url ? `\nZum Beitreten antippen: ${url}` : "");
  try{
    this.textContent = (await shareOut(txt)) === "geteilt" ? "✅ Geteilt!" : "✅ Kopiert – ab damit an den Gegner!";
  }catch(e){
    if(e && e.name === "AbortError") return; // Teilen-Menü abgebrochen – kein Fehler
    window.prompt("Zum Kopieren markieren:", txt);
  }
};

$("round2Btn").onclick = () => {
  $("handover").classList.remove("show");
  startRound(1);
};

$("rematchBtn").onclick = () => {
  if(cmpFromStats){ // Vergleich kam aus der Statistik – dorthin zurück
    cmpFromStats = false;
    $("rematchBtn").textContent = "Revanche";
    $("overlay").classList.remove("show");
    renderStats();
    $("statsScreen").classList.add("show");
    window.scrollTo(0, 0);
    return;
  }
  if(mode === "room" && room){ // Raum-Runde vorbei → zurück in den Raum (nächste Runde wartet)
    $("overlay").classList.remove("show");
    $("matchScreen").classList.remove("show");
    showRoomScreen();
    return;
  }
  $("overlay").classList.remove("show");
  $("matchScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  // Code leeren, sonst würde die Revanche denselben (nun bekannten) Markt abspielen
  codeIn.value = "";
  $("codeErr").textContent = "";
  $("resCard2").style.display = "";
  document.querySelectorAll(".dur[data-m]").forEach(b => b.disabled = false);
  clearSnapshot(); // Spiel ist vorbei – kein Fortsetzen mehr anbieten
  applyStore();    // evtl. neuer Rekord / kein Snapshot → Startbildschirm auffrischen
  updateStartBtn();
  window.scrollTo(0,0);
};

function startRound(r){
  $("roomScreen").classList.remove("show");
  if(mode === "room") roomPhase = "playing";
  round = r;
  tickCount = 0; paused = false; over = false; newsPaused = false; lastNewsTick = -999;
  clearInterval(preTimer); preTimer = null; $("preStart").classList.remove("show");
  $("newsPop").classList.remove("show");
  selected = "SPCX"; qtyMode = "5";
  favorites = DEFAULT_FAVS.slice(); // Favoriten je Spiel auf Standard zurücksetzen
  document.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x.dataset.q === "5"));
  $("news").innerHTML = '<div class="empty">Gleich geht\'s los …</div>';
  $("flash").textContent = "";
  $("pauseBtn").textContent = "⏸ Pause";
  // Remote läuft strikt nach Weltzeit – keine Pause möglich; im Tutorial pausiert der Coach
  $("pauseBtn").style.display = (wallClock() || tutorial) ? "none" : "";
  $("endSandboxBtn").style.display = sandbox ? "" : "none";
  roundAnchor = wallClock() ? startAt : Date.now();
  $("roundTag").textContent = tutorial
    ? "🎓 Tutorial"
    : (mode === "solo" && sandbox)
      ? `🏖️${expert ? "🎓" : ""} Sandbox`
      : mode === "solo"
        ? "Einzelspiel"
        : mode === "room"
          ? `🌐${expert ? "🎓" : ""} Runde ${room && room.played ? room.played : 1}`
          : mode === "remote"
            ? `Code ${String(gameCode).padStart(6,"0")}`
            : `Runde ${r+1}/2`;

  const p = players[round];
  $("pillDot").style.background = p.color;
  $("pillName").textContent = p.name;
  $("depName").textContent = p.name;
  $("target").innerHTML = (mode === "local" && round === 1)
    ? `Zu schlagen: <b style="color:${players[0].result.pnl>=0?'var(--up)':'var(--down)'}">${sgn(players[0].result.pnl)}</b>`
    : "";

  buildWatch();
  renderOrders(); // Experten-Order-Bereich ein-/ausblenden (je nach expert-Flag)
  $("startScreen").classList.remove("show");
  $("matchScreen").classList.add("show");
  window.scrollTo(0,0);
  renderAll(); // Anfangszustand schon zeigen (eingefroren während des Vorlaufs)

  // Spielzeit erst nach dem Vorlauf starten
  const beginTicking = () => {
    stopTips(); // Spiel läuft – keine Wartetipps mehr
    roundAnchor = wallClock() ? startAt : Date.now();
    clearInterval(timer);
    timer = setInterval(tick, TICK_MS);
    lastTickAt = performance.now();
    startChartLoop();
    startRace(); // Live-Rennen (nur Online-Runden; sonst sofortiger No-op)
    saveSnapshot("play");
    renderAll();
  };
  // 5-Sekunden-Vorlauf nur für Solo & Local (tick-basiert). Remote ist weltzeit-
  // verankert (Lobby ist der Vorlauf) und das Tutorial startet sofort gecoacht.
  if((mode === "solo" || mode === "local") && !tutorial) runPreStart(beginTicking);
  else beginTicking();
}

/* 3-2-1-Vorlauf: zählt ~5 s herunter, dann ruft cb() den eigentlichen Start auf. */
let preTimer = null;
function runPreStart(cb){
  let n = 5;
  const num = $("preNum");
  num.textContent = n;
  $("preStart").classList.add("show");
  startTips(["preTip"]); // ein paar Tipps auch im Solo/Local-Vorlauf
  clearInterval(preTimer);
  preTimer = setInterval(() => {
    n--;
    if(n <= 0){
      clearInterval(preTimer); preTimer = null;
      num.textContent = "Los!";
      setTimeout(() => { $("preStart").classList.remove("show"); cb(); }, 450);
    }else{
      num.textContent = n;
    }
  }, 1000);
}

/* ====================== Experten-Modus: Markt-Impact (nur Online-Raum) ======================
   Blockorders (Journal vom Server, anonym) werden zu einem multiplikativen Overlay über
   dem Basismarkt: Wirkung erst REACT_TICKS nach dem Server-Stempel (Meldung vor Wirkung,
   wie News), rampt über ~5 s herein und gibt über ~60 s zwei Drittel zurück. Alles ist
   eine reine Funktion des Journals – kein rnd()-Verbrauch, identisch auf allen Geräten.
   Details/Entscheidungen: IMPACT-PLAN.md. */
/* Spieler-Seite: Effektiv-Pfade + Squeeze-Liste neu aufbauen (bei Journal-Zuwachs) */
let squeezes = [];
function rebuildEff(){
  if(!expert || mode !== "room" || !market){ effPaths = null; squeezes = []; return; }
  const res = buildEffPaths(market, journal, roundAnchor, matchTicks);
  effPaths = res.eff; squeezes = res.squeezes;
}

/* Aktuelle Schieflage fürs Stimmungsband (0 = neutral) */
function skewNow(sym){
  if(!expert || mode !== "room" || !journal.length) return 0;
  const trs = journal.filter(t => t.sym === sym);
  return trs.length ? skewAt(trs, tickCount, roundAnchor) : 0;
}

/* ====================== Experten-Modus: lokale Härten ======================
   Rein deterministisch aus Marktdaten + eigenen Aktionen – laufen deshalb in
   JEDEM Expert-Spiel identisch (Raum wie Sandbox), ohne Server-Beteiligung. */

/* Geld-/Brief-Spanne: kleine Werte haben ein dünneres Buch (÷liq); direkt nach
   einer News, die den Wert (oder den Gesamtmarkt) trifft, ist es ~30 s dreimal
   so dünn – wer in die Panik hineinhandelt, zahlt extra. */
function spreadOf(sym){
  return expert ? spreadAtTick(market, sym, tickCount) : 0;
}

/* Volatilitätsunterbrechung: nach einer Mega-Panik ist der betroffene Wert
   (bei Marktpanik: alles) ~15 s vom Handel ausgesetzt – wie echte Circuit
   Breaker. Wer den Crash nicht kommen sah, kommt nicht mehr raus. */
function haltInfo(sym){
  if(!expert) return null;
  const left = haltLeftAt(market, sym, tickCount);
  return left ? {left: Math.ceil(left * TICK_MS / 1000)} : null;
}

/* Vorgemerkte Limit-/Stop-Order ausführen (Auslöse-Prüfung macht processTick).
   Bewusst schlicht: Kauf deckt Shorts zuerst ein, Verkauf nur für Longs.
   Gibt die ausgeführte Stückzahl zurück (0 = nicht ausführbar). Blockorder-
   Regeln (Slippage + anonyme Meldung) gelten auch hier – große vorgemerkte
   Orders schleichen sich nicht am Market Impact vorbei. */
function execPending(p, o){
  if(haltInfo(o.sym)) return 0;                        // Handelsstopp gilt auch für Orders
  let px = price(o.sym);
  const px0 = px;
  const s = p.stats;
  // Blockorder? (wie in trade(): Absichtsgröße gegen die Schwelle, halber Eigen-Impact)
  let blockVol = 0;
  if(expert && mode === "room" && !isIndexSym(o.sym) && o.qty * px >= START_CASH * BLOCK_MIN_FRAC){
    blockVol = Math.min(2, Math.max(0.1, Math.round(o.qty * px / START_CASH * 10) / 10));
    const slip = IMPACT_BASE * blockVol / liqOf(o.sym) / 2;
    px = o.side === "buy" ? px * (1 + slip) : px * (1 - slip);
  }
  const spr = spreadOf(o.sym);
  let q = 0;
  if(o.side === "buy"){
    px *= 1 + spr / 2;
    const pos = p.pos[o.sym];
    const afford = Math.floor(p.cash / (px * (1 + feeRate(o.sym))));
    q = Math.min(o.qty, pos && pos.qty < 0 ? Math.min(-pos.qty, afford) : afford);
    if(q < 1) return 0;
    const cost = q * px, fee = feeOf(cost, o.sym);
    p.cash -= cost + fee; s.feesPaid += fee; s.trades++; s.buys++; s.volume += cost;
    if(pos && pos.qty < 0){
      noteClose(p, (pos.avg - px) * q, pos.avg * q, o.sym, -1);
      pos.qty += q;
      if(pos.qty === 0) delete p.pos[o.sym];
      pushNews(o.sym, `📌 Order ausgeführt: ${q} × ${o.sym} eingedeckt @ ${fmt(px)}`, "up");
    }else{
      const lp = pos || {qty:0, avg:0};
      lp.avg = (lp.avg * lp.qty + cost) / (lp.qty + q);
      lp.qty += q;
      p.pos[o.sym] = lp;
      pushNews(o.sym, `📌 Order ausgeführt: ${q} × ${o.sym} gekauft @ ${fmt(px)}`, "up");
    }
  }else{
    const pos = p.pos[o.sym];
    if(!pos || pos.qty <= 0) return 0;
    px *= 1 - spr / 2;
    q = Math.min(o.qty, pos.qty);
    const fee = feeOf(q * px, o.sym);
    p.cash += q * px - fee; s.feesPaid += fee; s.trades++; s.sells++; s.volume += q * px;
    noteClose(p, (px - pos.avg) * q, pos.avg * q, o.sym, 1);
    pos.qty -= q;
    if(pos.qty === 0) delete p.pos[o.sym];
    pushNews(o.sym, `📌 Order ausgeführt: ${q} × ${o.sym} verkauft @ ${fmt(px)}`, "down");
  }
  if(expert && px !== px0) s.slip = (s.slip || 0) + Math.abs(px - px0) * q;
  if(mode === "room"){
    tradeLog.push([tickCount, o.sym, o.side === "buy" ? "buy" : "sell", q, blockVol ? Math.round(blockVol * 10) : 0]);
    if(blockVol && room && room.played)
      api("/room/" + room.code + "/round/" + room.played + "/trade",
          {method: "POST", body: JSON.stringify({sym: o.sym, side: o.side === "buy" ? "buy" : "sell", vol: blockVol}),
           headers: {"x-token": room.token}}).catch(() => {});
  }
  return q;
}

/* Frische Blockorder in den News-Feed (anonym – wer war's?!) */
function announceBlock(tr){
  const t = Math.min(tradeTick(tr.at, roundAnchor), tickCount);
  pushNews(tr.sym, tr.side === "buy"
    ? "🐘 Blockorder: Jemand kauft im großen Stil – das dürfte den Kurs gleich anschieben …"
    : "🐘 Blockorder: Jemand wirft groß ab – da kommt gleich Druck auf den Kurs …",
    tr.side === "buy" ? "up" : "down", Math.max(0, t));
  lastNewsTick = tickCount;
}

/* ====================== Tick (spielt vorberechneten Markt ab) ====================== */
let newsPaused = false;
let lastNewsTick = -999; // für die News-Junkie-Statistik

/* price() ist DER Kurs-Zugriff des Spiels. Im Expert-Raum liefert er den Effektiv-
   kurs (Basis × Blockorder-Overlay), überall sonst exakt den Basispfad. */
function price(sym){ return (effPaths || market.paths)[sym][Math.min(tickCount, matchTicks)]; }
function basePrice(sym){ return market.paths[sym][Math.min(tickCount, matchTicks)]; }
function open_(sym){ return defOf(sym).start; }

function insiderText(t){
  return t.dir > 0
    ? `Vertrauliche Quelle: Bei ${t.sym} bahnt sich in Kürze etwas Positives an …`
    : `Vertrauliche Quelle: Bei ${t.sym} ziehen dunkle Wolken auf …`;
}

/* Aufgelaufene Dividende auszahlen: aufs Bargeld gutschreiben, in die Statistik,
   und (außerhalb des Catch-ups) als kurzer Toast sichtbar machen. */
function payDividend(p, announce){
  const paid = p.pendingDiv || 0;
  p.pendingDiv = 0;
  if(Math.abs(paid) < 0.005) return;
  // Negativ = Experten-Modus: Short-Leihgebühr / ACT-Haltekosten fließen ab
  p.cash += paid;
  p.stats.dividends = (p.stats.dividends || 0) + paid;
  if(announce) showDivToast(paid);
}
let divToastTimer = null;
function showDivToast(amt){
  const el = $("divToast");
  if(!el) return;
  el.textContent = amt >= 0
    ? "💰 +" + fmt(amt) + " $ Dividende"
    : "💸 −" + fmt(-amt) + " $ Leih-/Haltekosten";
  el.classList.remove("show"); void el.offsetWidth; // Reflow → Animation neu starten
  el.classList.add("show");
  clearTimeout(divToastTimer);
  divToastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

/* Events und Insider-Tipps des aktuellen Ticks verarbeiten.
   showPopup=false beim Catch-up nach Tab-Schlaf (kein Popup-Stau). */
function processTick(showPopup){
  for(const e of market.events){
    if(e.tick === tickCount){
      pushNews(e.ev.t, e.ev.txt, e.tag);
      lastNewsTick = tickCount;
      if(showPopup) showNewsPop(e);
    }
  }
  for(const t of market.tips){
    if(t.tick === tickCount){
      pushNews(t.sym, insiderText(t), "insider");
      lastNewsTick = tickCount;
      if(showPopup) showNewsPop({ev:{t:t.sym, txt:"🤫 " + insiderText(t)}, tag:t.dir > 0 ? "up" : "down", insider:true});
    }
  }
  // Expert-Raum: Squeeze/Blasen-Crash zündet – die Herde muss durch dieselbe Tür
  if(expert && mode === "room") for(const q of squeezes){
    if(q.hitTick === tickCount){
      const txt = q.short
        ? "🔥 SHORT SQUEEZE: Eindeckungswelle verstärkt den Kurssprung!"
        : "💥 Die Blase platzt: Alle wollen gleichzeitig raus!";
      pushNews(q.sym, txt, q.side === "buy" ? "up" : "down");
      lastNewsTick = tickCount;
      if(showPopup) showNewsPop({ev:{t:q.sym, txt}, tag:q.side === "buy" ? "up" : "down"});
    }
  }
  const p = players[round], s = p.stats;

  // Experten-Modus: Handelsstopp ankündigen, sobald die Mega-Panik zuschlägt
  if(expert) for(const e of market.events){
    if(e.mega && (e.ev.jump || 0) < 0 && e.tick + MEGA_REACT_TICKS === tickCount){
      pushNews(e.ev.t, "⛔ Volatilitätsunterbrechung: Handel für 15 Sekunden ausgesetzt!", "down");
      lastNewsTick = tickCount;
    }
  }

  // Experten-Modus: vorgemerkte Limit-/Stop-Orders prüfen und ausführen
  if(expert && p.orders && p.orders.length){
    let hit = false;
    for(let i = p.orders.length - 1; i >= 0; i--){
      const o = p.orders[i];
      const cur = price(o.sym);
      if(o.trig === "le" ? cur > o.px : cur < o.px) continue;
      if(execPending(p, o)){ p.orders.splice(i, 1); hit = true; }
      else if((o.dead = (o.dead || 0) + 1) > 30) p.orders.splice(i, 1); // dauerhaft unausführbar
    }
    if(hit){ renderOrders(); saveSnapshot("play"); }
  }

  // Dividenden: Dividenden-Aktien (und der ETF) sammeln pro Tick einen kleinen Betrag
  // an; ausgezahlt wird sichtbar gebündelt alle ~20 s. Deterministisch (kein rnd()).
  // Experten-Modus: Shorts ZAHLEN die Dividende (Leihgebühr, pos.qty < 0 → negativ),
  // und der gehebelte ACT kostet Haltegebühr – „ACT ist zum Traden, nicht zum Parken".
  for(const [sym, pos] of Object.entries(p.pos)){
    if(isDividendSym(sym) && (pos.qty > 0 || expert))
      p.pendingDiv = (p.pendingDiv || 0) + pos.qty * price(sym) * divRate(sym) * TICK_SCALE;
    if(expert && sym === ETF2_SYM && pos.qty > 0)
      p.pendingDiv = (p.pendingDiv || 0) - pos.qty * price(sym) * EXPERT_ACT_HOLD * TICK_SCALE;
  }
  if(p.pendingDiv && tickCount % DIV_PAYOUT === 0) payDividend(p, showPopup);

  // Statistik: investierte Zeit, Depot-Spitze/-Tief, max. Rücksetzer
  if(Object.keys(p.pos).length) s.investedTicks++;
  const tv = totalOf(p);
  if(tv > s.peak) s.peak = tv;
  if(tv < s.trough) s.trough = tv;
  if(s.peak - tv > s.maxDD) s.maxDD = s.peak - tv;
}

function tick(){
  if(over) return;
  lastTickAt = performance.now();

  if(wallClock()){
    /* Weltzeit-Anker: Spielzeit hängt nur an der Uhr, nie an Pausen oder
       Render-Aussetzern. Beide Geräte (gleicher startAt aus der Lobby)
       bleiben dadurch dauerhaft synchron; nach Tab-Schlaf wird aufgeholt. */
    const target = Math.min(matchTicks, Math.floor((Date.now() - roundAnchor) / TICK_MS));
    while(tickCount < target){
      tickCount++;
      processTick(tickCount === target);
    }
    if(tickCount >= matchTicks){ endRound(); return; }
    saveSnapshot("play");
    renderAll();
    return;
  }

  // Local (Pass & Play): tick-basiert, Pause und News-Popup halten an
  if(paused || newsPaused) return;
  tickCount++;
  processTick(true);
  if(tutorial) tutOnTick();

  if(!sandbox && tickCount >= matchTicks){ endRound(); return; }
  saveSnapshot("play");
  renderAll();
}

/* Breaking-News-Popup. Local: pausiert das Spiel bis zur Entscheidung.
   Remote: Spiel läuft weiter, Popup schließt nach ein paar Sekunden selbst. */
let npTimer = null;

function showNewsPop(e){
  if(!wallClock()) newsPaused = true; // solo & local: Popup pausiert; Weltzeit-Modi laufen weiter
  clearTimeout(npTimer);
  if(wallClock()) npTimer = setTimeout(closeNewsPop, e.mega ? 12000 : 6000);
  const sym = e.ev.t;
  $("npLive").textContent = e.insider ? "Insider" : e.mega ? "Mega-Event" : "Breaking";
  $("npHint").style.display = e.insider ? "none" : "";
  $("npHint").textContent = e.mega
    ? "💥 Gewaltige Kursreaktion in ~20 Sekunden – noch ist Zeit zu handeln!"
    : "⏳ Der Markt reagiert in wenigen Sekunden …";
  $("npSym").textContent = sym === "ALL" ? "MARKT" : sym;
  $("npSym").className = "np-sym " + e.tag;
  $("npCard").className = "np-card " + e.tag + (e.insider ? " insider" : "") + (e.mega ? " mega" : "");
  $("npText").textContent = e.ev.txt;
  const go = $("npGo");
  if(sym === "ALL"){
    go.style.display = "none";
    $("npSkip").textContent = "Weiter";
  }else{
    go.style.display = "";
    go.textContent = "Zu " + sym + " →";
    $("npSkip").textContent = "Ignorieren";
    go.onclick = () => {
      selected = sym;
      buildWatch();
      closeNewsPop();
    };
  }
  $("newsPop").classList.add("show");
}

function closeNewsPop(){
  clearTimeout(npTimer);
  $("newsPop").classList.remove("show");
  newsPaused = false;
  renderAll();
}

/* ====================== Handel ====================== */
/* Positionen: qty > 0 = long, qty < 0 = short (avg = mittlerer Einstiegs-
   bzw. Short-Kurs). Eine Order wechselt nie direkt von long zu short oder
   umgekehrt – erst glattstellen, dann neu eröffnen. */
function shortExposure(p){
  let v = 0;
  for(const [sym,pos] of Object.entries(p.pos)) if(pos.qty < 0) v += -pos.qty * price(sym);
  return v;
}

/* Kein Hebel: offener Short-Gegenwert maximal 1x aktueller Depotwert */
function maxShortQty(p, px){
  return Math.max(0, Math.floor((totalOf(p) - shortExposure(p)) / px));
}

function curQty(){
  const p = players[round];
  const pos = p.pos[selected];
  if(qtyMode === "max"){
    // Gebühr schon einplanen, damit "Max" nicht an Cents scheitert
    const afford = Math.floor(p.cash / (price(selected) * (1 + feeRate(selected))));
    // Bei Short-Position deckt "Max" höchstens alles ein
    return Math.max(1, pos && pos.qty < 0 ? Math.min(afford, -pos.qty) : afford);
  }
  return +qtyMode;
}

/* Statistik je Order: Anzahl, Volumen, All-ins, Trades kurz nach News/Tipps */
function noteTrade(p, value, side){
  const s = p.stats;
  s.trades++; s.volume += value;
  side === "buy" ? s.buys++ : s.sells++;
  s.perSym[selected] = (s.perSym[selected] || 0) + 1;
  if(qtyMode === "max") s.allIns++;
  if(tickCount - lastNewsTick <= Math.round(12000 / TICK_MS)) s.newsTrades++;
  // Insider-Flüsterer: Order auf die getippte Aktie, bevor das Event eintritt
  if(market.tips.some(t => t.sym === selected && tickCount >= t.tick && tickCount < t.eventTick))
    s.tipTrades++;
}

/* cost = eingesetztes Kapital des geschlossenen Teils (für die %-Rendite des Deals).
   sym/dir (nur Expert-Raum) = Wert und Positionsrichtung (+1 Long, −1 Short) des
   geschlossenen Teils: Gewinn GEGEN eine ausgeprägte Raum-Schieflage zählt als
   antizyklischer Erfolg (🎯 Gegen den Strom). Außerhalb des Expert-Raums ist
   skewNow()==0, die Prüfung also inert. */
function noteClose(p, profit, cost, sym, dir){
  p.stats.realized += profit;
  if(cost > 0) p.stats.bestPct = Math.max(p.stats.bestPct, profit / cost);
  p.stats.best  = p.stats.best  === null ? profit : Math.max(p.stats.best,  profit);
  p.stats.worst = p.stats.worst === null ? profit : Math.min(p.stats.worst, profit);
  if(profit > 0 && sym && dir){
    const sk = skewNow(sym);                          // >0 = Herde long, <0 = Herde short
    if(dir * sk < 0 && Math.abs(sk) >= SKEW_MIN)      // eigene Position der Masse entgegen
      p.stats.contra = (p.stats.contra || 0) + profit;
  }
}

function trade(side){
  if(over) return;
  const p = players[round];
  const flash = $("flash");

  // Experten-Modus: Volatilitätsunterbrechung – der Wert ist gerade nicht handelbar
  const halt = haltInfo(selected);
  if(halt){
    flash.textContent = `⛔ Handel ausgesetzt (Volatilitätsunterbrechung) – noch ${halt.left} s.`;
    flash.className = "flash err";
    return;
  }

  let px = price(selected);
  const px0 = px;
  const qty = curQty();
  const pos = p.pos[selected];
  let execQ = 0; // tatsächlich ausgeführte Stückzahl (für Slippage-Statistik/Meldung)

  /* Expert-Raum: ab Blockorder-Größe rutscht der eigene Fill in den halben eigenen
     Impact (Slippage) – Wale zahlen die Prämie, die sie erzeugen (IMPACT-PLAN.md). */
  let blockVol = 0;
  if(expert && mode === "room"){
    const est = qty * px;
    if(!isIndexSym(selected) && est >= START_CASH * BLOCK_MIN_FRAC){
      blockVol = Math.min(2, Math.max(0.1, Math.round(est / START_CASH * 10) / 10));
      const slip = IMPACT_BASE * blockVol / liqOf(selected) / 2;
      px = side === "buy" ? px * (1 + slip) : px * (1 - slip);
    }
  }

  // Experten-Modus: Geld-/Briefkurs – kaufen leicht über, verkaufen leicht unter Kurs
  const spr = spreadOf(selected);
  if(spr) px = side === "buy" ? px * (1 + spr / 2) : px * (1 - spr / 2);

  if(side === "buy"){
    if(pos && pos.qty < 0){
      // Short eindecken: zurückkaufen, Gewinn = (Short-Kurs − Kaufkurs) × Stück
      const q = Math.min(qty, -pos.qty, Math.floor(p.cash / (px * (1 + feeRate(selected)))));
      if(q < 1){ flash.textContent = "Nicht genug Bargeld zum Eindecken."; flash.className = "flash err"; return; }
      const profit = (pos.avg - px) * q;
      const fee = feeOf(q * px, selected);
      p.cash -= q * px + fee;
      p.stats.feesPaid += fee;
      pos.qty += q;
      if(pos.qty === 0) delete p.pos[selected];
      noteTrade(p, q * px, "buy");
      noteClose(p, profit, pos.avg * q, selected, -1);
      execQ = q;
      flash.textContent = `Eingedeckt: ${q} × ${selected} @ ${fmt(px)} (${sgn(profit)}) · Gebühr ${fmt(fee)}`;
      flash.className = "flash ok";
    }else{
      // "Max" mit dem (ggf. Slippage-)Kurs neu deckeln, damit die Order nicht an Cents scheitert
      const bqty = qtyMode === "max" ? Math.max(1, Math.floor(p.cash / (px * (1 + feeRate(selected))))) : qty;
      const cost = bqty * px, fee = feeOf(cost, selected);
      if(cost + fee > p.cash + 0.001){ flash.textContent = "Nicht genug Bargeld."; flash.className = "flash err"; return; }
      p.cash -= cost + fee;
      p.stats.feesPaid += fee;
      const lp = pos || {qty:0, avg:0};
      lp.avg = (lp.avg*lp.qty + cost) / (lp.qty + bqty);
      lp.qty += bqty;
      p.pos[selected] = lp;
      noteTrade(p, cost, "buy");
      execQ = bqty;
      flash.textContent = `Gekauft: ${bqty} × ${selected} @ ${fmt(px)} · Gebühr ${fmt(fee)}`;
      flash.className = "flash ok";
    }
  }else if(side === "sell"){
    // Long verkaufen – Shorts laufen über den eigenen Short-Button
    if(!pos || pos.qty <= 0){
      flash.textContent = "Nicht genug Stücke im Depot."; flash.className = "flash err"; return;
    }
    const sellQty = qtyMode === "max" ? pos.qty : Math.min(qty, pos.qty);
    const profit = (px - pos.avg) * sellQty;
    const fee = feeOf(sellQty * px, selected);
    p.cash += sellQty * px - fee;
    p.stats.feesPaid += fee;
    pos.qty -= sellQty;
    if(pos.qty === 0) delete p.pos[selected];
    noteTrade(p, sellQty * px, "sell");
    noteClose(p, profit, pos.avg * sellQty, selected, 1);
    execQ = sellQty;
    flash.textContent = `Verkauft: ${sellQty} × ${selected} @ ${fmt(px)} · Gebühr ${fmt(fee)}`;
    flash.className = "flash ok";
  }else{
    // Short eröffnen/aufstocken: Erlös kommt aufs Konto, Rückkauf-Pflicht bleibt
    if(pos && pos.qty > 0){
      flash.textContent = "Erst Long-Position verkaufen, dann shorten."; flash.className = "flash err"; return;
    }
    const cap = maxShortQty(p, px);
    const q = qtyMode === "max" ? cap : Math.min(qty, cap);
    if(q < 1){ flash.textContent = "Short-Limit erreicht (max. 1× Depotwert)."; flash.className = "flash err"; return; }
    const fee = feeOf(q * px, selected);
    p.cash += q * px - fee;
    p.stats.feesPaid += fee;
    const sp = pos || {qty:0, avg:0};
    sp.avg = (sp.avg * -sp.qty + q * px) / (-sp.qty + q);
    sp.qty -= q;
    p.pos[selected] = sp;
    noteTrade(p, q * px, "sell");
    p.stats.shorts++;
    execQ = q;
    flash.textContent = `Short: ${q} × ${selected} @ ${fmt(px)} 🐻 · Gebühr ${fmt(fee)}`;
    flash.className = "flash ok";
  }
  // Fehler-Pfade kehren oben mit return zurück – hier war die Order erfolgreich
  if(mode === "room" && execQ > 0)
    tradeLog.push([tickCount, selected, side === "buy" ? "buy" : side === "sell" ? "sell" : "short",
                   execQ, blockVol ? Math.round(blockVol * 10) : 0]);
  if(expert && execQ > 0 && px !== px0)
    p.stats.slip = (p.stats.slip || 0) + Math.abs(px - px0) * execQ; // Spread + Market Impact
  if(blockVol && execQ > 0){
    // Blockorder (anonym) an den Raum melden – fire-and-forget: ein Fehlschlag
    // (z. B. Rate-Limit) kostet nur die Markt-Spur, nie die Order selbst.
    flash.textContent += " · 🐘 Blockorder (Market Impact)";
    if(mode === "room" && room && room.played)
      api("/room/" + room.code + "/round/" + room.played + "/trade",
          {method: "POST", body: JSON.stringify({sym: selected, side: side === "buy" ? "buy" : "sell",
            vol: Math.min(2, Math.max(0.1, Math.round(execQ * px / START_CASH * 10) / 10))}),
           headers: {"x-token": room.token}}).catch(() => {});
  }
  if(tutorial) tutOnTrade(side);
  saveSnapshot("play");
  renderAll();
}

/* ===== Experten-Modus: Limit-/Stop-Orders (vormerken, processTick führt aus) =====
   Die Auslöserichtung ergibt sich aus Kurs vs. Zielkurs: Kauf unter dem Kurs =
   Limit (den Rücksetzer abfischen), Kauf darüber = Stop (Ausbruch/Short-Deckel);
   Verkauf über dem Kurs = Take-Profit, darunter = Stop-Loss. */
function placeOrder(side){
  if(!expert || over) return;
  const p = players[round];
  const flash = $("flash");
  const pxIn = parseFloat(($("ordPx").value || "").replace(",", "."));
  if(!isFinite(pxIn) || pxIn <= 0){
    flash.textContent = "Bitte einen Zielkurs für die Order eingeben.";
    flash.className = "flash err"; return;
  }
  p.orders = p.orders || [];
  if(p.orders.length >= EXPERT_MAX_ORDERS){
    flash.textContent = `Maximal ${EXPERT_MAX_ORDERS} offene Orders.`;
    flash.className = "flash err"; return;
  }
  const cur = price(selected);
  const q = qtyMode === "max"
    ? (side === "buy"
        ? Math.floor(p.cash / (pxIn * (1 + feeRate(selected))))
        : Math.max(0, p.pos[selected] ? p.pos[selected].qty : 0))
    : +qtyMode;
  if(q < 1){
    flash.textContent = side === "buy" ? "Dafür reicht das Bargeld nicht." : "Keine Stücke im Depot.";
    flash.className = "flash err"; return;
  }
  const trig = side === "buy" ? (pxIn < cur ? "le" : "ge") : (pxIn > cur ? "ge" : "le");
  p.orders.push({sym: selected, side, px: Math.round(pxIn * 100) / 100, qty: q, trig});
  $("ordPx").value = "";
  const kind = side === "buy" ? (trig === "le" ? "Limit-Kauf" : "Stop-Kauf")
                              : (trig === "ge" ? "Take-Profit" : "Stop-Loss");
  flash.textContent = `📌 ${kind}: ${q} × ${selected} ${trig === "le" ? "≤" : "≥"} ${fmt(pxIn)}`;
  flash.className = "flash ok";
  renderOrders();
  saveSnapshot("play");
}

function renderOrders(){
  const box = $("expertOrders");
  if(!box) return;
  const p = players && players[round];
  box.style.display = expert && p ? "" : "none";
  if(!expert || !p) return;
  const list = p.orders || [];
  $("ordList").innerHTML = list.length
    ? list.map((o, i) =>
        `<div class="ord-row"><span>${o.side === "buy" ? "🟢" : "🔴"} ${o.qty} × ${o.sym} ` +
        `${o.trig === "le" ? "≤" : "≥"} ${fmt(o.px)}</span><button class="ord-x" data-i="${i}">✕</button></div>`).join("")
    : "";
  $("ordList").querySelectorAll(".ord-x").forEach(b => b.onclick = () => {
    players[round].orders.splice(+b.dataset.i, 1);
    renderOrders();
    saveSnapshot("play");
  });
}

/* Schlussauktion (Expert-Raum): Endbewertung zum fairen BASIS-Kurs, damit sich
   niemand per Last-Second-Blockorder das eigene Depot hochbewerten kann. */
function settleTotal(p){
  let v = p.cash;
  for(const [sym,pos] of Object.entries(p.pos)) v += pos.qty * basePrice(sym);
  return v;
}

function totalOf(p){
  let v = p.cash;
  for(const [sym,pos] of Object.entries(p.pos)) v += pos.qty * price(sym);
  return v;
}

/* ====================== Rendering ====================== */
function buildWatch(){
  const el = $("watch");
  el.innerHTML = "";
  // Horizontale Leiste mit ALLEN Werten: Favoriten (per Stern) zuerst, dann der Rest.
  const order = [...favorites, ...DISPLAY_SYMS.filter(s => !favorites.includes(s))];
  for(const sym of order){
    const b = document.createElement("button");
    b.className = "w-card" + (sym === selected ? " active" : "");
    b.id = "w-" + sym;
    const favStar = favorites.includes(sym) ? `<span class="w-fav">★</span>` : "";
    b.innerHTML = `${favStar}<div class="w-sym">${sym}</div><div class="w-chg"></div>`;
    b.onclick = () => { selected = sym; buildWatch(); renderAll(); };
    el.appendChild(b);
  }
  // aktive Karte horizontal in den sichtbaren Bereich holen
  const a = $("w-" + selected);
  if(a && a.scrollIntoView) a.scrollIntoView({inline:"center", block:"nearest"});
}

/* ====================== Aktien-Auswahl (Overlay) ====================== */
function openStockModal(){
  buildStockList();
  $("stockModal").classList.add("show");
}
function closeStockModal(){
  $("stockModal").classList.remove("show");
}
/* Stern umschalten: Favorit entfernen (min. 1 bleibt) bzw. hinzufügen (max. 4) */
function toggleFav(sym){
  const i = favorites.indexOf(sym);
  if(i >= 0){
    if(favorites.length > 1) favorites.splice(i, 1);
  }else if(favorites.length < 4){
    favorites.push(sym);
  }else{
    return; // voll – erst einen abwählen
  }
  buildWatch();
  buildStockList();
  renderAll();
  if(tutorial) tutOnFav();
}
function buildStockList(){
  const el = $("stockList");
  if(!el) return;
  const full = favorites.length >= 4;
  let html = "";
  for(const sym of DISPLAY_SYMS){
    const d = defOf(sym);
    const ch = (price(sym)/open_(sym) - 1) * 100;
    const isFav = favorites.includes(sym);
    const starDis = !isFav && full;        // Stern deaktiviert, wenn 4 voll und kein Favorit
    html += `<div class="stock-row${sym === selected ? " sel" : ""}" data-sym="${sym}">
      <button class="fav-star${isFav ? " on" : ""}${starDis ? " dis" : ""}" data-fav="${sym}"
              title="${isFav ? "Favorit entfernen" : starDis ? "Erst einen Favoriten abwählen" : "Zu Favoriten"}">${isFav ? "★" : "☆"}</button>
      <div class="sr-main">
        <div class="sr-top"><span class="sr-sym">${sym}</span><span class="sr-name">${d.name}</span></div>
        <div class="sr-char">${d.char}</div>
      </div>
      <div class="sr-px">
        <div class="sr-price">${fmt(price(sym))}</div>
        <div class="sr-chg" style="color:${ch >= 0 ? "var(--up)" : "var(--down)"}">${ch>=0?"+":""}${ch.toFixed(2)}%</div>
      </div>
    </div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".stock-row").forEach(row => {
    row.onclick = () => { selected = row.dataset.sym; closeStockModal(); buildWatch(); renderAll(); };
  });
  el.querySelectorAll(".fav-star").forEach(star => {
    star.onclick = e => { e.stopPropagation(); toggleFav(star.dataset.fav); };
  });
}
$("openStocks").onclick = openStockModal;
$("closeStocks").onclick = closeStockModal;
$("stockModal").onclick = e => { if(e.target === $("stockModal")) closeStockModal(); };

/* Merkt sich, für welchen Wert der aktuell im Zielkurs-Feld stehende Text gedacht
   war – wechselt der Spieler die Aktie, wird ein stehengebliebener Zielkurs
   verworfen (sonst legte ein „Kauf/Verkauf bei" ihn auf den falschen Wert). */
let ordPxSym = null;
function renderAll(){
  const cd = $("countdown");
  if(sandbox){
    const elapsed = Math.round(tickCount * TICK_MS / 1000);
    cd.textContent = String(Math.floor(elapsed/60)).padStart(2,"0") + ":" + String(elapsed%60).padStart(2,"0");
    cd.classList.remove("hot");
  }else{
    const remain = Math.max(0, Math.round((matchTicks - tickCount) * TICK_MS / 1000));
    cd.textContent = String(Math.floor(remain/60)).padStart(2,"0") + ":" + String(remain%60).padStart(2,"0");
    cd.classList.toggle("hot", remain <= 60);
  }

  const p = players[round];
  const tv = totalOf(p);
  const livePnl = tv - START_CASH;
  const pill = $("pillPnl");
  pill.textContent = sgn(livePnl);
  pill.style.color = livePnl >= 0 ? "var(--up)" : "var(--down)";

  // Tape
  let tape = "";
  for(const sym of DISPLAY_SYMS){
    const px = price(sym), op = open_(sym);
    const ch = (px/op - 1) * 100;
    const cls = ch >= 0 ? "t-up" : "t-down";
    tape += `<span><span class="t-sym">${sym}</span> ${fmt(px)} <span class="${cls}">${ch>=0?"+":""}${ch.toFixed(2)}%</span></span>`;
  }
  $("tape").innerHTML = tape + tape;

  // Watchlist
  for(const sym of DISPLAY_SYMS){
    const card = $("w-" + sym);
    if(!card) continue;
    const ch = (price(sym)/open_(sym) - 1) * 100;
    const d = card.querySelector(".w-chg");
    d.textContent = (ch>=0?"+":"") + ch.toFixed(2) + "%";
    d.style.color = ch >= 0 ? "var(--up)" : "var(--down)";
  }

  // Offenes Aktien-Overlay mitticken lassen
  if($("stockModal").classList.contains("show")) buildStockList();

  // Kurs
  const px = price(selected), op = open_(selected);
  const ch = (px/op - 1) * 100;
  $("qPx").textContent = fmt(px);
  const chg = $("qChg");
  chg.textContent = (ch>=0?"+":"") + ch.toFixed(2) + "%";
  chg.className = "chg " + (ch >= 0 ? "up" : "down");

  // Stimmungsband (nur Expert-Raum): wo steht die Herde in diesem Wert?
  const senti = $("senti");
  if(senti){
    const sk = skewNow(selected);
    if(Math.abs(sk) < 0.1){ senti.style.display = "none"; }
    else{
      const n = Math.min(4, Math.ceil(Math.abs(sk) * 4));
      senti.style.display = "";
      senti.innerHTML = sk > 0
        ? `Raum-Stimmung: <b class="s-long">${"🐂".repeat(n)} long</b>` +
          (sk >= SKEW_MIN ? ' <span class="s-warn">– anfällig für schlechte News!</span>' : "")
        : `Raum-Stimmung: <b class="s-short">${"🐻".repeat(n)} short</b>` +
          (-sk >= SKEW_MIN ? ' <span class="s-warn">– Squeeze-Gefahr bei guten News!</span>' : "");
    }
  }

  // Order-Panel (Expert): Zielkurs-Eingabe eindeutig an den GEWÄHLTEN Wert binden.
  // Buttons/Placeholder tragen das Symbol; ein getippter Zielkurs wird beim
  // Aktienwechsel verworfen, damit „Kauf/Verkauf bei" nie auf dem falschen Wert landet.
  if(expert){
    const bb = $("ordBuyBtn"), sb = $("ordSellBtn"), opx = $("ordPx");
    if(bb) bb.textContent = "📌 Kauf " + selected;
    if(sb) sb.textContent = "📌 Verkauf " + selected;
    if(opx){
      opx.placeholder = "Zielkurs " + selected;
      if(ordPxSym !== selected){ opx.value = ""; ordPxSym = selected; }
    }
  }

  // %-Entwicklung zum eigenen Einstand (Vorzeichen bei Short gedreht: fallender Kurs = Gewinn)
  const myPos = p.pos[selected];
  const ek = $("qEk");
  if(myPos){
    const dir = myPos.qty < 0 ? -1 : 1;
    const ekCh = (px/myPos.avg - 1) * 100 * dir;
    ek.textContent = (myPos.qty < 0 ? "Short " : "EK ") + (ekCh>=0?"+":"") + ekCh.toFixed(2) + "%";
    ek.className = "chg ek " + (ekCh >= 0 ? "up" : "down");
    ek.style.display = "";
  }else{
    ek.style.display = "none";
  }

  // Renditebadge: Brutto-Dividende übers ganze Spiel, wenn man den Wert durchhält (0 → kein Badge)
  const dy = divRate(selected) * TICK_SCALE * matchTicks * 100;
  const divBadge = dy >= 0.05
    ? ` · <span class="div-yield" title="Brutto-Dividende, wenn du den ganzen Lauf hältst">💰 ~${dy.toLocaleString("de-DE", {maximumFractionDigits:1})} % Div./Lauf</span>`
    : "";
  $("qName").innerHTML = `${defOf(selected).name} · Eröffnung ${fmt(op)}<br><span class="char-line">${defOf(selected).char}${divBadge}</span>`;
  $("tradeSym").textContent = selected;

  // Order: Kaufen deckt bei Short-Position ein, Verkaufen nur für Longs,
  // Short hat seinen eigenen Button
  const qty = curQty();
  const held = p.pos[selected]?.qty || 0;
  const isShort = held < 0;
  const cap = maxShortQty(p, px);
  $("buyBtn").textContent = isShort ? "Eindecken" : "Kaufen";
  if(isShort){
    $("orderInfo").textContent = `Short: ${-held} Stk · Eindecken: ${qty} ≈ ${fmt(qty*px)}`;
  }else if(held > 0){
    $("orderInfo").textContent = qtyMode === "max"
      ? `Max: Kauf ${qty} Stück ≈ ${fmt(qty*px)} · Verkauf: alle ${held}`
      : `${qty} Stück ≈ ${fmt(qty*px)} · im Depot: ${held}`;
  }else{
    $("orderInfo").textContent = `${qty} Stück ≈ ${fmt(qty*px)} · Short möglich: ${cap} Stk`;
  }
  // Experten-Modus: Volatilitätsunterbrechung sperrt den Handel im betroffenen Wert
  const halted = haltInfo(selected);
  $("orderInfo").innerHTML = halted
    ? `<span style="color:var(--down);font-weight:700">⛔ Handel ausgesetzt – noch ${halted.left} s (Volatilitätsunterbrechung)</span>`
    : $("orderInfo").textContent;
  $("buyBtn").disabled = over || !!halted || (isShort ? p.cash < px : qty*px > p.cash + 0.001);
  $("sellBtn").disabled = over || !!halted || held <= 0;
  $("shortBtn").disabled = over || !!halted || held > 0 || cap < 1;

  // Depot
  $("cash").textContent = fmt(p.cash);
  $("total").textContent = fmt(tv);
  const pnlEl = $("pnl");
  pnlEl.textContent = sgn(livePnl);
  pnlEl.style.color = livePnl >= 0 ? "var(--up)" : "var(--down)";

  // Dividenden-Zeile: zeigt, wohin die Dividende fließt (aufs Bargeld) – Gesamtsumme.
  // Die "läuft auf"-Zeile wird IMMER gerendert (auch bei 0), damit die Box nicht bei jeder
  // Auszahlung zwischen ein/zwei Zeilen springt – konstante Höhe.
  const divEl = $("divLine");
  const divTot = (p.stats.dividends || 0) + (p.pendingDiv || 0);
  if(divTot >= 0.005){
    divEl.innerHTML = `💰 Dividende kassiert: <b>+${fmt(p.stats.dividends || 0)}</b>` +
      `<span class="div-pending">(+${fmt(p.pendingDiv || 0)} läuft auf)</span>`;
    divEl.style.display = "";
  }else if(divTot <= -0.005){
    // Experten-Modus: Short-Leihgebühr/ACT-Haltekosten überwiegen – Abfluss zeigen
    divEl.innerHTML = `💸 Leih-/Haltekosten gezahlt: <b style="color:var(--down)">−${fmt(-divTot)}</b>`;
    divEl.style.display = "";
  }else{
    divEl.style.display = "none";
  }

  const wrap = $("posWrap");
  const syms = Object.keys(p.pos);
  if(syms.length === 0){
    wrap.innerHTML = '<div class="empty">Keine offenen Positionen.</div>';
  }else{
    let rows = "";
    for(const sym of syms){
      const pos = p.pos[sym];
      const cur = price(sym);
      const ppnl = ((cur - pos.avg) * pos.qty) || 0; // "|| 0" fängt das negative Null-Artefakt ab
      const ppct = ((cur/pos.avg - 1) * 100 * (pos.qty < 0 ? -1 : 1)) || 0;
      const c = ppnl >= 0 ? "var(--up)" : "var(--down)";
      const tag = pos.qty < 0 ? ' <span style="color:var(--down);font-size:9px;font-weight:700">SHORT</span>'
                : (pos.qty > 0 && isDividendSym(sym)) ? ' <span title="zahlt Dividende">💰</span>' : "";
      rows += `<tr><td>${sym}${tag}</td><td>${pos.qty}</td><td>${fmt(pos.avg)}</td>
               <td style="color:${c}">${ppnl>=0?"+":""}${fmt(ppnl)}</td>
               <td style="color:${c}">${ppct>=0?"+":""}${ppct.toFixed(2)}%</td></tr>`;
    }
    wrap.innerHTML = `<table><thead><tr><th>Wert</th><th>Stk.</th><th>EK</th><th>+/−</th><th>% z. EK</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  drawChart();
}

/* rAF-Loop für flüssige Chart-Animation (60 fps, interpoliert letzten Punkt) */
function startChartLoop(){
  if(chartRaf) return;
  (function loop(){ drawChart(); chartRaf = requestAnimationFrame(loop); })();
}
function stopChartLoop(){
  if(chartRaf){ cancelAnimationFrame(chartRaf); chartRaf = null; }
}

/* "Schöne" Schrittweite für Gitterlinien (1-2-5-Raster) */
function niceStep(range, targetLines){
  const raw = range / targetLines;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for(const m of [1, 2, 2.5, 5, 10]){
    if(raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/* Zeichnet den Kurschart. Ohne Argumente = der Spieler-Chart (globale Zustände).
   Mit opts wiederverwendbar für die Leinwand: eigenes Canvas/Markt/Tick/Symbol/
   Maske/Animationsfortschritt und (o.big) größere Schrift fürs Großbild.
   Rein zeichnend – konsumiert kein rnd(), fairness-neutral. */
function drawChart(o){
  o = o || {};
  const cv = o.canvas || $("chart");
  if(!cv.clientWidth) return;
  const sym  = o.sym || selected;
  const mkt  = o.market || (effPaths ? {paths: effPaths} : market); // Expert-Raum: Effektivkurse
  const tc   = o.tick != null ? o.tick : tickCount;
  const pos  = ("pos" in o) ? o.pos : (players[round] ? players[round].pos[sym] : null);
  const cmode = o.chartMode || chartMode;
  const S    = o.big ? 1.55 : 1;            // Skalierung für die Leinwand (Beamer/TV)
  const FS   = Math.max(9, Math.round(10*S));
  const FSB  = "bold " + FS + "px ui-monospace,monospace";
  const FSN  = FS + "px ui-monospace,monospace";
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || 190; // Höhe folgt dem CSS (Breitbild höher)
  cv.width = w*dpr; cv.height = h*dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,w,h);

  const op = open_(sym);
  const path = mkt.paths[sym];

  const L = Math.round(8*S), R = Math.round(46*S), T = Math.round(8*S), B = Math.round(22*S); // Innenabstände

  /* Glatte Animation: der aktuell entstehende Punkt/die offene Kerze wächst
     innerhalb des Tick-Intervalls herein (0..1). o.prog erlaubt der Leinwand
     eine eigene, weltzeit-basierte Interpolation. */
  let prog = 1;
  if(o.prog != null) prog = Math.max(0, Math.min(1, o.prog));
  else if(lastTickAt && tc >= 1 && !paused && !newsPaused && !over)
    prog = Math.min(1, (performance.now() - lastTickAt) / TICK_MS);

  /* Rollierendes Fenster: nur die letzten ~3 Minuten zeigen, Anfang abschneiden */
  const WINDOW = Math.round(180000 / TICK_MS);
  const startIdx = Math.max(0, tc + 1 - WINDOW);
  const data = path.slice(startIdx, tc + 1);
  const nPts = data.length;
  const livePrice = nPts >= 2 ? data[nPts-2] + (data[nPts-1] - data[nPts-2]) * prog : (data[0] || op);

  /* Animierter Kopf: deckt sich mit der livePrice-Interpolation und sitzt im
     Linien-Modus immer am rechten Rand. */
  const headTick = (tc - 1) + prog;
  const CT = Math.max(2, Math.round(10000 / TICK_MS)); // Ticks pro Kerze
  const lastC = Math.floor(tc / CT);

  /* --- Kerzen aggregieren (~10 s pro Kerze), wenn der Kerzen-Modus aktiv ist.
         Die letzte (offene) Kerze nutzt den animierten Live-Kurs als Schluss. --- */
  let candles = null, visStartTick = startIdx, firstC = 0;
  if(cmode === "candle"){
    candles = [];
    const firstVisC = Math.max(0, lastC - Math.ceil(WINDOW / CT) + 1);
    firstC = Math.max(0, firstVisC - 1);   // eine Kerze mehr links → scrollt geclippt sauber raus
    visStartTick = firstVisC * CT;
    for(let c = firstC; c <= lastC; c++){
      const a = c*CT, b = Math.min(c*CT + CT - 1, tc);
      let hi = path[a], lo = path[a];
      for(let i=a;i<=b;i++){ if(path[i]>hi)hi=path[i]; if(path[i]<lo)lo=path[i]; }
      const live = c === lastC;
      const cl = live ? livePrice : path[b];
      if(live){ if(cl>hi)hi=cl; if(cl<lo)lo=cl; }
      candles.push({o: path[a], hi, lo, cl, live});
    }
  }

  /* --- Skalierung: im Kerzen-Modus über Dochte (High/Low) --- */
  let min, max;
  if(candles){
    min = Infinity; max = -Infinity;
    for(const k of candles){ if(k.lo<min)min=k.lo; if(k.hi>max)max=k.hi; }
  }else{
    min = Math.min(...data); max = Math.max(...data);
  }
  if(op >= min - (max-min)*0.3 && op <= max + (max-min)*0.3){ min = Math.min(min, op); max = Math.max(max, op); }
  if(pos){ min = Math.min(min, pos.avg); max = Math.max(max, pos.avg); }
  const pad = (max-min)*0.14 || 1;
  min -= pad; max += pad;

  /* Tick → X: konstante Breite pro Tick, rechtsbündig am Kopf ausgerichtet.
     So scrollt die Kurve gleichmäßig nach links, statt bei jedem neuen Punkt
     zu „atmen" (denn ein fester Fensterausschnitt = feste px/Tick). Im
     Kerzen-Modus liegt der „Kopf" an der rechten Slot-Grenze der offenen Kerze
     (= Tick (lastC+1)*CT), damit die Kerze ganz im Chart liegt und nicht am
     rechten Rand abgeschnitten wird. */
  const pxPerTick = (w-L-R) / (WINDOW - 1);
  const headX = candles ? (lastC + 1) * CT : headTick;
  const xt = t => (w-R) - (headX - t) * pxPerTick;
  const X = i => xt(startIdx + i);
  const Y = v => h - B - (h-T-B) * ((v-min)/(max-min));

  ctx.font = FSN;

  /* --- Horizontale Gitterlinien (Preis) --- */
  const step = niceStep(max-min, 4);
  ctx.strokeStyle = "#19233E"; ctx.lineWidth = 1;
  ctx.fillStyle = "#5F6C8C";
  for(let v = Math.ceil(min/step)*step; v <= max; v += step){
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w-R, y); ctx.stroke();
    ctx.fillText(v.toFixed(step < 1 ? 2 : step < 10 ? 1 : 0), w-R+5, y+3);
  }

  /* --- Vertikale Gitterlinien (Zeit, mm:ss) – an Tick-Positionen gebunden,
         damit sie mit der Kurve mitscrollen statt zu springen. --- */
  if(tc - visStartTick > 10){
    const tSteps = 4;
    for(let k = 1; k < tSteps; k++){
      const tk = visStartTick + (tc - visStartTick) * k/tSteps;
      const x = xt(tk);
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h-B); ctx.stroke();
      const sec = Math.round(tk * TICK_MS / 1000);
      const lbl = String(Math.floor(sec/60)).padStart(2,"0") + ":" + String(sec%60).padStart(2,"0");
      ctx.fillText(lbl, x - 13*S, h-7*S);
    }
  }

  /* --- Eröffnungslinie (nur wenn im sichtbaren Bereich) --- */
  if(op >= min && op <= max){
    ctx.strokeStyle = "#3A4769"; ctx.setLineDash([4,4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, Y(op)); ctx.lineTo(w-R, Y(op)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#7E8BA8";
    ctx.fillText("IPO " + op.toFixed(2), L+4, Y(op)-4);
  }

  /* --- Kursverlauf: Farbe relativ zum Einstand, wenn man Stücke hält
         (bei Short ist unter dem Einstand gut → Logik gedreht) --- */
  const ref = pos ? pos.avg : op;
  const up = pos && pos.qty < 0 ? livePrice <= ref : livePrice >= ref;
  const col = up ? "#3DDC97" : "#FF5C72";
  /* X-Position des animierten letzten Punktes (Linien-Modus: am rechten Rand) */
  const liveX = xt(headTick);
  const liveY = Y(livePrice);

  /* Plotbereich clippen: alte Punkte/Kerzen scrollen sauber unter dem linken
     Rand heraus, statt am Fensterrand zu „springen" (ein Extra-Punkt links
     wird gezeichnet und hier abgeschnitten). */
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, w-L-R, h-T-B); ctx.clip();

  if(candles){
    /* --- Kerzen --- */
    const NC = candles.length;
    const slot = pxPerTick * CT;                 // feste Kerzenbreite (kein „Atmen")
    const cw = Math.max(2, Math.min(slot*0.62, 13*S));
    for(let i=0;i<NC;i++){
      const k = candles[i];
      const cx = xt((firstC + i) * CT + (CT-1)/2); // Kerzen-Mitte über die Tick-Achse
      const kUp = k.cl >= k.o;
      const kCol = kUp ? "#3DDC97" : "#FF5C72";
      ctx.strokeStyle = kCol; ctx.fillStyle = kCol; ctx.lineWidth = 1;
      /* Docht (High–Low) */
      ctx.beginPath(); ctx.moveTo(cx, Y(k.hi)); ctx.lineTo(cx, Y(k.lo)); ctx.stroke();
      /* Körper (Open–Close); offene Kerze leicht transparent */
      const yo = Y(k.o), yc = Y(k.cl);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.globalAlpha = k.live ? 0.65 : 1;
      ctx.fillRect(cx - cw/2, top, cw, bh);
      ctx.globalAlpha = 1;
    }
  }else{
    /* --- Linie --- */
    const startI = startIdx > 0 ? -1 : 0; // Extra-Punkt links für nahtloses Rausscrollen
    ctx.beginPath();
    for(let i=startI;i<nPts;i++){
      const px = i < nPts-1 ? X(i) : liveX;
      const py = i < nPts-1 ? Y(i < 0 ? path[startIdx-1] : data[i]) : liveY;
      i===startI ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.8*S;
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();

    /* Fläche unter der Kurve */
    ctx.lineTo(liveX, h-B); ctx.lineTo(X(startI), h-B); ctx.closePath();
    const g = ctx.createLinearGradient(0,T,0,h-B);
    g.addColorStop(0, up ? "rgba(61,220,151,.16)" : "rgba(255,92,114,.16)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fill();
  }
  ctx.restore();

  /* --- Einstandslinie des aktiven Spielers --- */
  if(pos){
    const pCol = round === 0 ? "#FFB454" : "#5EC8F8";
    ctx.strokeStyle = pCol; ctx.setLineDash([7,4]); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(L, Y(pos.avg)); ctx.lineTo(w-R, Y(pos.avg)); ctx.stroke();
    ctx.setLineDash([]);
    const label = "Einstand " + pos.avg.toFixed(2);
    ctx.font = FSB;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(11,16,32,.88)";
    ctx.fillRect(w-R-tw-12, Y(pos.avg)-15*S, tw+8, 13*S);
    ctx.fillStyle = pCol;
    ctx.fillText(label, w-R-tw-8, Y(pos.avg)-5*S);
    ctx.font = FSN;
  }

  /* --- Letzter Kurs: Punkt (nur Linie) folgt der Animation, Preis-Tag am rechten Rand --- */
  if(!candles){ ctx.beginPath(); ctx.arc(liveX,liveY,3.2*S,0,7); ctx.fillStyle = col; ctx.fill(); }
  ctx.fillStyle = col;
  ctx.fillRect(w-R+2, liveY-7*S, R-4, 14*S);
  ctx.fillStyle = "#0B1020";
  ctx.font = FSB;
  ctx.fillText(livePrice.toFixed(2), w-R+6, liveY+3*S);
  ctx.font = FSN;
}

/* ====================== News-Feed ====================== */
function pushNews(sym, text, tag, atTick){
  const elapsed = Math.round((atTick === undefined ? tickCount : atTick) * TICK_MS / 1000);
  const t = String(Math.floor(elapsed/60)).padStart(2,"0") + ":" + String(elapsed%60).padStart(2,"0");
  const el = $("news");
  if(el.querySelector(".empty")) el.innerHTML = "";
  const div = document.createElement("div");
  div.className = "news-item";
  div.innerHTML = `<span class="news-time">${t}</span>
                   <span class="news-tag ${tag}">${sym === "ALL" ? "MARKT" : sym}</span>
                   <span class="news-text">${text}</span>`;
  el.prepend(div);
  while(el.children.length > 12) el.removeChild(el.lastChild);
}

/* Beim Fortsetzen: alle bis zur aktuellen Tick-Position bereits gelaufenen
   Meldungen still (ohne Popup) in chronologischer Reihenfolge nachzeichnen. */
function replayNewsUpTo(tc){
  const items = [];
  for(const e of market.events) if(e.tick <= tc) items.push({tick:e.tick, sym:e.ev.t, txt:e.ev.txt, tag:e.tag});
  for(const t of market.tips)   if(t.tick <= tc) items.push({tick:t.tick, sym:t.sym, txt:insiderText(t), tag:"insider"});
  items.sort((a,b) => a.tick - b.tick);
  for(const it of items) pushNews(it.sym, it.txt, it.tag, it.tick);
}

/* ====================== Runden-/Match-Ende ====================== */
function endRound(){
  over = true;
  clearInterval(timer);
  stopChartLoop();
  stopRace();
  if(mode === "room") roomPhase = "idle";
  if(sandbox) matchTicks = tickCount; else tickCount = matchTicks;
  const p = players[round];
  payDividend(p, false); // letzte aufgelaufene Dividende noch auszahlen
  renderAll();
  // Expert-Raum: Schlussauktion zum fairen Basiskurs (siehe settleTotal)
  const tot = (expert && mode === "room") ? settleTotal(p) : totalOf(p);
  p.result = {total: tot, pnl: tot - START_CASH};

  // Tutorial: kein Duell-Ergebnis, der Coach übernimmt den Abschluss
  if(tutorial){
    tutFinish(p);
    return;
  }

  // Rekord + Historie fortschreiben; der Rekord bleibt Expert-Runden fern
  // (anderes Kapital/Regeln → nicht vergleichbar), die Historie nicht.
  if(!sandbox){ if(!expert) updateRecord(p); appendGameHistory(p); }

  // Eine Runde, eigenes Ergebnis: Einzelspieler oder jedes Remote-Gerät
  if(mode === "solo" || wallClock()){
    showResultSolo(p);
    return;
  }

  if(round === 0){
    showHandover(p);
    saveSnapshot("handover"); // Übergabe ist fortsetzbar, falls Spieler 2 neu lädt
  }else{
    showResult();
  }
}

/* Übergabe-Overlay nach Runde 1 (lokal) – auch beim Fortsetzen genutzt */
function showHandover(p){
  $("hoTitle").textContent = players[0].name + " ist fertig";
  const ho = $("hoPnl");
  ho.textContent = sgn(p.result.pnl);
  ho.style.color = p.result.pnl >= 0 ? "var(--up)" : "var(--down)";
  $("hoBadge").textContent = playerTitle(p);
  $("hoBadges").innerHTML = badgesHtml(playerBadges(p));
  $("hoStats").innerHTML = statsLine(p);
  $("hoSub").innerHTML = `Handy weitergeben an <b style="color:var(--p2)">${esc(players[1].name)}</b>.<br>
    Gleicher Markt, gleiche News – gleiche Chancen.`;
  $("hoCode").textContent = gameCode;
  $("handover").classList.add("show");
}

/* ====================== Auszeichnungen ====================== */
/* Eine Liste, zwei Verwendungen: der erste Treffer ist der Haupttitel,
   weitere Treffer werden als kleine Badges darunter gezeigt – so haben auch
   Verlierer fast immer etwas vorzuzeigen. tOnly-Einträge sind reine
   Titel-Fallbacks und tauchen nie als Badge auf. */


function awardCtx(p){
  return {pnl: p.result.pnl, inv: p.stats.investedTicks / matchTicks, bh: buyHoldPnl()};
}

function playerTitle(p){
  const x = awardCtx(p);
  return AWARDS.find(a => a.c(p.stats, x)).n;
}

/* Bis zu drei Badges unterhalb des Titels; extra (z. B. "👑 Börsenkönig"
   für den Duell-Sieger) belegt den ersten Platz. */
function playerBadges(p, extra){
  const x = awardCtx(p);
  const title = playerTitle(p);
  const out = extra ? [extra] : [];
  for(const a of AWARDS){
    if(out.length >= 3) break;
    if(!a.tOnly && a.n !== title && a.c(p.stats, x)) out.push(a.n);
  }
  return out;
}

const badgesHtml = list => list.map(b => `<span class="badge">${b}</span>`).join("");

function statsLine(p){
  const s = p.stats;
  let out = `${s.trades} Trades · Spitze ${fmt(s.peak)}`;
  if(s.best !== null) out += `<br>Bester Deal ${sgn(s.best)} · Schwächster ${sgn(s.worst)}`;
  return out;
}

/* ====================== Analyse (ausführliche Endauswertung) ====================== */
/* Benchmark: Was hätte stures Kaufen-und-Halten von SPCX gebracht? */
function buyHoldPnl(){
  const px0 = STOCK_DEFS.SPCX.start;
  const qty = Math.floor(START_CASH / px0);
  return (START_CASH - qty*px0) + qty * market.paths.SPCX[matchTicks] - START_CASH;
}

function favSym(p){
  if(p.stats._fav) return p.stats._fav; // entpacktes Gegner-Ergebnis liefert den String direkt
  const e = Object.entries(p.stats.perSym).sort((a,b) => b[1] - a[1]);
  return e.length ? `${e[0][0]} (${e[0][1]}×)` : "–";
}

const pctf = x => (x >= 0 ? "+" : "") + (x*100).toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2}) + " %";

function buildAnalysis(list){
  const bh = buyHoldPnl();
  const col = v => v >= 0 ? "var(--up)" : "var(--down)";
  const rows = [
    ["Rendite",            p => `<span style="color:${col(p.result.pnl)}">${pctf(p.result.pnl/START_CASH)}</span>`],
    ["Käufe / Verkäufe",   p => `${p.stats.buys} / ${p.stats.sells}`],
    ["Short-Orders",       p => p.stats.shorts],
    ["Handelsvolumen",     p => fmt(p.stats.volume)],
    ["Gebühren gezahlt",   p => (p.stats.feesPaid||0) < 0.005 ? "–" : `<span style="color:var(--down)">−${fmt(p.stats.feesPaid)}</span>`],
    ["Dividenden",         p => Math.abs(p.stats.dividends||0) < 0.005 ? "–"
                             : (p.stats.dividends > 0 ? `<span style="color:var(--up)">+${fmt(p.stats.dividends)}</span>`
                                                      : `<span style="color:var(--down)">−${fmt(-p.stats.dividends)}</span>`)],
    ["Spread & Impact",    p => (p.stats.slip||0) < 0.005 ? "–" : `<span style="color:var(--down)">−${fmt(p.stats.slip)}</span>`],
    ["Realisierte Gewinne",p => `<span style="color:${col(p.stats.realized)}">${sgn(p.stats.realized)}</span>`],
    ["Bester Deal",        p => p.stats.best  === null ? "–" : `<span style="color:${col(p.stats.best)}">${sgn(p.stats.best)}</span>`],
    ["Schwächster Deal",   p => p.stats.worst === null ? "–" : `<span style="color:${col(p.stats.worst)}">${sgn(p.stats.worst)}</span>`],
    ["Depot-Spitze",       p => fmt(p.stats.peak)],
    ["Depot-Tief",         p => fmt(p.stats.trough)],
    ["Max. Rücksetzer",    p => p.stats.maxDD < 0.005 ? "–" : "−" + fmt(p.stats.maxDD)],
    ["Investierte Zeit",   p => Math.round(p.stats.investedTicks / matchTicks * 100) + " %"],
    ["Lieblingsaktie",     p => esc(favSym(p))],
    ["Trades nach News",   p => p.stats.newsTrades],
    ["Trades auf Tipps",   p => p.stats.tipTrades],
    ["Markt geschlagen",   p => p.result.pnl > bh ? "✅ Ja" : "❌ Nein"],
  ];
  let html = '<h4>📊 Analyse</h4><table>';
  if(list.length > 1){
    html += `<tr><th></th>${list.map(p => `<th style="color:${p.color}">${esc(p.name)}</th>`).join("")}</tr>`;
  }
  for(const [label, fn] of rows){
    html += `<tr><td>${label}</td>${list.map(p => `<td>${fn(p)}</td>`).join("")}</tr>`;
  }
  html += `</table><div class="bh-note">Benchmark: Buy &amp; Hold SPCX hätte ${sgn(bh)} gebracht.</div>`;
  $("analysis").innerHTML = html;
}

/* ====================== Ergebnis-Austausch (Zwei-Geräte-Modus) ====================== */
/* Ohne Server: Jeder kopiert sein Ergebnis als kompakten Code (Base64) und
   schickt ihn dem Gegner (z. B. per Messenger). Eingefügt ergibt das die volle
   Duell-Ansicht mit Krone und zweispaltiger Analyse. */
/* Kurzer Streuwert über das Blockorder-Journal: Ergebnisse einer Expert-Runde tragen
   ihn mit, damit die Rangliste erkennen kann, ob alle dieselbe Überlagerung gespielt
   haben (Manipulations-/Sync-Schutz, siehe IMPACT-PLAN.md). */
function journalHash(){
  if(!expert || !journal.length) return 0;
  const s = journal.map(t => t.id + ":" + t.at + ":" + t.sym + ":" + t.side + ":" + t.vol).join(";");
  let h = 5381;
  for(let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function packResult(p){
  const s = p.stats;
  const f = [gameCode, p.name, p.result.pnl.toFixed(2), p.result.total.toFixed(2),
             s.trades, s.buys, s.sells, s.shorts, Math.round(s.volume), s.realized.toFixed(2),
             s.best  === null ? "x" : s.best.toFixed(2),
             s.worst === null ? "x" : s.worst.toFixed(2),
             s.allIns, s.newsTrades, s.investedTicks,
             s.peak.toFixed(2), s.trough.toFixed(2), s.maxDD.toFixed(2),
             s.tipTrades, s.bestPct.toFixed(4), favSym(p),
             (s.feesPaid||0).toFixed(2), (s.dividends||0).toFixed(2),
             (marketSeed == null ? gameCode : marketSeed) >>> 0, // Feld 23: Markt-Seed (Online ≠ Code)
             expert ? 1 : 0, START_CASH,                         // Feld 24/25: Expert-Flag + Startkapital
             (s.slip||0).toFixed(2), journalHash()];             // Feld 26/27: Slippage + Journal-Hash
  return "SPCX6." + btoa(unescape(encodeURIComponent(f.join("|"))));
}

// expectCode: gegen welchen Spiel-Code geprüft wird (Default = laufendes Spiel;
// für den Historien-Vergleich wird der Code des jeweiligen Eintrags übergeben).
function unpackResult(str, expectCode){
  // SPCX6 = aktuell (Expert-Flag/Kapital/Slippage/Journal-Hash), SPCX5 = mit Seed,
  // SPCX4 = älteste noch lesbare Form ohne Seed
  const v6 = str.startsWith("SPCX6."), v5 = str.startsWith("SPCX5."), v4 = str.startsWith("SPCX4.");
  if(!v6 && !v5 && !v4) return null;
  let f;
  try{ f = decodeURIComponent(escape(atob(str.slice(6)))).split("|"); }catch(e){ return null; }
  if(f.length !== (v6 ? 28 : v5 ? 24 : 23)) return null;
  const code = +f[0];
  if(code !== (expectCode === undefined ? gameCode : expectCode)) return {wrongGame:true};
  const nums = [2,3,4,5,6,7,8,9,12,13,14,15,16,17,18,19,21,22].map(i => parseFloat(f[i]));
  if(nums.some(isNaN)) return null;
  if((v5 || v6) && isNaN(+f[23])) return null;
  return {
    gameCode: code,
    seed: (v5 || v6) ? (+f[23] >>> 0) : undefined,
    expert: v6 ? +f[24] === 1 : false,
    cash: v6 ? +f[25] : 25000,
    jhash: v6 ? (+f[27] >>> 0) : undefined,
    name: f[1].slice(0,14) || "Gegner",
    result:{pnl:+f[2], total:+f[3]},
    stats:{trades:+f[4], buys:+f[5], sells:+f[6], shorts:+f[7], volume:+f[8], realized:+f[9],
           best: f[10] === "x" ? null : +f[10],
           worst:f[11] === "x" ? null : +f[11],
           allIns:+f[12], newsTrades:+f[13], investedTicks:+f[14],
           peak:+f[15], trough:+f[16], maxDD:+f[17],
           tipTrades:+f[18], bestPct:+f[19], perSym:{}, _fav:f[20].slice(0,24),
           feesPaid:+f[21], dividends:+f[22], slip: v6 ? +f[26] : 0},
  };
}

/* Ergebnis-Code aus beliebig eingefügtem Text fischen: ganze WhatsApp-Nachricht,
   ?vs=-Link oder roher SPCX4-String – alles wird akzeptiert. */
function extractResultCode(raw){
  raw = (raw || "").trim();
  const link = raw.match(/[?&]vs=([^&\s]+)/);          // kompletter Teil-Link eingefügt
  if(link){ try{ return decodeURIComponent(link[1]); }catch(e){} }
  const code = raw.match(/SPCX[456]\.[A-Za-z0-9+/=]+/); // Code irgendwo im Text
  return code ? code[0] : raw;
}

/* Gegner-Ergebnis eingefügt → volle Duell-Ansicht wie im Ein-Gerät-Modus */
function renderCompare(me, opp){
  opp.color = me.color === "var(--p1)" ? "var(--p2)" : "var(--p1)";
  $("cmpBox").style.display = "none";
  $("resCard2").style.display = "";
  $("resName2").textContent = opp.name;
  document.querySelector("#resCard2 .dot").style.background = opp.color;
  const diff = Math.abs(me.result.pnl - opp.result.pnl);
  const draw = diff < 0.005;
  const meWins = me.result.pnl > opp.result.pnl;
  setRes("1", me,  !draw && meWins  ? KING_BADGE : null);
  setRes("2", opp, !draw && !meWins ? KING_BADGE : null);
  if(draw){
    $("resTitle").textContent = "Unentschieden!";
    $("resSub").textContent = "Auf den Cent gleich – das gibt's selten.";
    $("crown1").textContent = ""; $("crown2").textContent = "";
    $("resCard1").classList.remove("win"); $("resCard2").classList.remove("win");
  }else{
    $("resTitle").textContent = (meWins ? me.name : opp.name) + " gewinnt!";
    $("resSub").textContent = "Vorsprung: " + fmt(diff) + " · identischer Markt für beide";
    $("crown1").textContent = meWins ? "👑" : "";
    $("crown2").textContent = meWins ? "" : "👑";
    $("resCard1").classList.toggle("win", meWins);
    $("resCard2").classList.toggle("win", !meWins);
  }
  buildAnalysis([me, opp]);
}

let soloP = null;

/* Teil-Link auf diese App bauen (nur über http(s) – bei file:// gibt es keine teilbare URL) */
function shareUrl(param, value){
  if(!/^https?:$/.test(location.protocol)) return null;
  return location.origin + location.pathname + "?" + param + "=" + encodeURIComponent(value);
}
/* Text übers System-Teilen-Menü verschicken, sonst in die Zwischenablage */
async function shareOut(text){
  if(navigator.share){ await navigator.share({text}); return "geteilt"; }
  await navigator.clipboard.writeText(text);
  return "kopiert";
}

$("shareBtn").onclick = async function(){
  const code = packResult(soloP);
  const url = shareUrl("vs", code);
  const txt = `📈 Trading Duell (Code ${String(gameCode).padStart(6,"0")}): ${sgn(soloP.result.pnl)} – „${playerTitle(soloP)}"\n` +
              (url ? `Zum Duell-Vergleich antippen: ${url}` : `Ergebnis-Code:\n${code}`);
  try{
    this.textContent = (await shareOut(txt)) === "geteilt" ? "✅ Geteilt!" : "✅ Kopiert – schick's dem Gegner!";
  }catch(e){
    if(e && e.name === "AbortError") return; // Teilen-Menü abgebrochen – kein Fehler
    window.prompt("Zum Kopieren markieren:", txt);
  }
};

$("cmpBtn").onclick = () => {
  const opp = unpackResult(extractResultCode($("cmpIn").value));
  if(!opp){ $("cmpErr").textContent = "Code nicht lesbar – komplett kopiert?"; return; }
  if(opp.wrongGame){ $("cmpErr").textContent = "Das Ergebnis stammt aus einem anderen Spiel."; return; }
  // Gleicher Code, aber anderer Markt (z. B. Online-Seed vs. Offline-Beitritt) → unfair, ablehnen
  const expSeed = (marketSeed == null ? gameCode : marketSeed) >>> 0;
  if(opp.seed !== undefined && opp.seed !== expSeed){
    $("cmpErr").textContent = "Anderer Markt – ein Gerät hat offline mit demselben Code gespielt.";
    return;
  }
  $("cmpErr").textContent = "";
  renderCompare(soloP, opp);
};

/* ====================== Statistik-Seite ====================== */
let statsGames = [], statsCmpIdx = -1, cmpFromStats = false;

const peekCode = str => {           // Spiel-Code (Feld 0) aus einem SPCX4/5/6-String lesen
  if(!str || !/^SPCX[456]\./.test(str)) return null;
  try{ return +decodeURIComponent(escape(atob(str.slice(6)))).split("|")[0]; }catch(e){ return null; }
};

function statGameHtml(g, i, tag){
  const dStr = new Date(g.date).toLocaleDateString("de-DE", {day:"2-digit", month:"2-digit", year:"2-digit"});
  const c = g.pnl >= 0 ? "var(--up)" : "var(--down)";
  return `<div class="stat-game">
    <div class="sg-main">
      <div class="sg-top">${tag ? `<span class="sg-tag">${tag}</span> ` : ""}<b>${esc(g.name)}</b> · ${g.durationMin} Min · ${dStr}</div>
      <div class="sg-sub">Lieblingsaktie ${esc(g.fav || "–")}</div>
    </div>
    <div class="sg-pnl" style="color:${c}">${sgn(g.pnl)}</div>
    <div class="sg-act">
      <button class="sg-btn" data-share="${i}" title="Ergebnis-Code kopieren">📤</button>
      <button class="sg-btn" data-cmp="${i}" title="Mit Gegner vergleichen">⚔️</button>
    </div>
  </div>`;
}

function renderStats(){
  const s = loadStore();
  statsGames = Array.isArray(s.games) ? s.games : [];
  $("statsCmpBox").style.display = "none"; statsCmpIdx = -1;
  const body = $("statsBody");
  if(!statsGames.length){
    body.innerHTML = '<div class="rec" style="display:block;margin-top:24px">Noch keine Spiele gespielt – leg los! 🚀</div>';
    return;
  }
  let best = 0, worst = 0;
  statsGames.forEach((g, i) => { if(g.pnl > statsGames[best].pnl) best = i; if(g.pnl < statsGames[worst].pnl) worst = i; });
  let html = '<div class="stat-head">🏆 Bestes & 📉 schlechtestes Spiel</div>';
  html += statGameHtml(statsGames[best], best, "🏆");
  if(worst !== best) html += statGameHtml(statsGames[worst], worst, "📉");
  html += '<div class="stat-head">🕒 Letzte 5</div>';
  statsGames.slice(0, 5).forEach((g, i) => html += statGameHtml(g, i, "")); // slice 0..4 == Original-Index
  body.innerHTML = html;
  body.querySelectorAll("[data-share]").forEach(b => b.onclick = () => shareStatsGame(+b.dataset.share, b));
  body.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => openStatsCompare(+b.dataset.cmp));
}

async function shareStatsGame(i, btn){
  const g = statsGames[i];
  const url = shareUrl("vs", g.code);
  const txt = `📈 Trading Duell (${g.durationMin} Min): ${sgn(g.pnl)}\n` +
              (url ? `Zum Duell-Vergleich antippen: ${url}` : `Ergebnis-Code:\n${g.code}`);
  try{
    await shareOut(txt);
    const o = btn.textContent; btn.textContent = "✅"; setTimeout(() => btn.textContent = o, 1500);
  }catch(e){
    if(e && e.name === "AbortError") return;
    window.prompt("Zum Kopieren markieren:", txt);
  }
}

function openStatsCompare(i){
  statsCmpIdx = i;
  $("statsCmpIn").value = ""; $("statsCmpErr").textContent = "";
  $("statsCmpLabel").textContent = `Gegner-Code zu „${esc(statsGames[i].name)}" (${statsGames[i].durationMin} Min) einfügen`;
  $("statsCmpBox").style.display = "";
  $("statsCmpBox").scrollIntoView({behavior:"smooth", block:"center"});
}

/* Historien-Vergleich ausführen: eigener Eintrag + Gegner-String → Duell-Ansicht.
   Genutzt vom Statistik-Button UND vom ?vs=-Teil-Link. */
function runStatsCompare(entry, oppRaw, errEl){
  const gc = peekCode(entry.code);
  const me = unpackResult(entry.code, gc);
  if(!me || me.wrongGame){ errEl.textContent = "Eigener Eintrag beschädigt."; return false; }
  const opp = unpackResult(extractResultCode(oppRaw), gc);
  if(!opp){ errEl.textContent = "Code nicht lesbar – komplett kopiert?"; return false; }
  if(opp.wrongGame){ errEl.textContent = "Dieses Ergebnis stammt aus einem anderen Spiel."; return false; }
  // Markt-Seed abgleichen: beide müssen denselben Markt gespielt haben (Online: Seed ≠ Code)
  const expSeed = (me.seed !== undefined ? me.seed : gc) >>> 0;
  if(opp.seed !== undefined && opp.seed !== expSeed){
    errEl.textContent = "Anderer Markt – dieses Ergebnis passt nicht zu deinem Spiel."; return false;
  }
  errEl.textContent = "";
  // Ansicht sicher auf den klassischen Zwei-Spalten-Vergleich stellen
  rankRoom = null;
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  // Markt des Eintrags deterministisch rekonstruieren → Analyse/Benchmark stimmen
  sandbox = false; gameCode = gc; durationMin = entry.durationMin;
  marketSeed = (me.seed !== undefined && me.seed !== (gc >>> 0)) ? me.seed : null;
  buildMarket();
  me.color = "var(--p1)";
  $("resName1").textContent = me.name;
  document.querySelector("#resCard1 .dot").style.background = "var(--p1)";
  $("crown1").textContent = ""; $("resCard1").classList.remove("win");
  renderCompare(me, opp);
  $("resCode").textContent = String(gc).padStart(6, "0");
  $("rematchBtn").textContent = "← Zurück zur Statistik";
  cmpFromStats = true;
  $("overlay").classList.add("show");
  return true;
}

$("statsCmpBtn").onclick = () => {
  if(statsCmpIdx < 0) return;
  if(runStatsCompare(statsGames[statsCmpIdx], $("statsCmpIn").value, $("statsCmpErr")))
    $("statsScreen").classList.remove("show");
};

$("statsBtn").onclick = () => {
  renderStats();
  $("startScreen").classList.remove("show");
  $("statsScreen").classList.add("show");
  window.scrollTo(0, 0);
};
$("statsBack").onclick = () => {
  $("statsScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  window.scrollTo(0, 0);
};

/* Remote: eigenes Ergebnis + Austausch-Box für den Vergleich */
function showResultSolo(p){
  clearSnapshot(); // Runde gespielt – Snapshot entfernen
  soloP = p;
  const solo = mode === "solo"; // Einzelspieler: kein Gegner, kein Ergebnis-Austausch
  $("resTitle").textContent = sandbox ? "Sandbox beendet!" : "Geschafft!";
  $("resSub").textContent = sandbox
    ? "Freies Üben – kein Rekord-Eintrag."
    : solo
      ? "Dein Ergebnis – schaffst du beim nächsten Mal mehr?"
      : "Tauscht eure Ergebnisse aus – dann gibt's den direkten Vergleich.";
  $("resName1").textContent = p.name;
  document.querySelector("#resCard1 .dot").style.background = p.color;
  $("crown1").textContent = "";
  $("resCard1").classList.remove("win");
  $("resCard2").style.display = "none";
  setRes("1", p);
  buildAnalysis([p]);
  $("cmpBox").style.display = solo ? "none" : "";
  $("shareBtn").textContent = "📤 Mein Ergebnis teilen";
  $("cmpIn").value = ""; $("cmpErr").textContent = "";
  // Ansicht auf den klassischen Zustand zurücksetzen (falls zuvor eine Rangliste offen war)
  rankRoom = null;
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  $("resCode").textContent = String(gameCode).padStart(6,"0");
  const inRoom = mode === "room" && room;
  if(inRoom) $("cmpBox").style.display = "none"; // im Raum läuft alles automatisch
  $("rematchBtn").textContent = inRoom ? "← Zurück in den Raum" : "Neues Spiel";
  $("overlay").classList.add("show");
  // Raum-Runde: Ergebnis abliefern → Runden-Rangliste (füllt sich über den Raum-Puls)
  if(inRoom && !sandbox) roomShareResult(p);
}

function showResult(){
  clearSnapshot(); // Duell entschieden – Snapshot entfernen
  rankRoom = null; // falls zuvor eine Runden-Rangliste offen war
  $("rankBox").style.display = "none"; $("rankBack").style.display = "none";
  document.querySelector(".res-row").style.display = "";
  $("analysis").style.display = "";
  $("resCard2").style.display = "";
  $("cmpBox").style.display = "none";
  $("rematchBtn").textContent = "Revanche";
  document.querySelector("#resCard1 .dot").style.background = "var(--p1)";
  const r1 = players[0].result, r2 = players[1].result;
  $("resName1").textContent = players[0].name;
  $("resName2").textContent = players[1].name;
  const diff = Math.abs(r1.pnl - r2.pnl);
  const draw = diff < 0.005;
  const w = r1.pnl > r2.pnl ? 0 : 1;
  setRes("1", players[0], !draw && w === 0 ? KING_BADGE : null);
  setRes("2", players[1], !draw && w === 1 ? KING_BADGE : null);
  buildAnalysis([players[0], players[1]]);

  if(draw){
    $("resTitle").textContent = "Unentschieden!";
    $("resSub").textContent = "Auf den Cent gleich – das gibt's selten.";
    $("crown1").textContent = ""; $("crown2").textContent = "";
    $("resCard1").classList.remove("win"); $("resCard2").classList.remove("win");
  }else{
    $("resTitle").textContent = players[w].name + " gewinnt!";
    $("resSub").textContent = "Vorsprung: " + fmt(diff) + " · identischer Markt für beide";
    $("crown1").textContent = w === 0 ? "👑" : "";
    $("crown2").textContent = w === 1 ? "👑" : "";
    $("resCard1").classList.toggle("win", w === 0);
    $("resCard2").classList.toggle("win", w === 1);
  }
  $("resCode").textContent = gameCode;
  $("overlay").classList.add("show");
}

/* extra: Zusatz-Badge für den Duell-Sieger (👑 Börsenkönig) */
function setRes(i, p, extra){
  const r = p.result;
  const el = $("resPnl"+i);
  el.textContent = sgn(r.pnl);
  el.style.color = r.pnl >= 0 ? "var(--up)" : "var(--down)";
  $("resTot"+i).textContent = "Endwert " + fmt(r.total);
  $("resBadge"+i).textContent = playerTitle(p);
  $("resBadges"+i).innerHTML = badgesHtml(playerBadges(p, extra));
}

/* ====================== Tutorial ====================== */
/* Interaktives Übungsspiel: gescripteter Mini-Markt mit festem Seed (~2:30 Min
   Spielzeit), eine Coach-Leiste führt durch die 6 Schritte. Nutzt den normalen
   Match-Screen und die echte Handelslogik – genMarket und die Duell-Fairness
   bleiben unberührt. Bei Erklär- und Aktions-Schritten steht die Spielzeit
   (paused), es gibt also keinen Zeitdruck. */
let tutorial = false, tutStep = 0;


/* Drehbuch (Ticks à TICK_MS). Die Coach-Pausen frieren tickCount ein, daher
   passen die festen Event-Ticks und der vorberechnete Pfad immer zusammen.
   Ablauf der Beobachtungs-Fenster (Pausen dazwischen verbrauchen keine Ticks):
   0–20  SPCX-Anstieg (Einstand/Depot/Kerzen, Verkauf bei 20)
   20–44 SPCX-News bei 26 (Sprung bei 26+R)
   44–82 Insider-Tipp 48 → RKLB-Event 64 (Sprung 64+R)
   82–170 Abschluss-Test mit Mega: News 92, Vor-Beben 96/100/104,
          Hauptschlag bei 110, danach Abebben (Verkaufsfenster). */
function genTutorialMarket(){
  const rnd = mulberry32(4242);
  const g = () => {
    let u=0,v=0;
    while(u===0)u=rnd();
    while(v===0)v=rnd();
    return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  };
  const R = REACT_TICKS;
  const script = {
    SPCX:{sigma:0.0008,
          jumps:{[26+R]:+0.022,                       // positive News (Schritt »News«)
                 96:+0.012, 100:+0.012, 104:+0.012,   // Mega: Vor-Beben kriecht herein
                 110:+0.20},                           // Mega: Hauptschlag
          drift:t => t >= 1  && t <= 20  ? +0.0017     // Aufwärts für Einstand/Depot/Kerzen
                   : t > 26+R && t <= 26+R+12 ? +0.0008 // sanfter Nachlauf nach der News
                   : t >= 112 && t <= 152 ? -0.0032 : 0},// Mega ebbt ~zwei Drittel wieder ab
    RKLB:{sigma:0.0009, jumps:{[64+R]:+0.030},
          drift:t => t > 64+R && t <= 64+R+16 ? +0.0011 : 0},
  };
  const paths = {}, prices = {};
  for(const [sym,d] of Object.entries(STOCK_DEFS)){ paths[sym] = [d.start]; prices[sym] = d.start; }
  // Nicht eigens gescriptete Aktien (die übrigen Werte) laufen ruhig im Hintergrund
  const QUIET = {sigma:0.0006, jumps:{}, drift:() => 0};
  for(let i = 1; i <= TUT_TICKS; i++){
    for(const sym of Object.keys(STOCK_DEFS)){
      const sc = script[sym] || QUIET;
      if(sc.jumps[i]) prices[sym] *= 1 + sc.jumps[i];
      const sig = sc.sigma;
      prices[sym] = Math.max(1, prices[sym] * Math.exp(sc.drift(i) - sig*sig/2 + sig*g()));
      paths[sym].push(prices[sym]);
    }
  }
  const events = [
    {tick:26, ev:{t:"SPCX", txt:"NASA vergibt neuen Mond-Auftrag an SpaceX!"}, tag:"up"},
    {tick:64, ev:{t:"RKLB", txt:"Rocket Lab gewinnt Mega-Vertrag für eine Satelliten-Konstellation!"}, tag:"up"},
    {tick:92, ev:{t:"SPCX", txt:"💥 MEGA: Jahrhundert-Auftrag! Regierung lässt SpaceX die Mond-Basis bauen.",
                  jump:+0.20, drift:+0.0008, dur:40}, tag:"up", mega:true},
  ];
  const tips = [{tick:48, eventTick:64, sym:"RKLB", dir:1}];
  addEtfPath(paths, TUT_TICKS);    // damit price("MKT") auch im Tutorial existiert
  addActivePath(paths, TUT_TICKS); // ebenso price("ACT")
  return {paths, events, tips};
}

/* Schritte: pause = Spielzeit angehalten, glow = pulsierender Ziel-Button,
   btn/next = Weiter-Knopf samt Folgeschritt. Aktions-Schritte (2 und 4) werden
   über tutOnTrade weitergeschaltet, Beobachtungs-Phasen über tutOnTick. */

function tutShow(n){
  tutStep = n;
  const st = TUT_STEPS[n];
  paused = st.pause;
  if(st.cm) setChartMode(st.cm); // Schritt kann die Chart-Ansicht umstellen (Kerzen/Linie)
  $("coachStep").textContent = st.lbl;
  $("coachText").innerHTML = st.text;
  const b = $("coachBtn");
  b.style.display = st.btn ? "" : "none";
  b.textContent = st.btn || "";
  b.onclick = st.next ? () => tutShow(st.next) : null;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  if(st.glow) $(st.glow).classList.add("tut-glow");
  $("coach").classList.add("show");
}

/* Aktions-Schritte: erfolgreicher Kauf bzw. Verkauf schaltet weiter */
function tutOnTrade(side){
  if(tutStep === 2 && side === "buy") tutShow(3);
  else if(tutStep === 6 && side === "sell") tutShow(7);
}

/* Favoriten-Schritt: sobald eine neue (nicht-Standard) Aktie zum Favorit wird */
function tutOnFav(){
  if(tutStep === 11 && favorites.some(f => !DEFAULT_FAVS.includes(f))){
    closeStockModal();
    tutShow(12);
  }
}

/* Beobachtungs-Phasen enden an festen Ticks */
function tutOnTick(){
  if(tickCount === 20 && tutStep === 3) tutShow(4);        // Einstand/Depot
  else if(tickCount === 44 && tutStep === 8) tutShow(9);   // News → Insider
  else if(tickCount === 82 && tutStep === 10) tutShow(11); // Insider → Alle Aktien
  else if(tickCount === 114 && tutStep === 13) tutShow(14);// Mega im Hoch
}

/* Abschluss: eigenes Übungs-Ergebnis statt Duell-Auswertung */
function tutFinish(p){
  tutStep = 0;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  const pnl = p.result.pnl;
  $("coachStep").textContent = "Tutorial beendet";
  $("coachText").innerHTML =
    `🎓 <b>Geschafft!</b> Dein Übungs-Ergebnis: ` +
    `<b style="color:${pnl >= 0 ? "var(--up)" : "var(--down)"}">${sgn(pnl)}</b>. ` +
    `Du kennst jetzt Kaufen, Verkaufen & Short, den Einstand & dein Depot, den Kerzen-Chart, ` +
    `News mit Reaktionslücke, Insider-Tipps, alle 10 Aktien samt Favoriten – und Mega-Events. ` +
    `💡 Extra: Jede Order kostet 0,15 % <b>Gebühr</b>, manche Aktien & der <b>Markt-ETF (MKT)</b> ` +
    `zahlen <b>Dividende</b> fürs Halten – Geduld ist eine echte Strategie. ` +
    `Im echten Duell zählt genau dein Ergebnis – nur dass dein Gegner denselben Markt bekommt. Viel Erfolg!`;
  const b = $("coachBtn");
  b.style.display = "";
  b.textContent = "Zum Startbildschirm";
  b.onclick = exitTutorial;
}

function exitTutorial(){
  clearInterval(timer);
  over = true; tutorial = false; tutStep = 0;
  document.querySelectorAll(".tut-glow").forEach(el => el.classList.remove("tut-glow"));
  document.body.classList.remove("tut");
  $("coach").classList.remove("show");
  $("newsPop").classList.remove("show");
  $("matchScreen").classList.remove("show");
  $("startScreen").classList.add("show");
  // mode wieder an die Auswahl auf dem Startscreen angleichen (robust für Einzelspieler)
  const topSel = document.querySelector(".mtop.active");
  setTop(topSel ? topSel.dataset.top : "single");
  window.scrollTo(0,0);
}

$("coachExit").onclick = exitTutorial;

$("tutBtn").onclick = () => {
  tutorial = true;
  expert = false; // der Coach unterrichtet die Grundregeln – keine Experten-Härten
  START_CASH = 25000;
  gameCode = 0;
  mode = "local";
  matchTicks = TUT_TICKS;
  market = genTutorialMarket();
  players = [newPlayer("Du", "var(--p1)")];
  document.body.classList.add("tut");
  startRound(0);
  tutShow(1);
};

/* ====================== Steuerung ====================== */
$("pauseBtn").onclick = function(){
  if(over) return;
  paused = !paused;
  this.textContent = paused ? "▶ Weiter" : "⏸ Pause";
};
$("endSandboxBtn").onclick = () => { if(!over) endRound(); };
$("npSkip").onclick = closeNewsPop;
$("buyBtn").onclick = () => trade("buy");
$("sellBtn").onclick = () => trade("sell");
$("shortBtn").onclick = () => trade("short");
$("ordBuyBtn").onclick = () => placeOrder("buy");
$("ordSellBtn").onclick = () => placeOrder("sell");
document.querySelectorAll(".chip").forEach(c => c.onclick = () => {
  qtyMode = c.dataset.q;
  document.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
  renderAll();
});
/* Chart-Ansicht umschalten (Linie/Kerzen) – reine Optik, kein Spieleinfluss */
function setChartMode(cm){
  chartMode = cm;
  document.querySelectorAll(".ctg").forEach(x => x.classList.toggle("active", x.dataset.cm === cm));
  if(market) drawChart();
}
document.querySelectorAll(".ctg").forEach(b => b.onclick = () => setChartMode(b.dataset.cm));
window.addEventListener("resize", () => { if(market) drawChart(); });

/* ====================== Teil-Links (?join= / ?vs=) ====================== */
/* Geteiltes Ergebnis (?vs=…) öffnen: passendes eigenes Spiel in der Historie suchen
   und direkt den Duell-Vergleich zeigen. Fehlt das eigene Ergebnis, wird der
   Spiel-Code zum Nachspielen vorbefüllt – gleicher Code = exakt gleicher Markt. */
function openSharedCompare(oppRaw){
  const gc = peekCode(extractResultCode(oppRaw));
  if(gc == null || !isFinite(gc)) return;               // unlesbarer Link – still ignorieren
  const s = loadStore();
  const games = Array.isArray(s.games) ? s.games : [];
  const entry = games.find(g => peekCode(g.code) === gc);
  if(!entry){
    setTop("multi"); setMode("remote");
    codeIn.value = String(gc).padStart(6, "0");
    codeIn.dispatchEvent(new Event("input"));           // Dauer übernehmen/sperren, Button-Text
    $("codeErr").textContent = "Zum Vergleichen spiel erst dieses Spiel – der Code ist schon eingetragen.";
    return;
  }
  if(runStatsCompare(entry, oppRaw, $("codeErr")))
    $("startScreen").classList.remove("show");
}

/* 6-stelligen Beitritts-Code in die Remote-Eingabe übernehmen (Zwei-Geräte-Modus). */
function applyJoinCode(code){
  if(!/^\d{6}$/.test(code || "")) return false;
  $("startScreen").classList.add("show");
  setTop("multi"); setMode("remote");
  codeIn.value = code;
  codeIn.dispatchEvent(new Event("input")); // Dauer übernehmen/sperren, Button-Text aktualisieren
  $("name1").focus();
  return true;
}
/* Beliebigen geteilten/gescannten Text (voller ?join=/?vs=-Link ODER blanker 6-stelliger
   Code) an die richtige Stelle leiten. Rückgabe: true, wenn etwas erkannt wurde. */
function routeSharedText(text){
  text = (text || "").trim();
  let params = null; const q = text.indexOf("?");
  if(q >= 0){ try{ params = new URLSearchParams(text.slice(q)); }catch(e){} }
  const vs = params && params.get("vs");
  if(vs){ openSharedCompare(vs); return true; }
  const rm = params && params.get("room");
  if(rm && /^\d{6}$/.test(rm)){ // Raum-Einladung: Modus setzen und direkt beitreten
    $("startScreen").classList.add("show");
    setTop("multi"); setMode("room");
    codeIn.value = rm;
    codeIn.dispatchEvent(new Event("input"));
    $("startBtn").onclick();
    return true;
  }
  const join = (params && params.get("join")) || (/^\d{6}$/.test(text) ? text : null);
  return applyJoinCode(join);
}
function handleShareParams(){
  let p;
  try{ p = new URLSearchParams(location.search); }catch(e){ return false; }
  if(p.get("join") === null && p.get("vs") === null && p.get("room") === null) return false;
  const q = location.search;                                             // vor dem Aufräumen sichern
  try{ history.replaceState(null, "", location.pathname); }catch(e){}    // nicht erneut auslösen (Reload/PWA)
  routeSharedText(q);
  return true;
}
if(!handleShareParams() && !loadSnapshot()){
  // Bestehende Raum-Mitgliedschaft NICHT still wiederbeleben (Gefahr: man landet
  // unbemerkt in einem alten Raum, während die anderen längst in einem neuen sind).
  // Stattdessen ein expliziter Knopf mit sichtbarem Raum-Code.
  const rm = loadRoomState();
  if(rm){
    const b = $("roomBackBtn");
    b.textContent = "🚪 Zurück in den Raum " + rm.code;
    b.style.display = "";
    b.onclick = () => {
      b.style.display = "none";
      room = loadRoomState();
      if(room) showRoomScreen();
    };
  }
}

/* ====================== QR-Scanner (Einladung scannen) ====================== */
let scanStream = null, scanTimer = null, jsQRLoad = null;

/* Decoder-Fallback (z. B. iOS Safari ohne BarcodeDetector) erst bei Bedarf nachladen –
   gleiche Herkunft (CSP 'self'), vom Service Worker gecacht, also auch offline. */
function loadJsQR(){
  if(window.jsQR) return Promise.resolve();
  if(!jsQRLoad) jsQRLoad = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "jsqr.js";
    s.onload = res;
    s.onerror = () => { jsQRLoad = null; rej(new Error("jsqr")); };
    document.body.appendChild(s);
  });
  return jsQRLoad;
}
/* Liefert eine Erkennungs-Funktion video -> Promise<Text|null>: nativer BarcodeDetector,
   wo verfügbar – sonst jsQR auf einem (fürs Decodieren verkleinerten) Canvas-Frame. */
async function makeDetector(){
  if(typeof window.BarcodeDetector !== "undefined"){
    try{
      const d = new window.BarcodeDetector({formats:["qr_code"]});
      return async v => { const c = await d.detect(v); return c.length ? (c[0].rawValue || "") : null; };
    }catch(e){ /* Format nicht unterstützt → jsQR-Fallback */ }
  }
  await loadJsQR();
  const cv = document.createElement("canvas");
  const cx = cv.getContext("2d", {willReadFrequently:true});
  return async v => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if(!vw || !vh) return null;
    const sc = Math.min(1, 640 / Math.max(vw, vh)); // ~640px reichen zum Decodieren, spart CPU
    cv.width = Math.round(vw*sc); cv.height = Math.round(vh*sc);
    cx.drawImage(v, 0, 0, cv.width, cv.height);
    const id = cx.getImageData(0, 0, cv.width, cv.height);
    const r = window.jsQR(id.data, cv.width, cv.height, {inversionAttempts:"dontInvert"});
    return r ? r.data : null;
  };
}
function stopScan(){
  clearTimeout(scanTimer); scanTimer = null;
  if(scanStream){ scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  $("scanVideo").srcObject = null;
  $("scanOverlay").classList.remove("show");
}
async function startScan(){
  $("scanErr").textContent = "";
  $("scanOverlay").classList.add("show");
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    $("scanErr").textContent = "Kamera hier nicht verfügbar. Tipp: den QR mit der Kamera-App scannen oder den 6-stelligen Code eintippen.";
    return;
  }
  let detect;
  try{
    detect = await makeDetector();
  }catch(e){
    $("scanErr").textContent = "Scanner konnte nicht geladen werden – bitte erneut versuchen.";
    return;
  }
  // Rückkamera bevorzugen, aber nicht erzwingen; scheitert das, jede verfügbare Kamera nehmen.
  try{
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false});
  }catch(e1){
    try{
      scanStream = await navigator.mediaDevices.getUserMedia({video:true, audio:false});
    }catch(e2){
      // Fehlername mit anzeigen (NotAllowedError etc.) – hilft bei der Diagnose, v.a. auf iOS
      $("scanErr").textContent = "Kein Kamerazugriff (" + (e2.name || e2.message || "unbekannt") +
        ") – bitte der App/Website in den iOS-Einstellungen die Kamera erlauben.";
      return;
    }
  }
  const video = $("scanVideo");
  video.muted = true;
  video.srcObject = scanStream;
  await video.play().catch(()=>{});
  const tick = async () => {
    if(!scanStream) return; // abgebrochen
    try{
      const raw = await detect(video);
      if(raw){
        if(routeSharedText(raw)){ stopScan(); return; }
        $("scanErr").textContent = "Kein SPCX-Einladungscode erkannt.";
      }
    }catch(e){ /* einzelner Frame-Fehler: einfach weiter */ }
    scanTimer = setTimeout(tick, 250);
  };
  scanTimer = setTimeout(tick, 300);
}
$("scanBtn").onclick = startScan;
$("scanCancel").onclick = stopScan;
$("scanOverlay").onclick = e => { if(e.target === $("scanOverlay")) stopScan(); };

/* PWA: Service Worker registrieren (nur wenn über http(s) geladen) */
if("serviceWorker" in navigator && location.protocol.startsWith("http")){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  });
}
