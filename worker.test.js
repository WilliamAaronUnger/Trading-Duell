/* Tests für worker.js (Online-Duell 2–8 Spieler, D1-Speicher). Ausführen mit:
   node worker.test.js  – braucht nur Node ≥ 22 (fetch, WebCrypto, node:sqlite), keine
   Abhängigkeiten. D1 wird über einen kleinen Adapter auf echtem SQLite simuliert;
   getestet wird der echte fetch-Handler. */
const fs = require("fs"), os = require("os"), path = require("path"), {pathToFileURL} = require("url");
const {DatabaseSync} = require("node:sqlite");

/* Mini-Adapter: bildet die D1-API (prepare/bind/first/run/all) auf node:sqlite ab */
function d1Stub(){
  const db = new DatabaseSync(":memory:");
  return {
    _db: db,
    prepare(sql){
      return {
        _args: [],
        bind(...a){ this._args = a; return this; },
        async first(){ const r = db.prepare(sql).get(...this._args); return r === undefined ? null : r; },
        async run(){ const info = db.prepare(sql).run(...this._args);
          return {success: true, meta: {changes: Number(info.changes)}}; },
        async all(){ return {results: db.prepare(sql).all(...this._args)}; },
      };
    },
  };
}

let passed = 0, failed = 0;
function ok(cond, name){ console.log((cond ? "✔ " : "✘ ") + name); cond ? passed++ : failed++; }

