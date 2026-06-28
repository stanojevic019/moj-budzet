// Main app controller (vanilla JS). Renders the lock screen, then the app shell
// with views: Pregled (dashboard), Transakcije, Uvoz, Računi, Podešavanja.

import * as db from './db.js';
import * as repo from './repo.js';
import * as an from './analytics.js';
import { parseFile } from './import-pdf.js';

const $ = (s, r=document) => r.querySelector(s);
const app = $('#app');
let view = 'dashboard';
let filterMonth = null;   // 'YYYY-MM' or null = all
const charts = {};
let pendingImports = [];   // parsed files awaiting confirmation

// ---------- formatting ----------
const nf = (cur) => new Intl.NumberFormat('sr-RS', { style:'currency', currency:cur, maximumFractionDigits:0 });
const nf2 = new Intl.NumberFormat('sr-RS', { maximumFractionDigits:0 });
function fmt(n, cur='RSD'){ return nf(cur).format(n||0); }
function fmtN(n){ return nf2.format(Math.round(n||0)); }
function pct(n){ return (n>=0?'+':'') + (n==null?'–':n.toFixed(0)) + '%'; }
const esc = (s) => (s==null?'':String(s)).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function getEurRate(){ const r = db.get(`SELECT value FROM meta WHERE key='eur_rate'`); return r?+r.value:117.5; }
function setEurRate(v){ db.run(`INSERT INTO meta(key,value) VALUES('eur_rate',?) ON CONFLICT(key) DO UPDATE SET value=?`, [String(v),String(v)]); }

async function persist(){ await db.save(); }
function toast(msg, ok=true){
  const t = document.createElement('div'); t.className = 'toast '+(ok?'ok':'err'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, 3200);
}

// =================================================================== LOCK
async function boot(){
  const exists = await db.vaultExists();
  renderLock(exists);
}
function renderLock(exists){
  app.innerHTML = `
   <div class="lock">
    <div class="lock-card">
      <div class="logo">💰</div>
      <h1>Moj Budžet</h1>
      <p class="sub">${exists ? 'Unesi lozinku da otključaš svoje podatke.' : 'Postavi lozinku. Njome se <b>šifruju</b> svi tvoji podaci na ovom uređaju. Ako je zaboraviš, podaci se ne mogu povratiti.'}</p>
      <input type="password" id="pp" placeholder="Lozinka" autocomplete="${exists?'current-password':'new-password'}" />
      ${exists?'':'<input type="password" id="pp2" placeholder="Ponovi lozinku" autocomplete="new-password" />'}
      <button id="lockBtn" class="primary big">${exists?'Otključaj':'Kreiraj sef'}</button>
      <div class="lock-err" id="lockErr"></div>
      <div class="lock-foot">🔒 Podaci nikad ne napuštaju uređaj · AES-256 · bez interneta</div>
    </div>
   </div>`;
  const go = async () => {
    const pp = $('#pp').value;
    const err = $('#lockErr');
    if(!pp){ err.textContent='Unesi lozinku.'; return; }
    if(!exists){
      if(pp.length < 6){ err.textContent='Lozinka mora imati bar 6 znakova.'; return; }
      if(pp !== $('#pp2').value){ err.textContent='Lozinke se ne poklapaju.'; return; }
      $('#lockBtn').disabled = true; $('#lockBtn').textContent='Kreiram…';
      await db.createVault(pp); enterApp();
    } else {
      $('#lockBtn').disabled = true; $('#lockBtn').textContent='Otključavam…';
      const ok = await db.unlock(pp);
      if(!ok){ err.textContent='Pogrešna lozinka.'; $('#lockBtn').disabled=false; $('#lockBtn').textContent='Otključaj'; return; }
      enterApp();
    }
  };
  $('#lockBtn').onclick = go;
  app.querySelectorAll('input').forEach(i=> i.addEventListener('keydown', e=>{ if(e.key==='Enter') go(); }));
  $('#pp').focus();
}

