/* Trading Duell – Cloudflare Worker v3: der Online-RAUM (Speicher: D1)
   Ein Raum ist der Treffpunkt für den Abend: Mitglieder treten EINMAL bei (QR/Code),
   sind mit Anwesenheit sichtbar und wählen ihre Rolle (🎮 Spieler / 🖥️ Leinwand).
   Der Ersteller startet Runde um Runde – jede mit frischem, geheimem Markt-Seed und
   wählbarer Dauer. Ergebnisse laufen je Runde ein; der Raum führt die Abend-Wertung
   (Rundensiege + Gesamt-P&L). Details/Entscheidungen: RAUM-PLAN.md.

   Einrichtung wie gehabt: D1-Binding `DB`; Deploy automatisch per Git-Integration.

   Design-Notizen:
   - EIN Aggregat-GET liefert alles (Mitglieder, Runde, Live-P&L, Ergebnisse, Wertung)
     → der Datenverkehr pro Gerät bleibt konstant, egal ob 2 oder 20 mitspielen.
   - Seed-Geheimnis: der Seed einer Runde entsteht erst beim Start-Befehl und wird mit
     bereits fixiertem startAt (+10 s) veröffentlicht – kein Vorspiel-Fenster.
   - Räume verfallen 24 h nach der letzten Aktivität (lastActive); Aufräumen beim Eröffnen.
   - v3 ersetzt die alte /game-API vollständig; deren Tabellen werden entsorgt. Alte
     App-Versionen fallen dadurch sauber auf ihren Offline-Modus zurück.

   Endpunkte (JSON; CORS offen, da öffentliche Spiel-API):
     POST /room {name}                          → {code, token, p:1, dur}
     POST /room/{code}/join {name, role?}       → {token, p, dur}   (auch während laufender Runde;
                                                   role "wall" umgeht das Spielerlimit)
     POST /room/{code}/role {token, role}       → {ok, role}        (player|wall; Limit-geprüft)
     POST /room/{code}/start {token, dur?}      → {n, startAt, seed} (nur Ersteller, ≥2 Spieler,
                                                   nicht während laufender Runde; dur wird neuer Standard)
     GET  /room/{code}?me={token}               → Aggregat {dur, curRound, members, round, pnls,
                                                   results, scoreboard}; me = Anwesenheits-Herzschlag
     PUT  /room/{code}/round/{n}/result/{p}?pnl=X → 201  (x-token, write-once, SPCX5.…, ≤600)
     PUT  /room/{code}/round/{n}/pnl/{p} {pnl}  → 200   (x-token, überschreibbar) */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type,x-token",
};
const TTL_MS = 24 * 3600 * 1000;  // Raum verfällt 24 h nach letzter Aktivität
const ONLINE_MS = 15000;          // "gerade da" = Herzschlag jünger als 15 s
const DURS = [5, 10, 15];         // erlaubte Rundendauern (Minuten)
const START_DELAY_MS = 10000;     // Puffer zwischen Start-Befehl und Rundenbeginn
const MAX_PLAYERS = 20;           // Spieler-Rollen je Raum (Leinwände zählen nicht)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {status, headers: {...CORS, "content-type": "application/json"}});
const err = (status, msg) => json({error: msg}, status);

const rndInt = max => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max; };
const rndSeed = () => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0]; };
const rndToken = () => { const b = new Uint8Array(12); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join(""); };
const cleanName = n => (typeof n === "string" ? n : "").trim().slice(0, 14);

