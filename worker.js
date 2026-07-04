/* SPCX Trading-Duell – Cloudflare Worker (Online-Stufe 1)
   Mini-API für: echte Lobby (Beitritt + Start durch den Ersteller), geheimen
   Markt-Seed (wird erst mit fixiertem Start verraten → niemand kann vorspielen)
   und den automatischen Ergebnis-Austausch (write-once, Token-geschützt).

   Einrichtung (einmalig, Cloudflare-Dashboard):
   - Worker anlegen, diesen Code unter „Edit code" einfügen, Deploy.
   - KV-Namespace „SPCX_GAMES" als Binding mit Variablenname GAMES verbinden.

   Endpunkte (alle JSON außer result-GET; CORS offen, da öffentliche Spiel-API):
     POST /game {dur:5|10|15}        → {code, dur, token}   Spiel anlegen (token = Ersteller)
     POST /game/{code}/join          → {dur, token}         Beitritt (einmalig)
     POST /game/{code}/start {token} → {startAt, seed}      nur Ersteller, idempotent
     GET  /game/{code}               → {joined, dur, startAt, seed?}  (seed erst ab startAt)
     PUT  /game/{code}/result/{p}    → 201                  Header x-token, Body SPCX5.…, write-once
     GET  /game/{code}/result/{p}    → Text | 404

   Alle Einträge verfallen nach 24 h (expirationTtl) – räumt sich selbst auf.
   Warum „Start nur durch den Ersteller": KV ist eventually consistent; ein einziger
   Schreiber für startAt/seed vermeidet Schreib-Rennen zweier „bereit"-Signale. */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-token",
};
const TTL = 86400;            // 24 h
const DURS = [5, 10, 15];     // erlaubte Spieldauern (Minuten)
const START_DELAY_MS = 10000; // Puffer zwischen Start-Klick und Rundenbeginn

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {status, headers: {...CORS, "content-type": "application/json"}});
const err = (status, msg) => json({error: msg}, status);

const rndInt = max => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max; };
const rndToken = () => { const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); };

/* Freien 6-stelligen Beitritts-Code würfeln. Konvention wie im Spiel: code % 3 = Dauer-Index,
   damit auch ein (fälschlich) offline beitretendes Gerät wenigstens die richtige Dauer spielt. */
async function newCode(kv, durIdx){
  for(let i = 0; i < 8; i++){
    let c = 100000 + rndInt(900000);
    c -= c % 3; c += durIdx; if(c > 999999) c -= 3;
    if(!(await kv.get("g:" + c))) return String(c);
  }
  throw new Error("no free code");
}

async function readJson(req){ try{ return await req.json(); }catch(e){ return null; } }

export default {
  async fetch(req, env){
    if(req.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
    try{ return await route(req, env.GAMES); }
    catch(e){ return err(500, "server"); }
  }
};

async function route(req, kv){
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  if(parts[0] !== "game") return err(404, "not found");

  // POST /game → Spiel anlegen; der geheime Seed bleibt beim Server
  if(parts.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const durIdx = DURS.indexOf(body && body.dur);
    if(durIdx < 0) return err(400, "dur");
    const code = await newCode(kv, durIdx);
    const seed = new Uint32Array(1); crypto.getRandomValues(seed);
    const g = {seed: seed[0], dur: DURS[durIdx], created: Date.now(),
               t1: rndToken(), joined: false, t2: null, startAt: null};
    await kv.put("g:" + code, JSON.stringify(g), {expirationTtl: TTL});
    return json({code, dur: g.dur, token: g.t1}, 201);
  }

  const code = parts[1];
  if(!/^\d{6}$/.test(code)) return err(400, "code");
  const raw = await kv.get("g:" + code);
  if(!raw) return err(404, "unknown game");
  const g = JSON.parse(raw);
  const rest = parts.slice(2);

  // GET /game/{code} → öffentlicher Zustand; seed ERST wenn der Start fixiert ist
  if(rest.length === 0){
    if(req.method !== "GET") return err(405, "method");
    const out = {joined: g.joined, dur: g.dur, startAt: g.startAt};
    if(g.startAt) out.seed = g.seed;
    return json(out);
  }

  if(rest[0] === "join" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    if(g.joined) return err(409, "already joined");
    g.joined = true; g.t2 = rndToken();
    await kv.put("g:" + code, JSON.stringify(g), {expirationTtl: TTL});
    return json({dur: g.dur, token: g.t2});
  }

  // Nur der Ersteller startet (einziger Schreiber für startAt/seed – kein KV-Schreibrennen)
  if(rest[0] === "start" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    if(!body || body.token !== g.t1) return err(403, "token");
    if(!g.joined) return err(409, "not joined");
    if(!g.startAt){ // idempotent: erneuter Aufruf liefert denselben Start
      g.startAt = Date.now() + START_DELAY_MS;
      await kv.put("g:" + code, JSON.stringify(g), {expirationTtl: TTL});
    }
    return json({startAt: g.startAt, seed: g.seed});
  }

  if(rest[0] === "result" && rest.length === 2){
    const p = rest[1];
    if(p !== "1" && p !== "2") return err(400, "player");
    const key = "r:" + code + ":" + p;
    if(req.method === "GET"){
      const r = await kv.get(key);
      return r === null ? err(404, "no result")
        : new Response(r, {status: 200, headers: {...CORS, "content-type": "text/plain"}});
    }
    if(req.method === "PUT"){
      if(req.headers.get("x-token") !== (p === "1" ? g.t1 : g.t2)) return err(403, "token");
      const body = (await req.text()).trim();
      if(body.length > 600 || !body.startsWith("SPCX5.")) return err(400, "payload");
      if(await kv.get(key) !== null) return err(409, "write-once");
      await kv.put(key, body, {expirationTtl: TTL});
      return json({ok: true}, 201);
    }
    return err(405, "method");
  }

  return err(404, "not found");
}