// =================================================================== SHELL
function enterApp(){
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">💰 Moj Budžet</div>
      <button class="lockbtn" data-action="lock" title="Zaključaj">🔒</button>
    </header>
    <main id="screen"></main>
    <nav class="tabbar">
      ${tab('dashboard','📊','Pregled')}
      ${tab('tx','🧾','Transakcije')}
      ${tab('import','📥','Uvoz')}
      ${tab('accounts','🏦','Računi')}
      ${tab('settings','⚙️','Više')}
    </nav>`;
  app.addEventListener('click', onClick);
  render();
}
const tab = (id,icon,label) => `<button class="tab ${view===id?'active':''}" data-tab="${id}"><span>${icon}</span>${label}</button>`;

function render(){
  app.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===view));
  const s = $('#screen'); if(!s) return;
  Object.values(charts).forEach(c=>{ try{c.destroy();}catch{} });
  if(view==='dashboard') renderDashboard(s);
  else if(view==='tx') renderTx(s);
  else if(view==='import') renderImport(s);
  else if(view==='accounts') renderAccounts(s);
  else if(view==='settings') renderSettings(s);
  s.scrollTop = 0;
}

// =================================================================== DASHBOARD
function renderDashboard(s){
  const k = an.kpis('RSD');
  const balances = an.accountBalances();
  const nw = an.netWorth(getEurRate());
  if(!k){
    s.innerHTML = empty('📥','Još nema podataka','Uvezi PDF izvod ili ručno dodaj transakciju da vidiš analizu.','Idi na uvoz','import');
    return;
  }
  const m = an.monthly('RSD');
  const months = m.map(x=>x.label);
  const breakdown = an.categoryBreakdown(k.current.month,'expense','RSD').slice(0,8);
  const rec = an.recurring('RSD');
  const recMonthly = rec.reduce((s,r)=>s+r.median,0);
  const runway = k.avgSpend ? nw.totalRSD / k.avgSpend : 0;

  s.innerHTML = `
    <div class="kpis">
      ${kpi('Neto vrednost', fmt(nw.totalRSD), `${balances.length} računa`, '')}
      ${kpi('Potrošnja '+k.current.label, fmt(k.current.spending), k.momSpend==null?'':`${k.momSpend<=0?'📉':'📈'} ${pct(k.momSpend)} vs prošli mesec`, k.momSpend>0?'bad':'good')}
      ${kpi('Štednja '+k.current.label, fmt(k.current.net), k.savingsRate==null?'':`stopa štednje ${k.savingsRate.toFixed(0)}%`, k.current.net>=0?'good':'bad')}
      ${kpi('Prosečna potrošnja', fmt(k.avgSpend), `${k.monthsCount} mes. · rezerva ~${runway.toFixed(1)} mes.`, '')}
    </div>

    ${insights(k, breakdown, recMonthly)}

    <section class="card">
      <h3>Prihodi vs rashodi po mesecima</h3>
      <div class="chart-wrap"><canvas id="cIE"></canvas></div>
    </section>

    <section class="card">
      <h3>Trend potrošnje i štednje</h3>
      <div class="chart-wrap"><canvas id="cTrend"></canvas></div>
    </section>

    <section class="card">
      <div class="row-between"><h3>Rashodi po kategorijama · ${k.current.label}</h3></div>
      <div class="chart-wrap small"><canvas id="cCat"></canvas></div>
      <div class="cat-legend">
        ${breakdown.map(c=>`<div class="cl"><span class="dot" style="background:${c.color}"></span>${c.icon} ${esc(c.name)}<b>${fmt(c.total)}</b></div>`).join('')}
      </div>
    </section>

    <section class="card">
      <h3>Računi</h3>
      ${balances.map(a=>`<div class="acct-row"><span class="dot" style="background:${a.color}"></span>
        <div class="ar-name">${esc(a.name)}<small>${a.type==='cash'?'keš':'banka'} · ${a.n} tx</small></div>
        <b class="${a.balance<0?'neg':''}">${fmt(a.balance,a.currency)}</b></div>`).join('')}
    </section>

    ${rec.length?`<section class="card">
      <h3>Pretplate i redovni troškovi <small>~${fmt(recMonthly)}/mes</small></h3>
      ${rec.slice(0,12).map(r=>`<div class="rec-row"><div>${esc(r.merchant)}<small>${r.months} meseci</small></div><b>${fmt(r.median)}</b></div>`).join('')}
    </section>`:''}
  `;

  // charts
  const C = window.Chart;
  charts.ie = new C($('#cIE'), { type:'bar', data:{ labels:months, datasets:[
    { label:'Prihodi', data:m.map(x=>x.realIncome), backgroundColor:'#22c55e' },
    { label:'Rashodi', data:m.map(x=>x.spending), backgroundColor:'#ef4444' },
  ]}, options: barOpts() });

  charts.trend = new C($('#cTrend'), { type:'line', data:{ labels:months, datasets:[
    { label:'Potrošnja', data:m.map(x=>x.spending), borderColor:'#ef4444', backgroundColor:'rgba(239,68,68,.1)', fill:true, tension:.3 },
    { label:'Štednja', data:m.map(x=>x.net), borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,.1)', fill:true, tension:.3 },
  ]}, options: barOpts() });

  charts.cat = new C($('#cCat'), { type:'doughnut', data:{ labels:breakdown.map(c=>c.name),
    datasets:[{ data:breakdown.map(c=>c.total), backgroundColor:breakdown.map(c=>c.color) }] },
    options:{ plugins:{ legend:{display:false} }, cutout:'60%' } });
}

function insights(k, breakdown, recMonthly){
  const tips = [];
  if(k.savingsRate!=null){
    if(k.savingsRate>=20) tips.push(`✅ Odlična stopa štednje (<b>${k.savingsRate.toFixed(0)}%</b>) ovog meseca. Ekonomska preporuka je 20%+.`);
    else if(k.savingsRate>=0) tips.push(`🟡 Štednja ovog meseca je <b>${k.savingsRate.toFixed(0)}%</b>. Cilj 20% — ima prostora.`);
    else tips.push(`🔴 Ovog meseca trošiš više nego što zarađuješ (štednja <b>${k.savingsRate.toFixed(0)}%</b>).`);
  }
  if(k.momSpend!=null){
    if(k.momSpend>10) tips.push(`📈 Potrošnja je skočila <b>${pct(k.momSpend)}</b> u odnosu na prošli mesec.`);
    else if(k.momSpend<-10) tips.push(`📉 Bravo — potrošnja je pala <b>${pct(k.momSpend)}</b> vs prošli mesec.`);
  }
  if(k.top) tips.push(`🏆 Najveća kategorija (${k.current.label}): <b>${esc(k.top.icon+' '+k.top.name)}</b> — ${fmt(k.top.total)} (${(k.top.total/k.current.spending*100||0).toFixed(0)}% potrošnje).`);
  if(recMonthly>0) tips.push(`🔁 Redovni/pretplatni troškovi te koštaju oko <b>${fmt(recMonthly)}</b> mesečno (${fmt(recMonthly*12)} godišnje).`);
  return `<section class="card insights"><h3>💡 Uvidi</h3>${tips.map(t=>`<div class="tip">${t}</div>`).join('')}</section>`;
}

const kpi = (label,val,sub,cls)=>`<div class="kpi ${cls}"><div class="kl">${label}</div><div class="kv">${val}</div><div class="ks">${sub}</div></div>`;
function barOpts(){ return { responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ labels:{ boxWidth:12, font:{size:11} } },
    tooltip:{ callbacks:{ label:c=>`${c.dataset.label}: ${fmtN(c.parsed.y)} RSD` } } },
  scales:{ y:{ ticks:{ callback:v=>fmtN(v) } }, x:{ ticks:{ font:{size:10} } } } }; }

// =================================================================== TRANSACTIONS
function renderTx(s){
  const accounts = repo.getAccounts();
  const cats = repo.getCategories();
  const months = an.monthly('RSD').map(x=>x.month).reverse();
  const acctMap = Object.fromEntries(accounts.map(a=>[a.id,a]));
  const catMapById = Object.fromEntries(cats.map(c=>[c.id,c]));
  let where = []; let params=[];
  if(filterMonth){ where.push(`substr(date,1,7)=?`); params.push(filterMonth); }
  if(txFilter.account){ where.push(`account_id=?`); params.push(txFilter.account); }
  if(txFilter.category){ where.push(`category_id=?`); params.push(txFilter.category); }
  if(txFilter.q){ where.push(`(UPPER(merchant) LIKE ? OR UPPER(description) LIKE ?)`); const q='%'+txFilter.q.toUpperCase()+'%'; params.push(q,q); }
  const rows = db.all(`SELECT * FROM transactions ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY date DESC, id DESC LIMIT 500`, params);
  const sumIn = rows.filter(r=>r.amount>0).reduce((s,r)=>s+r.amount,0);
  const sumOut = rows.filter(r=>r.amount<0).reduce((s,r)=>s-r.amount,0);

  s.innerHTML = `
    <div class="toolbar">
      <button class="primary" data-action="add-manual">＋ Dodaj</button>
      <select data-filter="month"><option value="">Svi meseci</option>${months.map(mm=>`<option value="${mm}" ${filterMonth===mm?'selected':''}>${an.fmtMonth(mm)}</option>`).join('')}</select>
      <select data-filter="account"><option value="">Svi računi</option>${accounts.map(a=>`<option value="${a.id}" ${txFilter.account==a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>
      <select data-filter="category"><option value="">Sve kategorije</option>${cats.map(c=>`<option value="${c.id}" ${txFilter.category==c.id?'selected':''}>${esc(c.icon+' '+c.name)}</option>`).join('')}</select>
      <input data-filter="q" placeholder="🔎 Traži…" value="${esc(txFilter.q||'')}" />
    </div>
    <div class="tx-summary"><span>${rows.length} transakcija</span><span class="pos">+${fmtN(sumIn)}</span><span class="neg">−${fmtN(sumOut)}</span></div>
    <div class="tx-list">
      ${rows.map(r=>{
        const a=acctMap[r.account_id], c=catMapById[r.category_id]||{};
        return `<div class="tx" data-txid="${r.id}">
          <div class="tx-ic" style="background:${(c.color||'#888')}22;color:${c.color||'#888'}">${c.icon||'•'}</div>
          <div class="tx-main">
            <div class="tx-t">${esc(r.merchant||r.description||'—')}</div>
            <div class="tx-s">${r.date} · ${esc(a?a.name:'')} · <span class="tx-cat" data-action="edit-cat" data-txid="${r.id}">${esc(c.name||'—')} ✎</span></div>
          </div>
          <div class="tx-amt ${r.amount<0?'neg':'pos'}">${r.amount<0?'−':'+'}${fmtN(Math.abs(r.amount))}<small>${r.currency}</small></div>
        </div>`;
      }).join('') || empty('🧾','Nema transakcija','Promeni filtere ili dodaj/uvezi podatke.')}
    </div>`;
  s.querySelectorAll('[data-filter]').forEach(elm=> elm.addEventListener('change', e=>{
    const f=e.target.dataset.filter, v=e.target.value;
    if(f==='month') filterMonth=v||null; else txFilter[f]=v||null; render();
  }));
  const q=$('[data-filter="q"]',s); if(q) q.addEventListener('input', debounce(e=>{ txFilter.q=e.target.value||null; render(); },300));
}
const txFilter = { account:null, category:null, q:null };

// =================================================================== IMPORT
function renderImport(s){
  s.innerHTML = `
    <section class="card">
      <h3>Uvoz PDF izvoda</h3>
      <p class="muted">Podržano: <b>Banca Intesa</b> izvod platnog računa. Možeš izabrati više fajlova odjednom. Duplikati se automatski preskaču.</p>
      <label class="dropzone" id="dz">
        <input type="file" id="fileIn" accept="application/pdf" multiple hidden />
        <div class="dz-in">📄 Dodirni da izabereš PDF izvode<br><small>ili prevuci fajlove ovde</small></div>
      </label>
      <div id="importStatus"></div>
    </section>
    <div id="importPreview"></div>`;
  const fi = $('#fileIn'), dz=$('#dz');
  fi.addEventListener('change', e=> handleFiles(e.target.files));
  ['dragover','dragenter'].forEach(ev=> dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.add('over');}));
  ['dragleave','drop'].forEach(ev=> dz.addEventListener(ev, e=>{e.preventDefault();dz.classList.remove('over');}));
  dz.addEventListener('drop', e=> handleFiles(e.dataTransfer.files));
}

