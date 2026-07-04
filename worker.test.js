/* Tests für worker.js (Online-Stufe 1, D1-Speicher). Ausführen mit:  node worker.test.js
   Braucht nur Node ≥ 22 (fetch-API, WebCrypto und node:sqlite eingebaut), keine
   Abhängigkeiten. D1 wird über einen kleinen Adapter auf echtem SQLite simuliert;
   getestet wird der echte fetch-Handler. */
const fs = require("fs"), os = require("os"), path = require("path"), {pathToFileURL} = require("url");
const {DatabaseSync} = require("node:sqlite");

/* Mini-Adapter: bildet die D1-API (prepare/bind/first/run) auf node:sqlite ab */
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
  let r = await call("POST", "/game", jbody({dur: 10}));
  ok(r.status === 201, "Anlegen → 201");
  const g1 = await r.json();
  ok(/^\d{6}$/.test(g1.code), "6-stelliger Code");
  ok(+g1.code % 3 === 1, "Code kodiert Dauer (10 Min → %3 == 1)");
  ok(g1.dur === 10 && typeof g1.token === "string" && g1.token.length >= 16, "dur + Ersteller-Token");
  const stored = db._db.prepare("SELECT * FROM games WHERE code = ?").get(g1.code);
  ok(Number.isInteger(stored.seed) && stored.seed >= 0 && stored.seed <= 0xFFFFFFFF, "Seed ist uint32");

  ok((await call("POST", "/game", jbody({dur: 7}))).status === 400, "ungültige Dauer → 400");
  ok((await call("POST", "/game", "kein json")).status === 400, "kaputtes JSON → 400");

  // ---- Zustand vor Beitritt/Start: Seed bleibt geheim ----
  r = await call("GET", "/game/" + g1.code);
  let st = await r.json();
  ok(st.joined === false && st.startAt === null && !("seed" in st), "Seed vor Start unsichtbar");

  // ---- Start vor Beitritt verboten; falsches Token verboten ----
  ok((await call("POST", `/game/${g1.code}/start`, jbody({token: g1.token}))).status === 409, "Start ohne Gegner → 409");
  ok((await call("POST", `/game/${g1.code}/start`, jbody({token: "falsch"}))).status === 403, "Start mit falschem Token → 403");

  // ---- Beitritt (atomar) ----
  r = await call("POST", `/game/${g1.code}/join`);
  const j = await r.json();
  ok(r.status === 200 && j.dur === 10 && j.token && j.token !== g1.token, "Beitritt → eigenes Token + Dauer");
  ok((await call("POST", `/game/${g1.code}/join`)).status === 409, "zweiter Beitritt → 409");
  st = await (await call("GET", "/game/" + g1.code)).json();
  ok(st.joined === true && !("seed" in st), "beigetreten sichtbar, Seed weiter geheim");

  // ---- Doppel-Beitritt im Rennen: genau EINER gewinnt (bedingtes UPDATE) ----
  const g3 = await (await call("POST", "/game", jbody({dur: 15}))).json();
  const [ra, rb] = await Promise.all([
    call("POST", `/game/${g3.code}/join`),
    call("POST", `/game/${g3.code}/join`),
  ]);
  ok([ra.status, rb.status].sort().join(",") === "200,409", "gleichzeitiger Doppel-Beitritt → genau ein 200");

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

  // ---- Ergebnisse: Token-geschützt, write-once, Format-/Größenlimits ----
  const res1 = "SPCX5." + "A".repeat(80);
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": j.token})).status === 403, "fremdes Token → 403");
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": g1.token})).status === 201, "eigenes Ergebnis → 201");
  ok((await call("PUT", `/game/${g1.code}/result/1`, res1, {"x-token": g1.token})).status === 409, "write-once → 409");
  ok((await call("PUT", `/game/${g1.code}/result/2`, "SPCX4.alt", {"x-token": j.token})).status === 400, "falsches Präfix → 400");
  ok((await call("PUT", `/game/${g1.code}/result/2`, "SPCX5." + "B".repeat(700), {"x-token": j.token})).status === 400, "zu groß → 400");
  ok((await call("GET", `/game/${g1.code}/result/2`)).status === 404, "fehlendes Ergebnis → 404");
  await call("PUT", `/game/${g1.code}/result/2`, "SPCX5.zwei", {"x-token": j.token});
  ok(await (await call("GET", `/game/${g1.code}/result/1`)).text() === res1, "Gegner-Ergebnis abholbar");

  // ---- Verfall: >24 h alte Spiele sind unbekannt und werden beim Anlegen gelöscht ----
  db._db.prepare("UPDATE games SET created = ? WHERE code = ?").run(Date.now() - 25*3600*1000, g3.code);
  ok((await call("GET", "/game/" + g3.code)).status === 404, "abgelaufenes Spiel → 404");
  await call("POST", "/game", jbody({dur: 5})); // Anlegen räumt auf
  ok(db._db.prepare("SELECT COUNT(*) AS n FROM games WHERE code = ?").get(g3.code).n === 0, "Aufräumen löscht Verfallenes");

  // ---- Routing/CORS ----
  ok((await call("GET", "/game/000001")).status === 404, "unbekanntes Spiel → 404");
  ok((await call("GET", "/game/abc")).status === 400, "kaputter Code → 400");
  ok((await call("DELETE", "/game/" + g1.code)).status === 405, "falsche Methode → 405");
  ok((await call("GET", "/quatsch")).status === 404, "unbekannter Pfad → 404");
  r = await call("OPTIONS", "/game");
  ok(r.status === 204 && r.headers.get("access-control-allow-origin") === "*", "CORS-Preflight");
  ok((await call("GET", "/game/" + g1.code)).headers.get("access-control-allow-origin") === "*", "CORS auf Antworten");

  // ---- zweites Spiel: eigener Code, eigener Seed ----
  const g2 = await (await call("POST", "/game", jbody({dur: 5}))).json();
  ok(g2.code !== g1.code && +g2.code % 3 === 0, "zweites Spiel: eigener Code, Dauer kodiert");
  ok(db._db.prepare("SELECT seed FROM games WHERE code = ?").get(g2.code).seed !== stored.seed, "eigener Seed");

  console.log(failed ? `\n${failed} FEHLER (${passed} ok)` : `\nALLE ${passed} TESTS OK`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Test-Harness-Fehler:", e); process.exit(1); });
