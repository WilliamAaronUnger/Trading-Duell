/* SPCX Trading-Duell – Cloudflare Worker (Online-Duell für 2–8 Spieler, Speicher: D1)
   Mini-API für: echte Lobby (Beitritte + Start durch den Ersteller), geheimen
   Markt-Seed (wird erst mit fixiertem Start verraten → niemand kann vorspielen)
   und den automatischen Ergebnis-Austausch (write-once, Token-geschützt).

   Einrichtung (einmalig, Cloudflare-Dashboard):
   - D1-Datenbank anlegen (Storage & Databases → D1, Name z. B. „spcx-duell-db").
   - Im Worker unter Settings → Bindings → „D1 database" mit Variablenname DB verbinden.
   - Diesen Code unter „Edit code" einfügen, Deploy. (Tabellen legt der Code selbst an.)

   Warum D1 statt KV: KV cached Lesezugriffe je Standort bis zu 60 s – Geräte in
   verschiedenen Netzen sahen Beitritt/Start/Ergebnis darum bis zu einer Minute versetzt.
   D1 ist stark konsistent und macht Beitritt/Platzvergabe/Ergebnis atomar.

   Endpunkte (alle JSON außer result-GET; CORS offen, da öffentliche Spiel-API):
     POST /game {dur:5|10|15, name?}   → {code, dur, token}        Spiel anlegen (Ersteller = Spieler 1)
     POST /game/{code}/join {name?}    → {dur, token, p}           Beitritt (Platz 2–8, atomar; nach Start: 409)
     POST /game/{code}/start {token}   → {startAt, seed}           nur Ersteller, ab 2 Spielern, idempotent
     GET  /game/{code}                 → {dur, startAt, players:[{p,name}], joined, seed?}
                                          (seed erst ab startAt; joined = ≥2 – Kompatibilität für alte App-Versionen)
     PUT  /game/{code}/result/{p}      → 201                       Header x-token, Body SPCX5.…, write-once
     GET  /game/{code}/result/{p}      → Text | 404
     PUT  /game/{code}/pnl/{p} {pnl}   → 200                       Live-Rennen: eigenen P&L melden (x-token, erst nach Start)
     GET  /game/{code}/pnl             → {pnls:{p:v,…}}            Live-Rennen: alle P&L abholen

   Einträge älter als 24 h gelten als abgelaufen und werden beim Anlegen neuer Spiele
   gelöscht – räumt sich selbst auf. */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-token",
};
const TTL_MS = 24 * 3600 * 1000; // 24 h
const DURS = [5, 10, 15];        // erlaubte Spieldauern (Minuten)
const START_DELAY_MS = 10000;    // Puffer zwischen Start-Klick und Rundenbeginn
const MAX_PLAYERS = 8;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {status, headers: {...CORS, "content-type": "application/json"}});
const err = (status, msg) => json({error: msg}, status);

const rndInt = max => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max; };
const rndToken = () => { const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); };
const cleanName = n => (typeof n === "string" ? n : "").trim().slice(0, 14);