async function handleFiles(fileList){
  const files = [...fileList].filter(f=>/pdf$/i.test(f.name));
  if(!files.length) return;
  const status = $('#importStatus'); status.innerHTML = `<div class="spinner">Obrađujem ${files.length} fajl(ova)…</div>`;
  pendingImports = [];
  for(const f of files){
    const res = await parseFile(f);
    pendingImports.push({ file:f.name, ...res });
  }
  status.innerHTML = '';
  renderPreview();
}

function renderPreview(){
  const wrap = $('#importPreview'); if(!wrap) return;
  const ok = pendingImports.filter(p=>p.ok);
  wrap.innerHTML = pendingImports.map(p=>{
    if(!p.ok) return `<section class="card imp err"><b>⚠️ ${esc(p.file)}</b><div class="muted">${esc(p.error)}</div></section>`;
    const t = p.parsed.transactions; const dates=t.map(x=>x.bookingDate).sort();
    const inc=t.filter(x=>x.signed>0).reduce((s,x)=>s+x.signed,0);
    const exp=t.filter(x=>x.signed<0).reduce((s,x)=>s-x.signed,0);
    const rec = p.recon && p.recon.ok===true ? '<span class="pos">✓ saldo se slaže</span>'
      : (p.recon && p.recon.ok===false ? '<span class="neg">⚠ saldo se ne slaže</span>' : '');
    return `<section class="card imp"><div class="row-between"><b>✅ ${esc(p.file)}</b>${rec}</div>
      <div class="imp-grid">
        <div><span>Banka</span>${p.bank}</div>
        <div><span>Račun</span>···${esc((p.parsed.account||'').slice(-4))} (${p.parsed.currency})</div>
        <div><span>Transakcija</span>${t.length}</div>
        <div><span>Period</span>${dates[0]||'?'} – ${dates[dates.length-1]||'?'}</div>
        <div><span>Prihodi</span><b class="pos">+${fmtN(inc)}</b></div>
        <div><span>Rashodi</span><b>−${fmtN(exp)}</b></div>
      </div></section>`;
  }).join('');
  if(ok.length) wrap.innerHTML += `<button class="primary big" data-action="confirm-import">Uvezi ${ok.length} izvod(a)</button>`;
}