(async () => {
  // worker.js ist ein ES-Modul; fürs Laden ohne package.json als .mjs-Kopie importieren
  const tmp = path.join(os.tmpdir(), "spcx-worker-" + process.pid + ".mjs");
  fs.copyFileSync(path.join(__dirname, "worker.js"), tmp);
  const worker = (await import(pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);

  const db = d1Stub(), env = {DB: db};
  const call = (method, p, body, headers) =>
    worker.fetch(new Request("https://api.test" + p, {method, body, headers}), env);
  const jbody = o => JSON.stringify(o);

  // ---- Anlegen ----
  let r = await call("POST", "/game", jbody({dur: 10, name: "Anna"}));
  ok(r.status === 201, "Anlegen → 201");
  const g1 = await r.json();
  ok(/^\d{6}$/.test(g1.code), "6-stelliger Code");
  ok(+g1.code % 3 === 1, "Code kodiert Dauer (10 Min → %3 == 1)");
  ok(g1.dur === 10 && typeof g1.token === "string" && g1.token.length >= 16, "dur + Ersteller-Token");
  const stored = db._db.prepare("SELECT * FROM games WHERE code = ?").get(g1.code);
  ok(Number.isInteger(stored.seed) && stored.seed >= 0 && stored.seed <= 0xFFFFFFFF, "Seed ist uint32");

  ok((await call("POST", "/game", jbody({dur: 7}))).status === 400, "ungültige Dauer → 400");
  ok((await call("POST", "/game", "kein json")).status === 400, "kaputtes JSON → 400");

  // ---- Zustand: Roster + Kompatibilitätsflag, Seed geheim ----
  let st = await (await call("GET", "/game/" + g1.code)).json();
  ok(st.players.length === 1 && st.players[0].p === 1 && st.players[0].name === "Anna",
     "Roster zeigt Ersteller (Name)");
  ok(st.joined === false && st.startAt === null && !("seed" in st), "Seed vor Start unsichtbar, joined=false");

  // ---- Start vor 2 Spielern / mit falschem Token verboten ----
  ok((await call("POST", `/game/${g1.code}/start`, jbody({token: g1.token}))).status === 409, "Start allein → 409");
  ok((await call("POST", `/game/${g1.code}/start`, jbody({token: "falsch"}))).status === 403, "Start mit falschem Token → 403");

  // ---- Beitritte: Plätze 2..n, Namen, joined-Flag ----
  r = await call("POST", `/game/${g1.code}/join`, jbody({name: "Ben"}));
  const j2 = await r.json();
  ok(r.status === 200 && j2.p === 2 && j2.dur === 10 && j2.token && j2.token !== g1.token,
     "Beitritt 1 → Platz 2 + eigenes Token");
  const j3 = await (await call("POST", `/game/${g1.code}/join`, jbody({name: "Cleo"}))).json();
  ok(j3.p === 3, "Beitritt 2 → Platz 3");
  st = await (await call("GET", "/game/" + g1.code)).json();
  ok(st.players.length === 3 && st.players.map(x => x.name).join(",") === "Anna,Ben,Cleo",
     "Roster: alle drei in Reihenfolge");
  ok(st.joined === true && !("seed" in st), "joined=true (Kompatibilität), Seed weiter geheim");

  // ---- Gleichzeitige Beitritte: verschiedene Plätze, keiner geht verloren ----
  const [ra, rb] = await Promise.all([
    call("POST", `/game/${g1.code}/join`, jbody({name: "Dana"})),
    call("POST", `/game/${g1.code}/join`, jbody({name: "Emil"})),
  ]);
  const pa = (await ra.json()).p, pb = (await rb.json()).p;
  ok(ra.status === 200 && rb.status === 200 && pa !== pb && [pa, pb].sort().join(",") === "4,5",
     "gleichzeitige Beitritte → Plätze 4 und 5");

  // ---- Kapazität: maximal 8 ----
  await call("POST", `/game/${g1.code}/join`); // 6
  await call("POST", `/game/${g1.code}/join`); // 7
  const j8 = await call("POST", `/game/${g1.code}/join`); // 8
  ok(j8.status === 200 && (await j8.json()).p === 8, "Platz 8 noch möglich");
  ok((await call("POST", `/game/${g1.code}/join`)).status === 409, "9. Beitritt → 409 (voll)");

  // ---- Start (nur Ersteller, idempotent, verrät Seed) ----
  const t0 = Date.now();
  r = await call("POST", `/game/${g1.code}/start`, jbody({token: g1.token}));
  const s1 = await r.json();
  ok(r.status === 200 && s1.startAt >= t0 + 9000 && s1.startAt <= t0 + 11500, "Start fixiert (~10 s Puffer)");
  ok(s1.seed === stored.seed, "Start liefert den gespeicherten Seed");
  const s2 = await (await call("POST", `/game/${g1.code}/start`, jbody({token: g1.token}))).json();
  ok(s2.startAt === s1.startAt && s2.seed === s1.seed, "Start ist idempotent");
  st = await (await call("GET", "/game/" + g1.code)).json();
  ok(st.startAt === s1.startAt && st.seed === s1.seed, "GET zeigt Seed erst jetzt");
  ok((await call("POST", `/game/${g1.code}/join`)).status === 409, "Beitritt nach Start → 409");

  // ---- Ergebnisse: Token je Spieler, write-once, Format-/Größenlimits ----
  const res1 = "SPCX5." + "A".repeat(80);
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": j2.token})).status === 403, "fremdes Token → 403");
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": g1.token})).status === 201, "eigenes Ergebnis → 201");
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": g1.token})).status === 409, "write-once → 409");
  ok((await call("PUT", `/game/${g1.code}/result/3`, "SPCX5.cleo", {"x-token": j3.token})).status === 201, "Platz 3 lädt mit eigenem Token hoch");
  ok((await call("PUT", `/game/${g1.code}/result/2`, "SPCX4.alt", {"x-token": j2.token})).status === 400, "falsches Präfix → 400");
  ok((await call("PUT", `/game/${g1.code}/result/2`, "SPCX5." + "B".repeat(700), {"x-token": j2.token})).status === 400, "zu groß → 400");
  ok((await call("GET", `/game/${g1.code}/result/2`)).status === 404, "fehlendes Ergebnis → 404");
  await call("PUT", `/game/${g1.code}/result/2`, "SPCX5.zwei", {"x-token": j2.token});
  ok(await (await call("GET", `/game/${g1.code}/result/1`)).text() === res1, "fremdes Ergebnis abholbar");
  ok((await call("PUT", `/game/${g1.code}/result/9`, "SPCX5.x", {"x-token": g1.token})).status === 400, "Platz 9 → 400");

  // ---- Verfall: >24 h alte Spiele sind unbekannt und werden beim Anlegen gelöscht ----
  const g3 = await (await call("POST", "/game", jbody({dur: 15}))).json();
  db._db.prepare("UPDATE games SET created = ? WHERE code = ?").run(Date.now() - 25*3600*1000, g3.code);
  ok((await call("GET", "/game/" + g3.code)).status === 404, "abgelaufenes Spiel → 404");
  await call("POST", "/game", jbody({dur: 5})); // Anlegen räumt auf
  ok(db._db.prepare("SELECT COUNT(*) AS n FROM games WHERE code = ?").get(g3.code).n === 0 &&
     db._db.prepare("SELECT COUNT(*) AS n FROM players WHERE code = ?").get(g3.code).n === 0,
     "Aufräumen löscht Spiel + Spielerliste");

  // ---- Alte App-Version (v52): Beitritt ohne Namen, joined-Flag ----
  const g4 = await (await call("POST", "/game", jbody({dur: 10}))).json();
  const jo = await call("POST", `/game/${g4.code}/join`); // kein Body wie alte Clients
  ok(jo.status === 200 && (await jo.json()).p === 2, "Alt-Client: Beitritt ohne Body → Platz 2");
  st = await (await call("GET", "/game/" + g4.code)).json();
  ok(st.joined === true, "Alt-Client: joined-Flag vorhanden");

  // ---- Live-Rennen: P&L melden/abholen ----
  ok((await call("PUT", `/game/${g4.code}/pnl/1`, jbody({pnl: 5}), {"x-token": g4.token})).status === 409, "P&L vor Start → 409");
  ok((await call("PUT", `/game/${g1.code}/pnl/1`, jbody({pnl: 123.456}), {"x-token": j2.token})).status === 403, "P&L mit fremdem Token → 403");
  ok((await call("PUT", `/game/${g1.code}/pnl/1`, jbody({pnl: 123.456}), {"x-token": g1.token})).status === 200, "eigenen P&L melden → 200");
  ok((await call("PUT", `/game/${g1.code}/pnl/2`, jbody({pnl: -42}), {"x-token": j2.token})).status === 200, "zweiter Spieler meldet → 200");
  let pn = await (await call("GET", `/game/${g1.code}/pnl`)).json();
  ok(pn.pnls["1"] === 123.46 && pn.pnls["2"] === -42, "GET liefert alle P&L (gerundet)");
  await call("PUT", `/game/${g1.code}/pnl/1`, jbody({pnl: 200}), {"x-token": g1.token});
  pn = await (await call("GET", `/game/${g1.code}/pnl`)).json();
  ok(pn.pnls["1"] === 200, "P&L wird überschrieben (kein write-once)");
  ok((await call("PUT", `/game/${g1.code}/pnl/1`, jbody({pnl: "quatsch"}), {"x-token": g1.token})).status === 400, "kaputter P&L → 400");
  ok((await call("GET", `/game/${g4.code}/pnl`)).status === 200, "GET P&L auch ohne Meldungen (leer)");

  // ---- Routing/CORS ----
  ok((await call("GET", "/game/000001")).status === 404, "unbekanntes Spiel → 404");
  ok((await call("GET", "/game/abc")).status === 400, "kaputter Code → 400");
  ok((await call("DELETE", "/game/" + g1.code)).status === 405, "falsche Methode → 405");
  ok((await call("GET", "/quatsch")).status === 404, "unbekannter Pfad → 404");
  r = await call("OPTIONS", "/game");
  ok(r.status === 204 && r.headers.get("access-control-allow-origin") === "*", "CORS-Preflight");
  ok((await call("GET", "/game/" + g1.code)).headers.get("access-control-allow-origin") === "*", "CORS auf Antworten");

  console.log(failed ? `\n${failed} FEHLER (${passed} ok)` : `\nALLE ${passed} TESTS OK`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Test-Harness-Fehler:", e); process.exit(1); });
