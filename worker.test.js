/* Tests für worker.js (Online-Stufe 1). Ausführen mit:  node worker.test.js
   Braucht nur Node ≥ 18 (fetch-API + WebCrypto eingebaut), keine Abhängigkeiten.
   KV wird als Map simuliert; getestet wird der echte fetch-Handler. */
const fs = require("fs"), os = require("os"), path = require("path"), {pathToFileURL} = require("url");

function kvStub(){
  const m = new Map(), ttls = [];
  return {
    m, ttls,
    async get(k){ return m.has(k) ? m.get(k) : null; },
    async put(k, v, opts){ m.set(k, v); ttls.push(opts && opts.expirationTtl); },
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

  const kv = kvStub(), env = {GAMES: kv};
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
  ok(kv.ttls.every(t => t === 86400), "TTL 24 h gesetzt");
  const stored = JSON.parse(kv.m.get("g:" + g1.code));
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

  // ---- Beitritt ----
  r = await call("POST", `/game/${g1.code}/join`);
  const j = await r.json();
  ok(r.status === 200 && j.dur === 10 && j.token && j.token !== g1.token, "Beitritt → eigenes Token + Dauer");
  ok((await call("POST", `/game/${g1.code}/join`)).status === 409, "zweiter Beitritt → 409");
  st = await (await call("GET", "/game/" + g1.code)).json();
  ok(st.joined === true && !("seed" in st), "beigetreten sichtbar, Seed weiter geheim");

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

  // ---- Routing/CORS ----
  ok((await call("GET", "/game/000001")).status === 404, "unbekanntes Spiel → 404");
  ok((await call("GET", "/game/abc")).status === 400, "kaputter Code → 400");
  ok((await call("DELETE", "/game/" + g1.code)).status === 405, "falsche Methode → 405");
  ok((await call("GET", "/quatsch")).status === 404, "unbekannter Pfad → 404");
  r = await call("OPTIONS", "/game");
  ok(r.status === 204 && r.headers.get("access-control-allow-origin") === "*", "CORS-Preflight");
  ok((await call("GET", "/game/" + g1.code)).headers.get("access-control-allow-origin") === "*", "CORS auf Antworten");

  // ---- zweites Spiel: anderer Code, anderer Seed ----
  const g2 = await (await call("POST", "/game", jbody({dur: 5}))).json();
  ok(g2.code !== g1.code && +g2.code % 3 === 0, "zweites Spiel: eigener Code, Dauer kodiert");
  ok(JSON.parse(kv.m.get("g:" + g2.code)).seed !== stored.seed, "eigener Seed");

  console.log(failed ? `\n${failed} FEHLER (${passed} ok)` : `\nALLE ${passed} TESTS OK`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("Test-Harness-Fehler:", e); process.exit(1); });