async function confirmImport(){
  let totalIns=0, totalSkip=0;
  for(const p of pendingImports){
    if(!p.ok) continue;
    const r = repo.importStatement(p.parsed, p.file);
    totalIns += r.inserted; totalSkip += r.skipped;
  }
  await persist();
  pendingImports = [];
  toast(`Uvezeno ${totalIns} novih, preskočeno ${totalSkip} duplikata.`);
  view='dashboard'; render();
}

// =================================================================== ACCOUNTS
function renderAccounts(s){
  const balances = an.accountBalances();
  const nw = an.netWorth(getEurRate());
  s.innerHTML = `
    <section class="card"><div class="row-between"><h3>Neto vrednost</h3><b class="big-num">${fmt(nw.totalRSD)}</b></div>
      <div class="muted">EUR se preračunava po kursu <input type="number" id="eurRate" value="${getEurRate()}" step="0.1" style="width:80px"> RSD.</div>
    </section>
    ${balances.map(a=>`<section class="card acct-card">
      <div class="row-between"><div><b>${esc(a.name)}</b><div class="muted">${a.type==='cash'?'💵 keš':'🏦 banka'} · ${a.currency} · ${a.n} transakcija</div></div>
      <b class="${a.balance<0?'neg':''} big-num">${fmt(a.balance,a.currency)}</b></div>
    </section>`).join('')}
    <section class="card">
      <h3>Dodaj račun</h3>
      <input id="naName" placeholder="Naziv (npr. Banka 2 – tekući)" />
      <div class="form-row">
        <select id="naType"><option value="bank">Banka</option><option value="cash">Keš</option></select>
        <select id="naCur"><option>RSD</option><option>EUR</option></select>
        <input id="naOpen" type="number" placeholder="Početno stanje" />
      </div>
      <button class="primary" data-action="add-account">Dodaj račun</button>
    </section>`;
  $('#eurRate').addEventListener('change', async e=>{ setEurRate(+e.target.value); await persist(); render(); });
}

