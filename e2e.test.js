/* Ende-zu-Ende-Tests für die Online-Schicht + Teil-Links. Ausführen mit:  node e2e.test.js
   Braucht nur Node ≥ 22 (fetch, WebCrypto, node:sqlite), keine Abhängigkeiten.
   Simuliert mehrere "Geräte" (DOM-Stub, getrennte localStorage-Zustände) gegen den ECHTEN
   worker.js-Handler (D1 über node:sqlite): Lobby, Geheim-Seed, 2er-Auto-Vergleich,
   3er-Rangliste, Reload-Robustheit, Offline-Fallback, ?join=/?vs=-Links. */
const fs=require("fs"), os=require("os"), path=require("path"), {pathToFileURL}=require("url");
const noop=()=>{};
(async()=>{
  // ---- Worker laden (echter Handler, KV als Map) ----
  const tmp=path.join(os.tmpdir(),"spcx-w-"+process.pid+".mjs");
  fs.copyFileSync(path.join(__dirname,"worker.js"),tmp);
  const worker=(await import(pathToFileURL(tmp).href)).default; fs.unlinkSync(tmp);
  const {DatabaseSync}=require("node:sqlite");
  const sq=new DatabaseSync(":memory:");
  const env={DB:{prepare(sql){return{_a:[],bind(...a){this._a=a;return this;},
    async first(){const r=sq.prepare(sql).get(...this._a);return r===undefined?null:r;},
    async run(){const i=sq.prepare(sql).run(...this._a);return{success:true,meta:{changes:Number(i.changes)}};},
    async all(){return{results:sq.prepare(sql).all(...this._a)};}};}}};
  global.__killFetch=false;
  global.fetch=async(url,opts)=>{ if(global.__killFetch) throw new TypeError("network down");
    return worker.fetch(new Request(url,opts),env); };

  // ---- DOM/Browser-Stub ----
  const els={}, store={};
  const ctx2d={fillStyle:"",fillRect:noop,clearRect:noop};
  const mkEl=()=>new Proxy(function(){},{
    get:(t,p)=>{ if(p==="classList")return{add:noop,remove:noop,toggle:noop,contains:()=>false};
      if(p==="style")return t.__style||(t.__style={});
      if(p==="getContext")return ()=>ctx2d;
      if(p==="querySelectorAll")return ()=>[]; if(p==="querySelector")return ()=>mkEl();
      if(["appendChild","addEventListener","setAttribute","focus","prepend","removeChild","scrollIntoView","dispatchEvent","play"].includes(p))return noop;
      if(p==="dataset")return{}; if(p==="children")return[]; if(p==="clientWidth")return 200;
      return t[p]!==undefined?t[p]:"";},
    set:(t,p,v)=>{t[p]=v;return true;}, apply:()=>mkEl()});
  global.document={getElementById:id=>els[id]||(els[id]=mkEl()),querySelectorAll:()=>[],querySelector:()=>mkEl(),addEventListener:noop,createElement:()=>mkEl(),body:mkEl()};
  global.window={addEventListener:noop,devicePixelRatio:1,matchMedia:()=>({matches:false,addEventListener:noop}),location:{protocol:"https:",origin:"https://spcx.test",pathname:"/",search:"",href:"https://spcx.test/"}};
  global.location=global.window.location; global.history={replaceState:noop};
  global.navigator={serviceWorker:{register:()=>({catch:noop})}};
  global.localStorage={getItem:k=>store[k]??null,setItem:(k,v)=>store[k]=v,removeItem:k=>delete store[k]};
  global.performance={now:()=>0};global.requestAnimationFrame=noop;global.cancelAnimationFrame=noop;
  global.addEventListener=noop;global.setInterval=()=>0;global.clearInterval=noop;
  global.setTimeout=()=>0;global.clearTimeout=noop;global.alert=noop;

  // ---- Spiel-Code + Hook laden ----
  const qr=fs.readFileSync(path.join(__dirname,"qr.js"),"utf8");
  const data=fs.readFileSync(path.join(__dirname,"data.js"),"utf8");
  const game=fs.readFileSync(path.join(__dirname,"game.js"),"utf8");
  const hookFn = async function(){
    const out={};
    const $id=id=>document.getElementById(id);
    mode="remote"; sandbox=false; tutorial=false; over=false; START_CASH=25000;

    // === Client A legt online an ===
    durationMin=10; codeIn.value=""; market=null; onlineGame=null; marketSeed=null; startAt=0;
    await $id("startBtn").onclick();
    out["A online angelegt (p1)"]= !!onlineGame && onlineGame.p===1;
    out["Code 6-stellig, Dauer kodiert"]= /^\d{6}$/.test(String(onlineGame.code)) && (+onlineGame.code)%3===1;
    out["Markt/Seed VOR Start unbekannt"]= market===null && marketSeed===null && startAt===0;
    await pollLobby();
    out["A wartet auf Gegner"]= $id("lobbyOpp").textContent.indexOf("niemand beigetreten")>=0;
    const stash=()=>({onlineGame,marketSeed,gameCode,durationMin,market,startAt,players,soloP,matchTicks});
    const restore=c=>{ ({onlineGame,marketSeed,gameCode,durationMin,market,startAt,players,soloP,matchTicks}=c); };
    const A=stash();

    // === Client B tritt bei (anderes Gerät: eigener localStorage!) ===
    const aRec = localStorage.getItem("spcx-duell-lobby");
    localStorage.removeItem("spcx-duell-lobby");
    onlineGame=null; marketSeed=null; market=null; startAt=0; durationMin=15;
    codeIn.value=String(A.gameCode);
    await $id("startBtn").onclick();
    out["B beigetreten (p2), Dauer vom Server"]= !!onlineGame && onlineGame.p===2 && durationMin===10;
    await pollLobby();
    out["B: noch kein Start"]= startAt===0 && market===null;
    const B=stash();

    // === A sieht Beitritt und startet ===
    restore(A);
    await pollLobby();
    out["A sieht Beitritt ✓"]= $id("lobbyOpp").textContent.indexOf("Dabei (2)")>=0;
    await $id("lobbyStartBtn").onclick();
    out["A: Start fixiert + Markt gebaut"]= startAt>Date.now() && marketSeed!==null && market!==null;
    const A2=stash();

    // === B bekommt Start + Seed per Poll ===
    restore(B);
    await pollLobby();
    out["B: gleicher Start, gleicher Seed"]= startAt===A2.startAt && marketSeed===A2.marketSeed;
    out["Seed ≠ Beitritts-Code (Vorspiel-Schutz)"]= marketSeed!==(A2.gameCode>>>0);
    const B2=stash();
    out["identischer Markt auf beiden"]=
      JSON.stringify(B2.market.paths.SPCX.slice(0,60))===JSON.stringify(A2.market.paths.SPCX.slice(0,60)) &&
      B2.market.paths.ACT.length===A2.market.paths.ACT.length;
    const offline=genMarket(A2.gameCode, A2.matchTicks);
    out["≠ Markt aus Code-als-Seed"]=
      JSON.stringify(offline.paths.SPCX.slice(0,60))!==JSON.stringify(A2.market.paths.SPCX.slice(0,60));

    // === Snapshot trägt Seed + Online-Daten ===
    restore(A2); tickCount=42; round=0;
    saveSnapshot("play");
    const snap=JSON.parse(localStorage.getItem("spcx-duell-game"));
    out["Snapshot: marketSeed + Token"]= snap.marketSeed===A2.marketSeed && snap.online && snap.online.token===A2.onlineGame.token;

    // === Ergebnisse: Auto-Upload + Auto-Vergleich ===
    let captured=null;
    renderCompare=(me,opp)=>{ captured={me,opp}; };
    restore(B2);
    players=[newPlayer("Berta","var(--p2)")]; players[0].result={pnl:-42.5,total:24957.5}; soloP=players[0];
    await onlineShareResult(soloP);
    out["B hochgeladen, wartet"]= captured===null;
    const B3=stash();
    restore(A2);
    players=[newPlayer("Anna","var(--p1)")]; players[0].result={pnl:120.25,total:25120.25}; soloP=players[0];
    await onlineShareResult(soloP);
    out["A: Vergleich öffnet sich automatisch"]= !!captured && captured.opp.name==="Berta" &&
      Math.abs(captured.opp.result.pnl+42.5)<1e-9 && captured.opp.seed===A2.marketSeed;
    captured=null;
    restore(B3);
    await pollOppResult();
    out["B: Vergleich öffnet sich automatisch"]= !!captured && captured.opp.name==="Anna";

    // === Altformat SPCX4 bleibt lesbar ===
    const oldF=[gameCode,"Alt","10.00","25010.00",1,1,0,0,100,"0.00","x","x",0,0,5,"25010.00","25000.00","0.00",0,"0.0000","SPCX","0.15","0.00"];
    const u4=unpackResult("SPCX4."+btoa(unescape(encodeURIComponent(oldF.join("|")))), gameCode);
    out["SPCX4-Altformat lesbar"]= !!u4 && !u4.wrongGame && u4.seed===undefined && u4.name==="Alt";

    // === Seed-Mismatch wird abgelehnt (manueller Vergleich) ===
    const sv=marketSeed; marketSeed=(sv^0xDEADBEEF)>>>0;
    const wrong=packResult(soloP); marketSeed=sv;
    $id("cmpIn").value=wrong; captured=null;
    $id("cmpBtn").onclick();
    out["Seed-Mismatch abgelehnt"]= captured===null && $id("cmpErr").textContent.indexOf("Anderer Markt")>=0;

    // === Mehrspieler: 3er-Spiel mit Rangliste ===
    localStorage.removeItem("spcx-duell-lobby");
    onlineGame=null; marketSeed=null; market=null; startAt=0; durationMin=10; codeIn.value="";
    $id("name1").value="Anna";
    await $id("startBtn").onclick();
    const E=stash();
    const jF=await (await fetch(ONLINE_API+"/game/"+E.onlineGame.code+"/join",{method:"POST",body:JSON.stringify({name:"Ben"})})).json();
    const jG=await (await fetch(ONLINE_API+"/game/"+E.onlineGame.code+"/join",{method:"POST",body:JSON.stringify({name:"Cleo"})})).json();
    out["3er: Plaetze 2+3 vergeben"]= jF.p===2 && jG.p===3;
    restore(E);
    await pollLobby();
    out["3er: Ersteller sieht alle + Startknopf"]= $id("lobbyOpp").textContent.indexOf("Dabei (3)")>=0
      && $id("lobbyStartBtn").textContent.indexOf("3 Spieler")>=0;
    await $id("lobbyStartBtn").onclick();
    out["3er: gearmt, Roster gemerkt"]= marketSeed!==null && startAt>Date.now() && (onlineGame.players||[]).length===3;
    // Live-Rennen: F meldet P&L per API, E synct und rendert die Leiste
    players=[newPlayer("Anna","var(--p1)")]; round=0;
    await fetch(ONLINE_API+"/game/"+E.onlineGame.code+"/pnl/2",
      {method:"PUT",body:JSON.stringify({pnl:-50}),headers:{"x-token":jF.token}});
    await syncRace();
    const rr=$id("raceRow").innerHTML||"";
    out["Rennen: Leiste zeigt alle (eigener zuerst, Krone)"]=
      rr.indexOf("Anna")>=0 && rr.indexOf("Ben")>rr.indexOf("Anna") &&
      rr.indexOf("\ud83d\udc51")>=0 && rr.indexOf("…")>=0;
    out["Rennen: fremder P&L angekommen"]= racePnls["2"]===-50;
    const mk=(nm,pnl)=>{ const pl=newPlayer(nm,"var(--p2)"); pl.result={pnl:pnl,total:25000+pnl}; return pl; };
    await fetch(ONLINE_API+"/game/"+E.onlineGame.code+"/result/2",{method:"PUT",body:packResult(mk("Ben",-50)),headers:{"x-token":jF.token}});
    await fetch(ONLINE_API+"/game/"+E.onlineGame.code+"/result/3",{method:"PUT",body:packResult(mk("Cleo",200)),headers:{"x-token":jG.token}});
    players=[mk("Anna",100)]; soloP=players[0];
    await onlineShareResult(soloP);
    out["3er: Rangliste vollstaendig (3 Ergebnisse)"]= !!rankResults && Object.keys(rankResults).length===3;
    const rh=$id("rankBox").innerHTML||"";
    out["3er: Reihenfolge Cleo > Anna > Ben, Krone vorn"]= rh.indexOf("Cleo")>=0
      && rh.indexOf("Cleo")<rh.indexOf("Anna") && rh.indexOf("Anna")<rh.indexOf("Ben")
      && rh.indexOf("\ud83d\udc51")>=0 && rh.indexOf("\ud83d\udc51")<rh.indexOf("Cleo");
    out["3er: eigene Zeile markiert"]= rh.indexOf("(du)")>=0;
    captured=null; showRankDetail(2);
    out["3er: Detailvergleich per Tipp (Ben)"]= !!captured && captured.opp.name==="Ben";
    localStorage.removeItem("spcx-duell-lobby");

    // === Reload-Robustheit: Ersteller verliert die Seite und kommt zurück ===
    // Neues Spiel als Ersteller C anlegen
    onlineGame=null; marketSeed=null; market=null; startAt=0; durationMin=5; codeIn.value="";
    await $id("startBtn").onclick();
    const cCode=onlineGame.code, cTok=onlineGame.token;
    out["C: Lobby-Zustand gesichert"]= !!localStorage.getItem("spcx-duell-lobby");
    // 'Reload': alles weg außer localStorage
    onlineGame=null; marketSeed=null; market=null; startAt=0; players=[];
    const rec=loadLobbyState();
    out["C: Zustand ladbar (p1+Token)"]= !!rec && rec.p===1 && rec.token===cTok && rec.code===cCode;
    resumeLobby(rec);
    out["C: Lobby als Ersteller wiederhergestellt"]= !!onlineGame && onlineGame.p===1 && onlineGame.token===cTok
      && $id("lobbyOpp").textContent.indexOf("niemand beigetreten")>=0;
    // Ersteller tippt (statt Auto-Resume) den EIGENEN Code ein → Rolle statt Selbst-Beitritt
    onlineGame=null; marketSeed=null; market=null; startAt=0;
    codeIn.value=String(cCode);
    await $id("startBtn").onclick();
    out["C: eigener Code → Ersteller-Rolle (kein Selbst-Beitritt)"]= !!onlineGame && onlineGame.p===1 && onlineGame.token===cTok;
    const stC=await (await fetch("https://spcx-duell.william-aaron-unger.workers.dev/game/"+cCode)).json();
    out["C: Server sagt weiterhin joined=false"]= stC.joined===false;
    // Gegner D tritt bei, C startet, 'Reload' im Countdown → Lobby-Resume findet startAt+Seed
    const C=stash();
    onlineGame=null; marketSeed=null; market=null; startAt=0; codeIn.value=String(cCode);
    localStorage.removeItem("spcx-duell-lobby"); // D ist ein anderes Gerät
    await $id("startBtn").onclick();
    const D=stash();
    restore(C); await pollLobby(); await $id("lobbyStartBtn").onclick();
    const armedSeed=marketSeed, armedAt=startAt;
    saveLobbyState(); // C sichert (im echten Code beim Anlegen geschehen; hier nach D-Kontext nötig)
    onlineGame=null; marketSeed=null; market=null; startAt=0; players=[]; // 'Reload' im Countdown
    resumeLobby(loadLobbyState());
    await pollLobby();
    out["C: Reload im Countdown → wieder gearmt (gleicher Seed/Start)"]= marketSeed===armedSeed && startAt===armedAt;
    // 404-Fall: unbekanntes Spiel in der Lobby melden
    onlineGame={code:"000001",token:"x",p:1,seed:null}; startAt=0;
    await pollLobby();
    out["404-Spiel wird gemeldet"]= $id("lobbyOpp").textContent.indexOf("nicht mehr vorhanden")>=0;

    // === Offline-Fallback: Server weg → Verhalten wie früher ===
    globalThis.__killFetch=true;
    onlineGame=null; marketSeed=null; market=null; startAt=0; codeIn.value="";
    await $id("startBtn").onclick();
    out["Offline-Fallback (Minuten-Start, Markt sofort)"]=
      onlineGame===null && market!==null && startAt>Date.now() &&
      $id("lobbyStartRow").style.display==="" && $id("lobbyOpp").style.display==="none";
    globalThis.__killFetch=false;
    // === Teil-Links & Einfüge-Toleranz (?join= / ?vs=) ===
    onlineGame=null; marketSeed=null; sandbox=false; gameCode=333333;
    durationMin=DURATIONS[333333%3]; buildMarket();
    const meP=newPlayer("Ich","var(--p1)");    meP.result={pnl:111.5,total:25111.5};
    const opP=newPlayer("Gegner","var(--p2)"); opP.result={pnl:-50,total:24950};
    const myCode=packResult(meP), oppCode=packResult(opP);
    const vurl=shareUrl("vs", oppCode);
    out["Teil-Link: shareUrl baut https-Link"]= !!vurl && vurl.indexOf("?vs=")>0;
    out["Einfuegen: roher Code"]= extractResultCode(oppCode)===oppCode;
    out["Einfuegen: ganze Nachricht"]= extractResultCode("Mein Ergebnis:\n"+oppCode+"\nGruss!")===oppCode;
    out["Einfuegen: kompletter Link"]= extractResultCode("Vergleich: "+vurl)===oppCode;
    const prot=location.protocol; location.protocol="file:";
    out["file://: kein Teil-Link"]= shareUrl("join","123456")===null;
    location.protocol=prot;
    out["unpack ok + fremdes Spiel abgelehnt"]= (unpackResult(oppCode,333333)||{}).name==="Gegner"
      && !!(unpackResult(oppCode,111111)||{}).wrongGame;
    localStorage.setItem("spcx-duell", JSON.stringify({games:[{code:myCode,durationMin,name:"Ich",pnl:111.5,date:1750000000000,fav:"SPCX",mode:"remote"}]}));
    cmpFromStats=false; captured=null;
    openSharedCompare(oppCode);
    out["?vs mit Historie -> Vergleich oeffnet"]= cmpFromStats===true && !!captured;
    localStorage.removeItem("spcx-duell");
    codeIn.value=""; openSharedCompare(oppCode);
    out["?vs ohne Historie -> Code vorbefuellt"]= codeIn.value==="333333";
    location.search="?join=222333"; codeIn.value="";
    handleShareParams();
    out["?join -> Beitritts-Code vorbefuellt"]= codeIn.value==="222333";
    location.search="?vs=quatsch";
    out["kaputter Link wird still ignoriert"]= (()=>{ try{ handleShareParams(); return true; }catch(e){ return false; } })();
    location.search="";

    return out;
  };
  (0,eval)(qr+"\n"+data+"\n"+game+"\n;globalThis.__e2e = "+hookFn.toString()+";");
  const out=await globalThis.__e2e();
  let fail=0;
  for(const [k,v] of Object.entries(out)){ console.log((v?"✔":"✘"),k); if(!v)fail++; }
  console.log(fail? "\n"+fail+" FEHLER" : "\nENDE-ZU-ENDE OK ("+Object.keys(out).length+" Checks)");
  process.exit(fail?1:0);
})().catch(e=>{ console.error("Harness-Fehler:",e); process.exit(1); });
