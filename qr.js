/* QR-Code-Encoder (Byte-Modus, Versionen 1-10, EC-Level M) + Canvas-Renderer.
   Abhängigkeitsfrei und rein clientseitig – erzeugt den Einladungs-Link als QR,
   damit der Gegner ihn mit der Kamera scannen kann. Klassisches Skript (kein Modul);
   stellt die globalen Funktionen qrMatrix(text) und drawQR(canvas, text, opts) bereit.
   Der Encoder ist per Round-Trip gegen einen unabhängigen QR-Decoder verifiziert. */
var qrMatrix, drawQR;
(function(){
  // ---- Galois-Feld GF(256), Primpolynom 0x11D ----
  const EXP = new Array(512), LOG = new Array(256);
  (function(){ let x = 1; for(let i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=0x11D; }
    for(let i=255;i<512;i++) EXP[i]=EXP[i-255]; })();
  const gmul = (a,b) => (a===0||b===0) ? 0 : EXP[LOG[a]+LOG[b]];

  // Reed-Solomon-Generatorpolynom (Leitkoeffizient zuerst) + Rest der Polynomdivision
  function rsGen(deg){ let g=[1]; for(let i=0;i<deg;i++){ const ng=new Array(g.length+1).fill(0);
      for(let j=0;j<g.length;j++){ ng[j]^=gmul(g[j],EXP[i]); ng[j+1]^=g[j]; } g=ng; } return g.reverse(); }
  function rsEC(data, deg){ const g=rsGen(deg); const r=data.concat(new Array(deg).fill(0));
    for(let i=0;i<data.length;i++){ const c=r[i]; if(c) for(let j=0;j<g.length;j++) r[i+j]^=gmul(g[j],c); }
    return r.slice(data.length); }

  // ---- Versions-Tabellen (EC-Level M): EC-Codewörter, Blockstruktur, Ausrichtungsmuster ----
  const EC_M   = [10,16,26,18,24,16,18,22,22,26];
  const BLK_M  = [[[1,16]],[[1,28]],[[1,44]],[[2,32]],[[2,43]],[[4,27]],[[4,31]],
                  [[2,38],[2,39]],[[3,36],[2,37]],[[4,43],[1,44]]];
  const ALIGN  = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
  const totalData = v => BLK_M[v-1].reduce((s,[c,d])=>s+c*d,0);

  function chooseVersion(len){ for(let v=1;v<=10;v++){ const cnt=v<=9?8:16;
      if(totalData(v)*8 >= 4+cnt+8*len) return v; } throw new Error("Daten zu lang für QR v1-10"); }

  // ---- Bitstrom (Byte-Modus): Modus + Länge + Daten + Terminator + Füllbytes ----
  function bitStream(bytes, v){ const bits=[]; const push=(val,n)=>{ for(let i=n-1;i>=0;i--) bits.push((val>>i)&1); };
    push(0b0100,4); push(bytes.length, v<=9?8:16); for(const b of bytes) push(b,8);
    const capBits = totalData(v)*8;
    for(let i=0;i<4 && bits.length<capBits;i++) bits.push(0);
    while(bits.length%8!==0) bits.push(0);
    const pad=[0xEC,0x11]; let pi=0; while(bits.length<capBits){ push(pad[pi&1],8); pi++; }
    const cw=[]; for(let i=0;i<bits.length;i+=8){ let b=0; for(let j=0;j<8;j++) b=(b<<1)|bits[i+j]; cw.push(b); } return cw; }

  // ---- Daten- und EC-Codewörter in Blöcke aufteilen und verschränken ----
  function interleave(dataCW, v){ const blocks=[], ec=[]; let idx=0; const ecLen=EC_M[v-1];
    for(const [count,dcw] of BLK_M[v-1]) for(let i=0;i<count;i++){ const d=dataCW.slice(idx,idx+dcw); idx+=dcw;
        blocks.push(d); ec.push(rsEC(d,ecLen)); }
    const out=[]; const maxD=Math.max(...blocks.map(b=>b.length));
    for(let i=0;i<maxD;i++) for(const b of blocks) if(i<b.length) out.push(b[i]);
    for(let i=0;i<ecLen;i++) for(const e of ec) out.push(e[i]); return out; }

  // ---- Funktionsmuster in die Matrix legen und die Datenbereiche markieren ----
  function build(v){ const n=17+4*v; const m=[], fn=[];
    for(let i=0;i<n;i++){ m.push(new Array(n).fill(0)); fn.push(new Array(n).fill(false)); }
    const set=(r,c,val)=>{ m[r][c]=val?1:0; fn[r][c]=true; };
    function finder(r,c){ for(let i=-1;i<=7;i++) for(let j=-1;j<=7;j++){ const rr=r+i,cc=c+j;
        if(rr<0||rr>=n||cc<0||cc>=n) continue; const inRing=(i>=0&&i<=6&&(j===0||j===6))||(j>=0&&j<=6&&(i===0||i===6));
        const inCore=(i>=2&&i<=4&&j>=2&&j<=4); set(rr,cc,inRing||inCore); } }
    finder(0,0); finder(0,n-7); finder(n-7,0);
    for(let i=0;i<n;i++){ if(!fn[i][6]) set(i,6,i%2===0); if(!fn[6][i]) set(6,i,i%2===0); } // Timing
    const ap=ALIGN[v-1]; for(let i=0;i<ap.length;i++) for(let j=0;j<ap.length;j++){
        if((i===0&&j===0)||(i===0&&j===ap.length-1)||(i===ap.length-1&&j===0)) continue;
        const r=ap[i],c=ap[j]; for(let a=-2;a<=2;a++) for(let b=-2;b<=2;b++)
          set(r+a,c+b, Math.max(Math.abs(a),Math.abs(b))!==1); }
    set(n-8,8,true); // Dunkelmodul
    // Format- (immer) und Versions-Infobereiche (v>=7) als Funktionsmodule reservieren
    for(let i=0;i<9;i++){ if(i!==6){ if(!fn[8][i]){m[8][i]=0;fn[8][i]=true;} if(!fn[i][8]){m[i][8]=0;fn[i][8]=true;} } }
    for(let i=0;i<8;i++){ if(!fn[8][n-1-i]){m[8][n-1-i]=0;fn[8][n-1-i]=true;} if(!fn[n-1-i][8]){m[n-1-i][8]=0;fn[n-1-i][8]=true;} }
    if(v>=7){ for(let i=0;i<18;i++){ const a=Math.floor(i/3), b=i%3;
        m[n-11+b][a]=0; fn[n-11+b][a]=true; m[a][n-11+b]=0; fn[a][n-11+b]=true; } }
    return {n,m,fn}; }

  // ---- Datenbits im Zickzack platzieren (Timing-Spalte 6 auslassen) ----
  function placeData(st, inter){ const {n,m,fn}=st; const bits=[];
    for(const b of inter) for(let i=7;i>=0;i--) bits.push((b>>i)&1);
    let idx=0, up=true;
    for(let col=n-1; col>0; col-=2){ if(col===6) col--;
      for(let t=0;t<n;t++){ const row= up ? n-1-t : t;
        for(let c=0;c<2;c++){ const cc=col-c; if(fn[row][cc]) continue;
          m[row][cc] = idx<bits.length ? bits[idx] : 0; idx++; } }
      up=!up; } }

  const MASK=[ (i,j)=>(i+j)%2===0, (i,j)=>i%2===0, (i,j)=>j%3===0, (i,j)=>(i+j)%3===0,
    (i,j)=>(Math.floor(i/2)+Math.floor(j/3))%2===0, (i,j)=>((i*j)%2+(i*j)%3)===0,
    (i,j)=>(((i*j)%2+(i*j)%3)%2)===0, (i,j)=>(((i+j)%2+(i*j)%3)%2)===0 ];

  // BCH(15,5) Format-Info bzw. BCH(18,6) Versions-Info
  function fmtBits(mask){ let data=(0<<3)|mask, rem=data;   // EC-Level M -> 0
    for(let i=0;i<10;i++) rem=(rem<<1)^(((rem>>9)&1)*0x537);
    return (((data<<10)|(rem&0x3FF))^0x5412)&0x7FFF; }
  function verBits(v){ let rem=v; for(let i=0;i<12;i++) rem=(rem<<1)^(((rem>>11)&1)*0x1F25);
    return ((v<<12)|(rem&0xFFF))&0x3FFFF; }

  function applyFormat(st, mask){ const {n,m}=st; const bits=fmtBits(mask); const get=i=>(bits>>i)&1;
    for(let i=0;i<15;i++){ const b=get(i);
      if(i<6) m[i][8]=b; else if(i<8) m[i+1][8]=b; else m[n-15+i][8]=b;    // vertikal (Spalte 8)
      if(i<8) m[8][n-i-1]=b; else if(i<9) m[8][7]=b; else m[8][15-i-1]=b;  // horizontal (Zeile 8)
    }
    m[n-8][8]=1; }
  function applyVersion(st, v){ if(v<7) return; const {n,m}=st; const bits=verBits(v);
    for(let i=0;i<18;i++){ const b=(bits>>i)&1; const a=Math.floor(i/3), c=i%3;
      m[n-11+c][a]=b; m[a][n-11+c]=b; } }

  // Masken-Bewertung (4 Standard-Regeln) für die Wahl der besten Maske
  function penalty(m){ const n=m.length; let p=0;
    for(let i=0;i<n;i++){ for(let dir=0;dir<2;dir++){ let run=1,prev=-1;
        for(let j=0;j<n;j++){ const v=dir?m[j][i]:m[i][j]; if(v===prev){ run++; if(run===5)p+=3; else if(run>5)p++; } else { run=1; prev=v; } } } }
    for(let i=0;i<n-1;i++) for(let j=0;j<n-1;j++){ const v=m[i][j];
      if(v===m[i][j+1]&&v===m[i+1][j]&&v===m[i+1][j+1]) p+=3; }
    const pat=[1,0,1,1,1,0,1];
    for(let i=0;i<n;i++) for(let j=0;j<n;j++){ for(let dir=0;dir<2;dir++){
        let ok1=true; for(let k=0;k<7;k++){ const r=dir?i+k:i, c=dir?j:j+k; if(r>=n||c>=n){ok1=false;break;} if(m[r][c]!==pat[k]) ok1=false; }
        if(ok1){ let clear=true; for(let k=-4;k<0;k++){ const r=dir?i+k:i, c=dir?j:j+k; if(r>=0&&c>=0&&r<n&&c<n&&m[r][c]!==0){clear=false;break;} }
          let clear2=true; for(let k=7;k<11;k++){ const r=dir?i+k:i, c=dir?j:j+k; if(r<n&&c<n&&m[r][c]!==0){clear2=false;break;} }
          if(clear||clear2) p+=40; } } }
    let dark=0; for(let i=0;i<n;i++) for(let j=0;j<n;j++) dark+=m[i][j];
    p+=Math.floor(Math.abs(dark/(n*n)*100-50)/5)*10; return p; }

  // Öffentlich: Text -> QR-Matrix (2D-Array 0/1), beste Maske automatisch gewählt
  qrMatrix = function(text){
    const bytes=[]; for(const b of unescape(encodeURIComponent(text))) bytes.push(b.charCodeAt(0));
    const v=chooseVersion(bytes.length); const inter=interleave(bitStream(bytes,v),v);
    let best=null;
    for(let mask=0;mask<8;mask++){ const st=build(v); placeData(st,inter);
      const {n,m,fn}=st; for(let i=0;i<n;i++) for(let j=0;j<n;j++) if(!fn[i][j] && MASK[mask](i,j)) m[i][j]^=1;
      applyFormat(st,mask); applyVersion(st,v);
      const pen=penalty(m); if(!best||pen<best.pen) best={pen,m:st.m}; }
    return best.m;
  };

  // Öffentlich: QR schwarz auf weiß auf ein Canvas zeichnen (max. Kontrast fürs Scannen),
  // devicePixelRatio-bewusst, mit ruhiger Zone. Gibt false zurück, wenn der Text zu lang ist.
  drawQR = function(canvas, text, opts){
    opts = opts || {};
    let m; try{ m = qrMatrix(text); }catch(e){ return false; }
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const n = m.length, total = n + 2*quiet;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const cssSize = opts.size || canvas.clientWidth || 220;
    canvas.width = Math.round(cssSize*dpr); canvas.height = Math.round(cssSize*dpr);
    canvas.style.width = cssSize+"px"; canvas.style.height = cssSize+"px";
    const ctx = canvas.getContext("2d");
    const px = canvas.width/total;
    ctx.fillStyle = opts.light || "#FFFFFF"; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = opts.dark || "#000000";
    for(let i=0;i<n;i++) for(let j=0;j<n;j++) if(m[i][j])
      ctx.fillRect(Math.floor((j+quiet)*px), Math.floor((i+quiet)*px), Math.ceil(px), Math.ceil(px));
    return true;
  };
})();