// =================================================================== SETTINGS
function renderSettings(s){
  const cats = repo.getCategories();
  const rules = db.all(`SELECT r.*, c.name AS cat, c.icon FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY r.priority, r.match`);
  s.innerHTML = `
    <section class="card">
      <h3>Izvoz podataka</h3>
      <p class="muted">Sigurnosna kopija ili dalja analiza u Excelu.</p>
      <div class="form-row">
        <button data-action="export-xlsx">📊 Excel (.xlsx)</button>
        <button data-action="export-csv">📄 CSV</button>
      </div>
    </section>
    <section class="card">
      <h3>Pravila kategorizacije <small>${rules.length}</small></h3>
      <p class="muted">Ako opis/trgovac sadrži tekst → dodeli kategoriju. Manji prioritet = proverava se prvo.</p>
      <div class="form-row">
        <input id="rMatch" placeholder="Tekst (npr. LIDL)" />
        <select id="rCat">${cats.map(c=>`<option value="${c.id}">${esc(c.icon+' '+c.name)}</option>`).join('')}</select>
        <button class="primary" data-action="add-rule">Dodaj</button>
      </div>
      <button data-action="recat">↻ Primeni pravila na nekategorisane</button>
      <div class="rules">
        ${rules.map(r=>`<div class="rule"><code>${esc(r.match)}</code> → ${esc(r.icon+' '+r.cat)} <span class="del" data-action="del-rule" data-id="${r.id}">✕</span></div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h3>Sigurnost</h3>
      <input type="password" id="np1" placeholder="Nova lozinka" />
      <input type="password" id="np2" placeholder="Ponovi novu lozinku" />
      <button data-action="change-pass">Promeni lozinku</button>
      <button class="ghost" data-action="lock">🔒 Zaključaj sada</button>
    </section>
    <section class="card muted small">
      Moj Budžet · podaci su šifrovani (AES-256-GCM) i čuvaju se samo na ovom uređaju.
      Aplikacija nema vezu sa internetom ni sa bankama.
    </section>`;
}

// =================================================================== EXPORT
function exportRows(){
  return db.all(`SELECT t.date AS Datum, a.name AS Racun, t.currency AS Valuta,
    CASE WHEN t.amount>0 THEN t.amount ELSE NULL END AS Priliv,
    CASE WHEN t.amount<0 THEN -t.amount ELSE NULL END AS Rashod,
    c.name AS Kategorija, t.merchant AS Trgovac, t.description AS Opis, t.balance AS Stanje, t.source AS Izvor
    FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
    ORDER BY t.date, t.id`);
}
function exportXlsx(){
  const rows = exportRows();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Transakcije');
  // monthly summary sheet
  const m = an.monthly('RSD').map(x=>({ Mesec:x.month, Prihodi:Math.round(x.realIncome), Rashodi:Math.round(x.spending), Stednja:Math.round(x.net) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m), 'Po mesecima');
  XLSX.writeFile(wb, `moj-budzet-${new Date().toISOString().slice(0,10)}.xlsx`);
}
function exportCsv(){
  const rows = exportRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`moj-budzet-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

// =================================================================== MODALS
function modal(html){
  const m = document.createElement('div'); m.className='modal-bg';
  m.innerHTML = `<div class="modal">${html}</div>`;
  m.addEventListener('click', e=>{ if(e.target===m) m.remove(); });
  document.body.appendChild(m); return m;
}
function addManualModal(){
  const accounts = repo.getAccounts();
  const cats = repo.getCategories();
  const today = new Date().toISOString().slice(0,10);
  const m = modal(`
    <h3>Nova transakcija</h3>
    <div class="seg"><button class="seg-b active" data-kind="expense">Rashod</button><button class="seg-b" data-kind="income">Prihod</button></div>
    <input id="mAmt" type="number" inputmode="decimal" placeholder="Iznos" />
    <input id="mDesc" placeholder="Opis / trgovac" />
    <div class="form-row">
      <select id="mAcc">${accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
      <input id="mDate" type="date" value="${today}" />
    </div>
    <select id="mCat">${cats.map(c=>`<option value="${c.id}" data-kind="${c.kind}">${esc(c.icon+' '+c.name)}</option>`).join('')}</select>
    <div class="form-row"><button class="ghost" data-close>Otkaži</button><button class="primary" id="mSave">Sačuvaj</button></div>
  `);
  let kind='expense';
  m.querySelectorAll('.seg-b').forEach(b=> b.onclick=()=>{ kind=b.dataset.kind; m.querySelectorAll('.seg-b').forEach(x=>x.classList.toggle('active',x===b)); });
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#mSave').onclick = async ()=>{
    const amount = parseFloat(m.querySelector('#mAmt').value);
    if(!(amount>0)){ m.querySelector('#mAmt').focus(); return; }
    repo.addManual({ account_id:+m.querySelector('#mAcc').value, date:m.querySelector('#mDate').value,
      amount, kind, category_id:+m.querySelector('#mCat').value, description:m.querySelector('#mDesc').value });
    await persist(); m.remove(); toast('Transakcija dodata.'); render();
  };
  m.querySelector('#mAmt').focus();
}
function editCatModal(txId){
  const cats = repo.getCategories();
  const tx = db.get(`SELECT * FROM transactions WHERE id=?`,[txId]);
  const m = modal(`<h3>Kategorija</h3><div class="muted">${esc(tx.merchant||tx.description||'')}</div>
    <div class="cat-pick">${cats.map(c=>`<button class="catp" data-cat="${c.id}" style="border-color:${c.color}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>
    <div class="form-row"><button class="ghost" data-close>Zatvori</button>
    <button class="del-tx" data-action="del-tx" data-id="${txId}">🗑 Obriši transakciju</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelectorAll('.catp').forEach(b=> b.onclick = async ()=>{ repo.setCategory(txId, +b.dataset.cat); await persist(); m.remove(); toast('Kategorija promenjena.'); render(); });
  m.querySelector('.del-tx').onclick = async ()=>{ if(confirm('Obrisati transakciju?')){ repo.deleteTransaction(txId); await persist(); m.remove(); render(); } };
}

// =================================================================== EVENTS
async function onClick(e){
  const tabBtn = e.target.closest('.tab'); if(tabBtn){ view=tabBtn.dataset.tab; render(); return; }
  const a = e.target.closest('[data-action]'); if(!a) return;
  const act = a.dataset.action;
  if(act==='lock'){ db.lock(); location.reload(); }
  else if(act==='goto'){ view=a.dataset.view; render(); }
  else if(act==='add-manual'){ addManualModal(); }
  else if(act==='edit-cat'){ editCatModal(+a.dataset.txid); }
  else if(act==='confirm-import'){ a.disabled=true; a.textContent='Uvozim…'; await confirmImport(); }
  else if(act==='add-account'){
    const name=$('#naName').value.trim(); if(!name) return;
    repo.addAccount({ name, type:$('#naType').value, currency:$('#naCur').value, opening_balance:parseFloat($('#naOpen').value)||0 });
    await persist(); toast('Račun dodat.'); render();
  }
  else if(act==='add-rule'){
    const mt=$('#rMatch').value.trim(); if(!mt) return;
    repo.addRule(mt, +$('#rCat').value, 3); await persist(); toast('Pravilo dodato.'); render();
  }
  else if(act==='del-rule'){ repo.deleteRule(+a.dataset.id); await persist(); render(); }
  else if(act==='recat'){ const n=repo.recategorizeAll(true); await persist(); toast(`Ažurirano ${n} transakcija.`); render(); }
  else if(act==='export-xlsx'){ exportXlsx(); }
  else if(act==='export-csv'){ exportCsv(); }
  else if(act==='change-pass'){
    const p1=$('#np1').value, p2=$('#np2').value;
    if(p1.length<6){ toast('Lozinka mora imati bar 6 znakova.',false); return; }
    if(p1!==p2){ toast('Lozinke se ne poklapaju.',false); return; }
    await db.changePassphrase(p1); toast('Lozinka promenjena.');
  }
}

// empty-state helper
function empty(icon,title,sub,btn,gotoView){
  return `<div class="empty"><div class="ei">${icon}</div><h3>${title}</h3><p>${sub}</p>${btn?`<button class="primary" data-action="goto" data-view="${gotoView}">${btn}</button>`:''}</div>`;
}
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

boot();