/* Tabellen einmal je Isolate sicherstellen (CREATE IF NOT EXISTS ist billig & idempotent) */
let schemaReady = false;
async function ensureSchema(db){
  if(schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS games(
    code TEXT PRIMARY KEY, seed INTEGER, dur INTEGER, created INTEGER, startAt INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS players(
    code TEXT, p INTEGER, token TEXT, name TEXT, PRIMARY KEY(code, p))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS results(
    code TEXT, p INTEGER, body TEXT, created INTEGER, PRIMARY KEY(code, p))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS pnl(
    code TEXT, p INTEGER, v REAL, t INTEGER, PRIMARY KEY(code, p))`).run();
  schemaReady = true;
}

async function readJson(req){ try{ return await req.json(); }catch(e){ return null; } }

export default {
  async fetch(req, env){
    if(req.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
    try{
      await ensureSchema(env.DB);
      return await route(req, env.DB);
    }catch(e){ return err(500, "server"); }
  }
};

async function route(req, db){
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  if(parts[0] !== "game") return err(404, "not found");
  const now = Date.now();

  // POST /game → Spiel anlegen; der geheime Seed bleibt beim Server, Ersteller = Spieler 1
  if(parts.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const durIdx = DURS.indexOf(body && body.dur);
    if(durIdx < 0) return err(400, "dur");
    // abgelaufene Spiele bei der Gelegenheit aufräumen
    const cut = now - TTL_MS;
    await db.prepare("DELETE FROM results WHERE created < ?").bind(cut).run();
    await db.prepare("DELETE FROM pnl WHERE code IN (SELECT code FROM games WHERE created < ?)").bind(cut).run();
    await db.prepare("DELETE FROM players WHERE code IN (SELECT code FROM games WHERE created < ?)").bind(cut).run();
    await db.prepare("DELETE FROM games WHERE created < ?").bind(cut).run();
    const seedBuf = new Uint32Array(1); crypto.getRandomValues(seedBuf);
    const t1 = rndToken();
    for(let i = 0; i < 8; i++){
      // Konvention wie im Spiel: code % 3 = Dauer-Index
      let c = 100000 + rndInt(900000);
      c -= c % 3; c += durIdx; if(c > 999999) c -= 3;
      const r = await db.prepare(
        `INSERT INTO games(code, seed, dur, created) VALUES(?,?,?,?)
         ON CONFLICT(code) DO NOTHING`)
        .bind(String(c), seedBuf[0], DURS[durIdx], now).run();
      if(r.meta.changes === 1){
        await db.prepare("INSERT INTO players(code, p, token, name) VALUES(?,1,?,?)")
                .bind(String(c), t1, cleanName(body.name) || "Spieler 1").run();
        return json({code: String(c), dur: DURS[durIdx], token: t1}, 201);
      }
    }
    return err(500, "no free code");
  }

  const code = parts[1];
  if(!/^\d{6}$/.test(code)) return err(400, "code");
  const g = await db.prepare("SELECT * FROM games WHERE code = ? AND created >= ?")
                    .bind(code, now - TTL_MS).first();
  if(!g) return err(404, "unknown game");
  const rest = parts.slice(2);
  const playerToken = async p =>
    (await db.prepare("SELECT token FROM players WHERE code = ? AND p = ?").bind(code, p).first() || {}).token;

  // GET /game/{code} → öffentlicher Zustand; seed ERST wenn der Start fixiert ist
  if(rest.length === 0){
    if(req.method !== "GET") return err(405, "method");
    const pl = (await db.prepare("SELECT p, name FROM players WHERE code = ? ORDER BY p").bind(code).all()).results;
    const out = {dur: g.dur, startAt: g.startAt, players: pl, joined: pl.length >= 2};
    if(g.startAt) out.seed = g.seed;
    return json(out);
  }

  // Beitritt: nächsten freien Platz atomar belegen (PK-Konflikt → kurze Wiederholung)
  if(rest[0] === "join" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    if(g.startAt) return err(409, "started"); // nach dem Start kommt niemand mehr rein
    const body = await readJson(req);
    const tok = rndToken();
    for(let i = 0; i < 3; i++){
      const nxt = (await db.prepare("SELECT COALESCE(MAX(p),1)+1 AS p FROM players WHERE code = ?")
                           .bind(code).first()).p;
      if(nxt > MAX_PLAYERS) return err(409, "full");
      const r = await db.prepare(
        `INSERT INTO players(code, p, token, name) VALUES(?,?,?,?) ON CONFLICT(code, p) DO NOTHING`)
        .bind(code, nxt, tok, cleanName(body && body.name) || ("Spieler " + nxt)).run();
      if(r.meta.changes === 1) return json({dur: g.dur, token: tok, p: nxt});
    }
    return err(409, "busy");
  }

  // Nur der Ersteller (Spieler 1) startet, ab 2 Spielern; idempotent und race-frei
  if(rest[0] === "start" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    if(!body || body.token !== await playerToken(1)) return err(403, "token");
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM players WHERE code = ?").bind(code).first()).n;
    if(n < 2) return err(409, "not joined");
    await db.prepare("UPDATE games SET startAt = ? WHERE code = ? AND startAt IS NULL")
            .bind(now + START_DELAY_MS, code).run();
    const cur = await db.prepare("SELECT startAt, seed FROM games WHERE code = ?").bind(code).first();
    return json({startAt: cur.startAt, seed: cur.seed});
  }

  // Live-Rennen: P&L melden/abholen – reine Anzeige-Daten, klein und überschreibbar
  if(rest[0] === "pnl"){
    if(rest.length === 1){
      if(req.method !== "GET") return err(405, "method");
      const rows = (await db.prepare("SELECT p, v FROM pnl WHERE code = ?").bind(code).all()).results;
      const pnls = {};
      for(const r of rows) pnls[r.p] = r.v;
      return json({pnls});
    }
    if(rest.length === 2){
      if(req.method !== "PUT") return err(405, "method");
      const p = +rest[1];
      if(!Number.isInteger(p) || p < 1 || p > MAX_PLAYERS) return err(400, "player");
      const tok = await playerToken(p);
      if(!tok || req.headers.get("x-token") !== tok) return err(403, "token");
      if(!g.startAt) return err(409, "not started"); // Rennen gibt es erst ab dem Start
      const body = await readJson(req);
      const v = body && +body.pnl;
      if(!Number.isFinite(v) || Math.abs(v) > 1e7) return err(400, "pnl");
      await db.prepare(
        `INSERT INTO pnl(code, p, v, t) VALUES(?,?,?,?)
         ON CONFLICT(code, p) DO UPDATE SET v = excluded.v, t = excluded.t`)
        .bind(code, p, Math.round(v * 100) / 100, now).run();
      return json({ok: true});
    }
    return err(404, "not found");
  }

  if(rest[0] === "result" && rest.length === 2){
    const p = +rest[1];
    if(!Number.isInteger(p) || p < 1 || p > MAX_PLAYERS) return err(400, "player");
    if(req.method === "GET"){
      const r = await db.prepare("SELECT body FROM results WHERE code = ? AND p = ?").bind(code, p).first();
      return r ? new Response(r.body, {status: 200, headers: {...CORS, "content-type": "text/plain"}})
               : err(404, "no result");
    }
    if(req.method === "PUT"){
      const tok = await playerToken(p);
      if(!tok || req.headers.get("x-token") !== tok) return err(403, "token");
      const body = (await req.text()).trim();
      if(body.length > 600 || !body.startsWith("SPCX5.")) return err(400, "payload");
      // INSERT mit Primärschlüssel(code,p) = write-once, atomar
      const r = await db.prepare(
        `INSERT INTO results(code, p, body, created) VALUES(?,?,?,?) ON CONFLICT(code, p) DO NOTHING`)
        .bind(code, p, body, now).run();
      if(r.meta.changes !== 1) return err(409, "write-once");
      return json({ok: true}, 201);
    }
    return err(405, "method");
  }

  return err(404, "not found");
}