/* Tabellen einmal je Isolate sicherstellen; Altlasten der /game-API entsorgen */
let schemaReady = false;
async function ensureSchema(db){
  if(schemaReady) return;
  for(const t of ["games", "players", "results", "pnl"]) // v2-Tabellen (inkompatible Form)
    await db.prepare("DROP TABLE IF EXISTS " + t).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS rooms(
    code TEXT PRIMARY KEY, created INTEGER, lastActive INTEGER, dur INTEGER, curRound INTEGER DEFAULT 0)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS members(
    code TEXT, p INTEGER, token TEXT, name TEXT, role TEXT, lastSeen INTEGER, PRIMARY KEY(code, p))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS rounds(
    code TEXT, n INTEGER, seed INTEGER, dur INTEGER, startAt INTEGER, PRIMARY KEY(code, n))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS roundResults(
    code TEXT, n INTEGER, p INTEGER, body TEXT, pnlFinal REAL, created INTEGER, PRIMARY KEY(code, n, p))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS roundPnl(
    code TEXT, n INTEGER, p INTEGER, v REAL, t INTEGER, PRIMARY KEY(code, n, p))`).run();
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

/* Abend-Wertung aus allen Runden-Ergebnissen: Sieg = höchster P&L der Runde */
async function scoreboard(db, code){
  const rows = (await db.prepare("SELECT n, p, pnlFinal FROM roundResults WHERE code = ?")
                        .bind(code).all()).results;
  const byRound = {}, sb = {};
  for(const r of rows) (byRound[r.n] = byRound[r.n] || []).push(r);
  for(const n in byRound){
    let best = null;
    for(const r of byRound[n]){
      const s = sb[r.p] = sb[r.p] || {p: r.p, wins: 0, total: 0, rounds: 0};
      s.total = Math.round((s.total + r.pnlFinal) * 100) / 100;
      s.rounds++;
      if(best === null || r.pnlFinal > best.pnlFinal) best = r;
    }
    if(best) sb[best.p].wins++;
  }
  return Object.values(sb);
}

async function route(req, db){
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if(parts[0] !== "room") return err(404, "not found");
  const now = Date.now();

  // POST /room → Raum eröffnen (Ersteller = Mitglied 1, Rolle Spieler)
  if(parts.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    // verfallene Räume samt Anhang aufräumen
    const cut = now - TTL_MS;
    for(const t of ["roundPnl", "roundResults", "rounds", "members"])
      await db.prepare(`DELETE FROM ${t} WHERE code IN (SELECT code FROM rooms WHERE lastActive < ?)`)
              .bind(cut).run();
    await db.prepare("DELETE FROM rooms WHERE lastActive < ?").bind(cut).run();
    const token = rndToken();
    for(let i = 0; i < 8; i++){
      const c = String(100000 + rndInt(900000));
      const r = await db.prepare(
        `INSERT INTO rooms(code, created, lastActive, dur, curRound) VALUES(?,?,?,10,0)
         ON CONFLICT(code) DO NOTHING`).bind(c, now, now).run();
      if(r.meta.changes === 1){
        await db.prepare("INSERT INTO members(code, p, token, name, role, lastSeen) VALUES(?,1,?,?,'player',?)")
                .bind(c, token, cleanName(body && body.name) || "Spieler 1", now).run();
        return json({code: c, token, p: 1, dur: 10}, 201);
      }
    }
    return err(500, "no free code");
  }

  const code = parts[1];
  if(!/^\d{6}$/.test(code)) return err(400, "code");
  const room = await db.prepare("SELECT * FROM rooms WHERE code = ? AND lastActive >= ?")
                       .bind(code, now - TTL_MS).first();
  if(!room) return err(404, "unknown room");
  const rest = parts.slice(2);
  const memberByToken = async tok =>
    db.prepare("SELECT p, role FROM members WHERE code = ? AND token = ?").bind(code, String(tok || "")).first();
  const playerCount = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM members WHERE code = ? AND role = 'player'").bind(code).first()).n;
  const touch = () => db.prepare("UPDATE rooms SET lastActive = ? WHERE code = ?").bind(now, code).run();

  // GET /room/{code}?me=… → das eine Aggregat (Poll = Herzschlag)
  if(rest.length === 0){
    if(req.method !== "GET") return err(405, "method");
    const me = url.searchParams.get("me");
    if(me){
      const r = await db.prepare("UPDATE members SET lastSeen = ? WHERE code = ? AND token = ?")
                        .bind(now, code, me).run();
      if(r.meta.changes === 1) await touch();
    }
    const members = (await db.prepare("SELECT p, name, role, lastSeen FROM members WHERE code = ? ORDER BY p")
                             .bind(code).all()).results
      .map(m => ({p: m.p, name: m.name, role: m.role, online: now - m.lastSeen < ONLINE_MS}));
    const out = {dur: room.dur, curRound: room.curRound, members, round: null, pnls: {}, results: {},
                 scoreboard: await scoreboard(db, code)};
    if(room.curRound > 0){
      const rd = await db.prepare("SELECT n, dur, startAt, seed FROM rounds WHERE code = ? AND n = ?")
                         .bind(code, room.curRound).first();
      if(rd){
        out.round = {n: rd.n, dur: rd.dur, startAt: rd.startAt, seed: rd.seed};
        for(const r of (await db.prepare("SELECT p, v FROM roundPnl WHERE code = ? AND n = ?")
                                .bind(code, rd.n).all()).results) out.pnls[r.p] = r.v;
        for(const r of (await db.prepare("SELECT p, body FROM roundResults WHERE code = ? AND n = ?")
                                .bind(code, rd.n).all()).results) out.results[r.p] = r.body;
      }
    }
    return json(out);
  }

  // Beitritt: jederzeit (auch während laufender Runde); Leinwände umgehen das Spielerlimit
  if(rest[0] === "join" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const role = body && body.role === "wall" ? "wall" : "player";
    if(role === "player" && await playerCount() >= MAX_PLAYERS) return err(409, "full");
    const tok = rndToken();
    for(let i = 0; i < 3; i++){
      const nxt = (await db.prepare("SELECT COALESCE(MAX(p),0)+1 AS p FROM members WHERE code = ?")
                           .bind(code).first()).p;
      const r = await db.prepare(
        `INSERT INTO members(code, p, token, name, role, lastSeen) VALUES(?,?,?,?,?,?)
         ON CONFLICT(code, p) DO NOTHING`)
        .bind(code, nxt, tok, cleanName(body && body.name) || ("Spieler " + nxt), role, now).run();
      if(r.meta.changes === 1){ await touch(); return json({token: tok, p: nxt, dur: room.dur}); }
    }
    return err(409, "busy");
  }

  // Rolle wechseln (player|wall) – zurück zu player nur, wenn noch Platz ist
  if(rest[0] === "role" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const role = body && body.role;
    if(role !== "player" && role !== "wall") return err(400, "role");
    const m = await memberByToken(body.token);
    if(!m) return err(403, "token");
    if(role === "player" && m.role !== "player" && await playerCount() >= MAX_PLAYERS) return err(409, "full");
    await db.prepare("UPDATE members SET role = ? WHERE code = ? AND p = ?").bind(role, code, m.p).run();
    await touch();
    return json({ok: true, role});
  }

  // Runde starten: nur der Ersteller, ≥2 Spieler, nicht während eine Runde läuft.
  // Die gewählte Dauer wird der neue Standard des Raums.
  if(rest[0] === "start" && rest.length === 1){
    if(req.method !== "POST") return err(405, "method");
    const body = await readJson(req);
    const m = await memberByToken(body && body.token);
    if(!m || m.p !== 1) return err(403, "token");
    if(await playerCount() < 2) return err(409, "not enough players");
    if(room.curRound > 0){
      const cur = await db.prepare("SELECT dur, startAt FROM rounds WHERE code = ? AND n = ?")
                          .bind(code, room.curRound).first();
      if(cur && now < cur.startAt + cur.dur * 60000) return err(409, "running");
    }
    const dur = body && DURS.includes(body.dur) ? body.dur : room.dur;
    const n = room.curRound + 1;
    const r = await db.prepare(
      `INSERT INTO rounds(code, n, seed, dur, startAt) VALUES(?,?,?,?,?) ON CONFLICT(code, n) DO NOTHING`)
      .bind(code, n, rndSeed(), dur, now + START_DELAY_MS).run();
    if(r.meta.changes !== 1) return err(409, "running"); // Doppel-Start im Rennen
    await db.prepare("UPDATE rooms SET curRound = ?, dur = ?, lastActive = ? WHERE code = ?")
            .bind(n, dur, now, code).run();
    const rd = await db.prepare("SELECT n, dur, startAt, seed FROM rounds WHERE code = ? AND n = ?")
                       .bind(code, n).first();
    return json({n: rd.n, dur: rd.dur, startAt: rd.startAt, seed: rd.seed}, 201);
  }

  // Runden-Daten: /round/{n}/result/{p} und /round/{n}/pnl/{p}
  if(rest[0] === "round" && rest.length === 4){
    const n = +rest[1], kind = rest[2], p = +rest[3];
    if(!Number.isInteger(n) || n < 1) return err(400, "round");
    if(!Number.isInteger(p) || p < 1) return err(400, "player");
    const rd = await db.prepare("SELECT startAt FROM rounds WHERE code = ? AND n = ?").bind(code, n).first();
    if(!rd) return err(404, "unknown round");
    if(req.method !== "PUT") return err(405, "method");
    const tok = await db.prepare("SELECT token, role FROM members WHERE code = ? AND p = ?").bind(code, p).first();
    if(!tok || req.headers.get("x-token") !== tok.token) return err(403, "token");
    if(tok.role !== "player") return err(403, "wall"); // Leinwände spielen nicht

    if(kind === "result"){
      const body = (await req.text()).trim();
      if(body.length > 600 || !body.startsWith("SPCX5.")) return err(400, "payload");
      const pnl = +url.searchParams.get("pnl");
      if(!Number.isFinite(pnl) || Math.abs(pnl) > 1e7) return err(400, "pnl");
      const r = await db.prepare(
        `INSERT INTO roundResults(code, n, p, body, pnlFinal, created) VALUES(?,?,?,?,?,?)
         ON CONFLICT(code, n, p) DO NOTHING`)
        .bind(code, n, p, body, Math.round(pnl * 100) / 100, now).run();
      if(r.meta.changes !== 1) return err(409, "write-once");
      await touch();
      return json({ok: true}, 201);
    }
    if(kind === "pnl"){
      const body = await readJson(req);
      const v = body && +body.pnl;
      if(!Number.isFinite(v) || Math.abs(v) > 1e7) return err(400, "pnl");
      await db.prepare(
        `INSERT INTO roundPnl(code, n, p, v, t) VALUES(?,?,?,?,?)
         ON CONFLICT(code, n, p) DO UPDATE SET v = excluded.v, t = excluded.t`)
        .bind(code, n, p, Math.round(v * 100) / 100, now).run();
      return json({ok: true});
    }
    return err(404, "not found");
  }

  return err(404, "not found");
}
