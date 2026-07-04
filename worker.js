/* SPCX Trading-Duell – Cloudflare Worker (Online-Stufe 1, Speicher: D1)
   Mini-API für: echte Lobby (Beitritt + Start durch den Ersteller), geheimen
   Markt-Seed (wird erst mit fixiertem Start verraten → niemand kann vorspielen)
   und den automatischen Ergebnis-Austausch (write-once, Token-geschützt).

   Einrichtung (einmalig, Cloudflare-Dashboard):
   - D1-Datenbank anlegen (Storage & Databases → D1, Name z. B. „spcx-duell-db").
   - Im Worker unter Settings → Bindings → „D1 database" mit Variablenname DB verbinden.
   - Diesen Code unter „Edit code" einfügen, Deploy. (Tabellen legt der Code selbst an.)

   Warum D1 statt KV: KV cached Lesezugriffe je Standort bis zu 60 s – zwei Geräte in
   verschiedenen Netzen (WLAN/Mobilfunk) sahen Beitritt/Start/Ergebnis darum bis zu einer
   Minute versetzt. D1 ist stark konsistent (jede Änderung sofort überall sichtbar) und
   macht Beitritt/Ergebnis per bedingtem UPDATE/INSERT zusätzlich atomar (keine Races).

   Endpunkte (alle JSON außer result-GET; CORS offen, da öffentliche Spiel-API):
     POST /game {dur:5|10|15}        → {code, dur, token}   Spiel anlegen (token = Ersteller)
     POST /game/{code}/join          → {dur, token}         Beitritt (einmalig, atomar)
     POST /game/{code}/start {token} → {startAt, seed}      nur Ersteller, idempotent
     GET  /game/{code}               → {joined, dur, startAt, seed?}  (seed erst ab startAt)
     PUT  /game/{code}/result/{p}    → 201                  Header x-token, Body SPCX5.…, write-once
     GET  /game/{code}/result/{p}    → Text | 404

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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {status, headers: {...CORS, "content-type": "application/json"}});
const err = (status, msg) => json({error: msg}, status);

const rndInt = max => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max; };
const rndToken = () => { const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); };

/* Tabellen einmal je Isolate sicherstellen (CREATE IF NOT EXISTS ist billig & idempotent) */
let schemaReady = false;
async function ensureSchema(db){
  if(schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS games(
    code TEXT PRIMARY KEY, seed INTEGER, dur INTEGER, created INTEGER,
    t1 TEXT, t2 TEXT, joined INTEGER DEFAULT 0, startAt INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS results(
    code TEXT, p INTEGER, body TEXT, created INTEGER, PRIMARY KEY(code, p))`).run();
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

  // POST /game → Spiel anlegen; der geheime Seed bleibt beim Server
  if(parts.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const durIdx = DURS.indexOf(body && body.dur);
    if(durIdx < 0) return err(400, "dur");
    // abgelaufene Spiele bei der Gelegenheit aufräumen
    await db.prepare("DELETE FROM results WHERE created < ?").bind(now - TTL_MS).run();
    await db.prepare("DELETE FROM games WHERE created < ?").bind(now - TTL_MS).run();
    const seedBuf = new Uint32Array(1); crypto.getRandomValues(seedBuf);
    const t1 = rndToken();
    for(let i = 0; i < 8; i++){
      // Konvention wie im Spiel: code % 3 = Dauer-Index
      let c = 100000 + rndInt(900000);
      c -= c % 3; c += durIdx; if(c > 999999) c -= 3;
      const r = await db.prepare(
        `INSERT INTO games(code, seed, dur, created, t1) VALUES(?,?,?,?,?)
         ON CONFLICT(code) DO NOTHING`)
        .bind(String(c), seedBuf[0], DURS[durIdx], now, t1).run();
      if(r.meta.changes === 1) return json({code: String(c), dur: DURS[durIdx], token: t1}, 201);
    }
    return err(500, "no free code");
  }

  const code = parts[1];
  if(!/^\d{6}$/.test(code)) return err(400, "code");
  const g = await db.prepare("SELECT * FROM games WHERE code = ? AND created >= ?")
                    .bind(code, now - TTL_MS).first();
  if(!g) return err(404, "unknown game");
  const rest = parts.slice(2);

  // GET /game/{code} → öffentlicher Zustand; seed ERST wenn der Start fixiert ist
  if(rest.length === 0){
    if(req.method !== "GET") return err(405, "method");
    const out = {joined: !!g.joined, dur: g.dur, startAt: g.startAt};
    if(g.startAt) out.seed = g.seed;
    return json(out);
  }

  // Beitritt: bedingtes UPDATE = atomar, es gewinnt garantiert genau ein Beitritt
  if(rest[0] === "join" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const t2 = rndToken();
    const r = await db.prepare("UPDATE games SET joined = 1, t2 = ? WHERE code = ? AND joined = 0")
                      .bind(t2, code).run();
    if(r.meta.changes !== 1) return err(409, "already joined");
    return json({dur: g.dur, token: t2});
  }

  // Nur der Ersteller startet; bedingtes UPDATE hält es idempotent und race-frei
  if(rest[0] === "start" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    if(!body || body.token !== g.t1) return err(403, "token");
    if(!g.joined) return err(409, "not joined");
    await db.prepare("UPDATE games SET startAt = ? WHERE code = ? AND startAt IS NULL")
            .bind(now + START_DELAY_MS, code).run();
    const cur = await db.prepare("SELECT startAt, seed FROM games WHERE code = ?").bind(code).first();
    return json({startAt: cur.startAt, seed: cur.seed});
  }

  if(rest[0] === "result" && rest.length === 2){
    const p = rest[1];
    if(p !== "1" && p !== "2") return err(400, "player");
    if(req.method === "GET"){
      const r = await db.prepare("SELECT body FROM results WHERE code = ? AND p = ?")
                        .bind(code, +p).first();
      return r ? new Response(r.body, {status: 200, headers: {...CORS, "content-type": "text/plain"}})
               : err(404, "no result");
    }
    if(req.method === "PUT"){
      if(req.headers.get("x-token") !== (p === "1" ? g.t1 : g.t2)) return err(403, "token");
      const body = (await req.text()).trim();
      if(body.length > 600 || !body.startsWith("SPCX5.")) return err(400, "payload");
      // INSERT mit Primärschlüssel(code,p) = write-once, atomar
      const r = await db.prepare(
        `INSERT INTO results(code, p, body, created) VALUES(?,?,?,?)
         ON CONFLICT(code, p) DO NOTHING`)
        .bind(code, +p, body, now).run();
      if(r.meta.changes !== 1) return err(409, "write-once");
      return json({ok: true}, 201);
    }
    return err(405, "method");
  }

  return err(404, "not found");
}
