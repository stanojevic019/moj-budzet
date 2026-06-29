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
let drillCat = null;       // category drill-down (id) or null
let budgetMonth = null;    // budgets view month (separate from tx filterMonth)
let showFilters = false;   // advanced filter panel open
let lockTimer = null;      // auto-lock timer
let swReg = null;          // service-worker registration

const todayISO = () => todayLocal();

// ---------- formatting ----------
const nf = (cur) => new Intl.NumberFormat('sr-RS', { style:'currency', currency:cur, maximumFractionDigits:0 });
const nf2 = new Intl.NumberFormat('sr-RS', { maximumFractionDigits:0 });
function fmt(n, cur='RSD'){ return nf(cur).format(n||0); }
function fmtN(n){ return nf2.format(Math.round(n||0)); }
function pct(n){ return (n>=0?'+':'') + (n==null?'–':n.toFixed(0)) + '%'; }
const esc = (s) => (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayLocal = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };

const CURRENCIES = ['RSD','EUR','USD','CHF','GBP'];
const DEFAULT_RATES = { EUR:117.5, USD:108, CHF:125, GBP:137 };
function getRate(ccy){
  if(ccy==='RSD') return 1;
  let v = +db.getSetting('rate_'+ccy, '');
  if(!(v>0) && ccy==='EUR') v = +db.getSetting('eur_rate','');   // legacy key
  if(!(v>0)) v = DEFAULT_RATES[ccy] || 1;
  return v>0 ? v : 1;
}
function setRate(ccy, v){ db.setSetting('rate_'+ccy, v); }
// currency→rate map for all currencies in use (+ the common ones), RSD=1
function rates(){
  const m = { RSD:1 }; const set = new Set(CURRENCIES);
  repo.getAccounts(true).forEach(a=>set.add(a.currency));
  set.forEach(c=>{ if(c!=='RSD') m[c] = getRate(c); });
  return m;
}
const hideAmounts = () => db.getSetting('hide_amounts','0')==='1';
const accent = () => db.getSetting('accent', '#3b82f6');
const autolockMin = () => +db.getSetting('autolock_min','5');
function applyPrefs(){
  document.body.classList.toggle('hide-amounts', hideAmounts());
  document.documentElement.style.setProperty('--accent', accent());
}

async function persist(){ await db.save(); }
function toast(msg, ok=true){
  const t = document.createElement('div'); t.className = 'toast '+(ok?'ok':'err'); t.textContent = msg;
  document.body.appendChild(t); setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, 3200);
}

// =================================================================== LOCK
async function boot(){
  registerSW();
  app.addEventListener('click', onClick); // bound once (not per unlock)
  ['click','keydown','touchstart','scroll'].forEach(ev=>document.addEventListener(ev, resetAutoLock, {passive:true}));
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
      let ok = false;
      try { ok = await db.unlock(pp); }
      catch(e){ err.textContent='Greška pri otključavanju (oštećena baza?).'; $('#lockBtn').disabled=false; $('#lockBtn').textContent='Otključaj'; return; }
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
  applyPrefs();
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">💰 Moj Budžet</div>
      <div class="tb-actions">
        <button class="iconbtn" data-action="toggle-hide" title="Sakrij/prikaži iznose">${hideAmounts()?'🙈':'👁️'}</button>
        <button class="iconbtn" data-action="lock" title="Zaključaj">🔒</button>
      </div>
    </header>
    <div id="updateBanner" class="update-banner hidden">⬆️ Nova verzija je dostupna. <button data-action="do-update">Osveži</button></div>
    <main id="screen"></main>
    <button class="fab" data-action="fab" title="Dodaj">＋</button>
    <nav class="tabbar">
      ${tab('dashboard','📊','Pregled')}
      ${tab('tx','🧾','Transakcije')}
      ${tab('budgets','🎯','Budžeti')}
      ${tab('accounts','🏦','Računi')}
      ${tab('settings','⚙️','Više')}
    </nav>`;
  resetAutoLock();
  render();
}
const tab = (id,icon,label) => `<button class="tab ${view===id?'active':''}" data-tab="${id}"><span>${icon}</span>${label}</button>`;

function render(){
  app.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===view));
  const fab = $('.fab'); if(fab) fab.style.display = view==='import' ? 'none' : '';
  const s = $('#screen'); if(!s) return;
  Object.values(charts).forEach(c=>{ try{c.destroy();}catch{} });
  if(view==='dashboard') renderDashboard(s);
  else if(view==='tx') renderTx(s);
  else if(view==='budgets') renderBudgets(s);
  else if(view==='import') renderImport(s);
  else if(view==='accounts') renderAccounts(s);
  else if(view==='settings') renderSettings(s);
  s.scrollTop = 0;
}

// =================================================================== DASHBOARD
function renderDashboard(s){
  const rate = rates();                  // currency→RSD map
  const m = an.monthly(rate);            // computed once, reused by kpis below
  const k = an.kpis(rate, m);
  const balances = an.accountBalances();
  const nw = an.netWorth(rate);
  if(!k){
    s.innerHTML = empty('📥','Još nema podataka','Uvezi PDF izvod ili ručno dodaj transakciju da vidiš analizu.','Idi na uvoz','import');
    return;
  }
  const months = m.map(x=>x.label);
  const allOut = an.categoryBreakdown(k.current.month,'expense',rate);
  const exSet = new Set(an.EXCLUDE_SPENDING);
  const breakdown = allOut.filter(c=>!exSet.has(c.name)).slice(0,8);   // real spending
  const flows = allOut.filter(c=>exSet.has(c.name));                   // transfers, cash, FX, loan principal
  const rec = an.recurring(rate);
  const recMonthly = rec.reduce((s,r)=>s+r.median,0);
  const runway = k.avgSpend ? nw.totalRSD / k.avgSpend : 0;
  const nws = an.netWorthSeries(rate);
  const nwTrend = nws.length>1 ? nws[nws.length-1].net - nws[nws.length-2].net : 0;
  const ww = an.needsWants(k.current.month, rate);
  const proj = an.projection(k.current.month, rate, todayISO());
  const budgets = an.budgetStatus(k.current.month, rate);
  const overBudget = budgets.filter(b=>b.over);
  const movers = an.categoryMovers(k.current.month, k.prev?k.prev.month:null, rate)
    .filter(x=>Math.abs(x.delta)>500).slice(0,5);

  s.innerHTML = `
    <div class="kpis">
      ${kpi('Neto vrednost', fmt(nw.totalRSD), `${balances.length} računa →`, '', 'data-action="goto" data-view="accounts"')}
      ${kpi('Potrošnja '+k.current.label, fmt(k.current.spending), k.momSpend==null?'':`${k.momSpend<=0?'📉':'📈'} ${pct(k.momSpend)} vs prošli mesec`, k.momSpend>0?'bad':'good', `data-action="spend-month" data-month="${k.current.month}"`)}
      ${kpi('Štednja '+k.current.label, fmt(k.current.net), k.savingsRate==null?'':`stopa štednje ${k.savingsRate.toFixed(0)}%`, k.current.net>=0?'good':'bad', 'data-action="goto" data-view="budgets"')}
      ${kpi('Prosečna potrošnja', fmt(k.avgSpend), `${k.monthsCount} mes. · rezerva ~${runway.toFixed(1)} mes.`, '')}
    </div>

    ${insights(k, breakdown, recMonthly, proj)}

    ${budgets.length ? `<section class="card" data-action="goto" data-view="budgets" style="cursor:pointer">
      <div class="row-between"><h3>🎯 Budžeti · ${k.current.label}</h3><small>${overBudget.length?`<span class="neg">${overBudget.length} prekoračeno</span>`:'sve u okviru ✓'}</small></div>
      ${budgets.slice(0,4).map(b=>budgetBar(b)).join('')}
      <div class="muted small" style="margin-top:6px">Dodirni za sve budžete →</div>
    </section>`:''}

    <section class="card">
      <h3>Pravilo 50/30/20 · ${k.current.label}</h3>
      ${ratioBar('Potrebe', ww.needs, k.current.realIncome, 50, '#22c55e')}
      ${ratioBar('Želje', ww.wants, k.current.realIncome, 30, '#f59e0b')}
      ${ratioBar('Štednja', Math.max(0,k.current.net), k.current.realIncome, 20, '#3b82f6')}
      <div class="muted small" style="margin-top:6px">Cilj: 50% potrebe · 30% želje · 20% štednja (od prihoda ${fmt(k.current.realIncome)})</div>
    </section>

    <section class="card">
      <h3>Prihodi vs rashodi po mesecima</h3>
      <div class="chart-wrap"><canvas id="cIE"></canvas></div>
    </section>

    <section class="card">
      <h3>Neto vrednost kroz vreme ${nwTrend>=0?'<span class="pos">📈</span>':'<span class="neg">📉</span>'}</h3>
      <div class="chart-wrap"><canvas id="cNW"></canvas></div>
    </section>

    <section class="card">
      <h3>Trend potrošnje i štednje</h3>
      <div class="chart-wrap"><canvas id="cTrend"></canvas></div>
    </section>

    <section class="card">
      <div class="row-between"><h3>Rashodi po kategorijama · ${k.current.label}</h3></div>
      <div class="chart-wrap small"><canvas id="cCat"></canvas></div>
      <div class="cat-legend">
        ${breakdown.map(c=>`<div class="cl" data-action="drill" data-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.icon)} ${esc(c.name)}<b>${fmt(c.total)}</b></div>`).join('')}
      </div>
      <div class="muted small">Dodirni kategoriju za detalje →</div>
    </section>

    ${flows.length ? `<section class="card">
      <div class="row-between"><h3>Ostali tokovi · ${k.current.label}</h3><small>transferi · keš · devize</small></div>
      ${flows.map(c=>`<div class="rec-row" data-action="drill" data-cat="${c.id}"><div>${esc(c.icon)} ${esc(c.name)}</div><b>${fmt(c.total)}</b></div>`).join('')}
      <div class="muted small" style="margin-top:6px">Dodirni za detalje (npr. Transfer drugima) →</div>
    </section>`:''}

    ${movers.length ? `<section class="card">
      <h3>Najveće promene vs ${k.prev?k.prev.label:'prošli mesec'}</h3>
      ${movers.map(x=>`<div class="rec-row" data-action="drill" data-cat="${x.cat.id||''}"><div>${esc(x.cat.icon)} ${esc(x.cat.name)}</div>
        <b class="${x.delta>0?'neg':'pos'}">${x.delta>0?'▲':'▼'} ${fmtN(Math.abs(x.delta))}</b></div>`).join('')}
    </section>`:''}

    <section class="card">
      <h3>Računi</h3>
      ${balances.map(a=>`<div class="acct-row" data-action="acct" data-acct="${a.id}"><span class="dot" style="background:${a.color}"></span>
        <div class="ar-name">${esc(a.name)}<small>${a.type==='cash'?'keš':'banka'} · ${a.n} tx</small></div>
        <b class="${a.balance<0?'neg':''}">${fmt(a.balance,a.currency)}</b></div>`).join('')}
    </section>

    ${rec.length?`<section class="card">
      <h3>Pretplate i redovni troškovi <small>~${fmt(recMonthly)}/mes</small></h3>
      ${rec.slice(0,12).map(r=>`<div class="rec-row" data-action="merch" data-merch="${esc(r.merchant)}"><div>${esc(r.merchant)}<small>${r.months} meseci</small></div><b>${fmt(r.median)}</b></div>`).join('')}
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

  charts.nw = new C($('#cNW'), { type:'line', data:{ labels:nws.map(x=>x.label), datasets:[
    { label:'Neto vrednost', data:nws.map(x=>x.net), borderColor:accent(), backgroundColor:'rgba(59,130,246,.12)', fill:true, tension:.3 },
  ]}, options: barOpts() });
}

// progress bar for a budget row
function budgetBar(b){
  const p = Math.min(100, b.pct);
  const col = b.pct>=100?'#ef4444':(b.pct>=80?'#eab308':'#22c55e');
  return `<div class="bbar"><div class="bbar-top"><span>${esc(b.icon)} ${esc(b.name)}</span>
    <span class="${b.over?'neg':''}">${fmt(b.spent)} / ${fmt(b.amount)}</span></div>
    <div class="bbar-track"><div class="bbar-fill" style="width:${p}%;background:${col}"></div></div></div>`;
}
// 50/30/20 ratio bar: actual vs target % of income
function ratioBar(label, value, income, targetPct, color){
  const actualPct = income>0 ? value/income*100 : 0;
  const w = Math.min(100, actualPct);
  return `<div class="bbar"><div class="bbar-top"><span>${label}</span>
    <span>${actualPct.toFixed(0)}% <small>(cilj ${targetPct}%)</small> · ${fmt(value)}</span></div>
    <div class="bbar-track"><div class="bbar-fill" style="width:${w}%;background:${color}"></div>
      <div class="bbar-target" style="left:${targetPct}%"></div></div></div>`;
}

function insights(k, breakdown, recMonthly, proj){
  const tips = [];
  if(proj && proj.day>=2){
    tips.push(`📅 Tempom od ${fmt(proj.spent)} za ${proj.day}. dana, do kraja meseca projektovano je <b>${fmt(proj.projected)}</b>.`);
  }
  if(k.savingsRate!=null){
    if(k.savingsRate>=20) tips.push(`✅ Odlična stopa štednje (<b>${k.savingsRate.toFixed(0)}%</b>) ovog meseca. Ekonomska preporuka je 20%+.`);
    else if(k.savingsRate>=0) tips.push(`🟡 Štednja ovog meseca je <b>${k.savingsRate.toFixed(0)}%</b>. Cilj 20% — ima prostora.`);
    else tips.push(`🔴 Ovog meseca trošiš više nego što zarađuješ (štednja <b>${k.savingsRate.toFixed(0)}%</b>).`);
  }
  if(k.momSpend!=null){
    if(k.momSpend>10) tips.push(`📈 Potrošnja je skočila <b>${pct(k.momSpend)}</b> u odnosu na prošli mesec.`);
    else if(k.momSpend<-10) tips.push(`📉 Bravo — potrošnja je pala <b>${pct(k.momSpend)}</b> vs prošli mesec.`);
  }
  if(k.top){ const share = k.current.spending>0 ? (k.top.total/k.current.spending*100) : 0;
    tips.push(`🏆 Najveća kategorija (${k.current.label}): <b>${esc(k.top.icon+' '+k.top.name)}</b> — ${fmt(k.top.total)} (${share.toFixed(0)}% potrošnje).`); }
  if(recMonthly>0) tips.push(`🔁 Redovni/pretplatni troškovi te koštaju oko <b>${fmt(recMonthly)}</b> mesečno (${fmt(recMonthly*12)} godišnje).`);
  return `<section class="card insights"><h3>💡 Uvidi</h3>${tips.map(t=>`<div class="tip">${t}</div>`).join('')}</section>`;
}

const kpi = (label,val,sub,cls,attrs='')=>`<div class="kpi ${cls}" ${attrs}><div class="kl">${label}</div><div class="kv">${val}</div><div class="ks">${sub}</div></div>`;
function barOpts(){ return { responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ labels:{ boxWidth:12, font:{size:11} } },
    tooltip:{ callbacks:{ label:c=>`${c.dataset.label}: ${fmtN(c.parsed.y)} RSD` } } },
  scales:{ y:{ ticks:{ callback:v=>fmtN(v) } }, x:{ ticks:{ font:{size:10} } } } }; }

// =================================================================== TRANSACTIONS
const txFilter = { account:null, category:null, q:null, from:null, to:null, min:null, max:null, type:null };
function activeFilterCount(){ let n = filterMonth?1:0;
  for(const k of ['account','category','q','from','to','type']) if(txFilter[k]) n++;
  if(+txFilter.min>0) n++; if(+txFilter.max>0) n++; return n; }
function clearFilters(){ Object.keys(txFilter).forEach(k=>txFilter[k]=null); filterMonth=null; drillCat=null; }

function buildTxWhere(){
  const where=[], params=[];
  if(filterMonth){ where.push(`substr(date,1,7)=?`); params.push(filterMonth); }
  if(txFilter.account){ where.push(`account_id=?`); params.push(txFilter.account); }
  if(txFilter.category){ where.push(`category_id=?`); params.push(txFilter.category); }
  if(txFilter.from){ where.push(`date>=?`); params.push(txFilter.from); }
  if(txFilter.to){ where.push(`date<=?`); params.push(txFilter.to); }
  if(txFilter.type==='income') where.push(`amount>0`);
  if(txFilter.type==='expense') where.push(`amount<0`);
  if(+txFilter.min>0){ where.push(`ABS(amount)>=?`); params.push(+txFilter.min); }
  if(+txFilter.max>0){ where.push(`ABS(amount)<=?`); params.push(+txFilter.max); }
  if(txFilter.q){ where.push(`(UPPER(merchant) LIKE ? OR UPPER(description) LIKE ? OR UPPER(counterparty) LIKE ?)`);
    const q='%'+txFilter.q.toUpperCase()+'%'; params.push(q,q,q); }
  return { whereSql: where.length?'WHERE '+where.join(' AND '):'', params };
}

function renderTx(s){
  const rate=rates();
  const accounts = repo.getAccounts();
  const cats = repo.getCategories();
  const months = an.monthly(rate).map(x=>x.month).reverse();
  const acctMap = Object.fromEntries(accounts.map(a=>[a.id,a]));
  const catMapById = Object.fromEntries(cats.map(c=>[c.id,c]));
  const { whereSql, params } = buildTxWhere();
  const rows = db.all(`SELECT * FROM transactions ${whereSql} ORDER BY date DESC, id DESC LIMIT 500`, params);
  const conv = an.convExpr(rate);
  const agg = db.get(`SELECT COUNT(*) AS n,
     COALESCE(SUM(CASE WHEN amount>0 THEN amount*${conv} ELSE 0 END),0) AS inc,
     COALESCE(SUM(CASE WHEN amount<0 THEN -amount*${conv} ELSE 0 END),0) AS out
     FROM transactions ${whereSql}`, params);
  const sumIn = agg.inc, sumOut = agg.out, totalN = agg.n;
  const drill = txFilter.category ? catMapById[txFilter.category] : null;

  s.innerHTML = `
    ${rows.length ? `<section class="card">
      <div class="row-between"><h3>${drill?`${esc(drill.icon)} ${esc(drill.name)}`:'Kretanje po mesecima'}</h3>${activeFilterCount()?`<button class="ghost sm" data-action="clear-filters">✕ filteri</button>`:''}</div>
      <div class="chart-wrap small"><canvas id="cFlt"></canvas></div>
    </section>`:''}
    <div class="toolbar">
      <select data-filter="month"><option value="">Svi meseci</option>${months.map(mm=>`<option value="${mm}" ${filterMonth===mm?'selected':''}>${an.fmtMonth(mm)}</option>`).join('')}</select>
      <select data-filter="account"><option value="">Svi računi</option>${accounts.map(a=>`<option value="${a.id}" ${txFilter.account==a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>
      <select data-filter="category"><option value="">Sve kategorije</option>${cats.map(c=>`<option value="${c.id}" ${txFilter.category==c.id?'selected':''}>${esc(c.icon+' '+c.name)}</option>`).join('')}</select>
      <input data-filter="q" placeholder="🔎 Traži…" value="${esc(txFilter.q||'')}" />
      <button class="ghost filt-toggle" data-action="toggle-filters">⚙︎ Filteri${activeFilterCount()?` (${activeFilterCount()})`:''}</button>
    </div>
    ${showFilters?`<section class="card filters">
      <div class="seg type-seg">
        <button class="seg-b ${!txFilter.type?'active':''}" data-type="">Sve</button>
        <button class="seg-b ${txFilter.type==='expense'?'active':''}" data-type="expense">Rashodi</button>
        <button class="seg-b ${txFilter.type==='income'?'active':''}" data-type="income">Prihodi</button>
      </div>
      <div class="form-row"><label class="fld">Od<input type="date" data-filter="from" value="${txFilter.from||''}"></label>
        <label class="fld">Do<input type="date" data-filter="to" value="${txFilter.to||''}"></label></div>
      <div class="form-row"><label class="fld">Min iznos<input type="number" data-filter="min" value="${txFilter.min||''}"></label>
        <label class="fld">Max iznos<input type="number" data-filter="max" value="${txFilter.max||''}"></label></div>
      <button class="ghost" data-action="clear-filters">Očisti sve filtere</button>
    </section>`:''}
    <div class="tx-summary"><span>${totalN>rows.length?`${rows.length} od ${totalN}`:`${totalN} transakcija`}</span><span class="pos">+${fmtN(sumIn)}</span><span class="neg">−${fmtN(sumOut)}</span></div>
    <div class="tx-list">
      ${rows.map(r=>{
        const a=acctMap[r.account_id], c=catMapById[r.category_id]||{};
        return `<div class="tx" data-txid="${r.id}">
          <div class="tx-ic" style="background:${(c.color||'#888')}22;color:${c.color||'#888'}">${esc(c.icon||'•')}</div>
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
  s.querySelectorAll('[data-type]').forEach(b=> b.addEventListener('click', ()=>{ txFilter.type=b.dataset.type||null; render(); }));

  if(rows.length){
    // chart reflects the CURRENT filters (month/account/category/type/amount/search)
    const fm = db.all(`SELECT substr(date,1,7) AS m,
      SUM(CASE WHEN amount<0 THEN -amount*${conv} ELSE 0 END) AS ex,
      SUM(CASE WHEN amount>0 THEN amount*${conv} ELSE 0 END) AS inc
      FROM transactions ${whereSql} GROUP BY m ORDER BY m`, params);
    charts.flt = new window.Chart($('#cFlt'), { type:'bar', data:{ labels:fm.map(r=>an.fmtMonth(r.m)),
      datasets:[
        { label:'Rashodi', data:fm.map(r=>r.ex), backgroundColor:'#ef4444' },
        { label:'Prihodi', data:fm.map(r=>r.inc), backgroundColor:'#22c55e' },
      ]}, options: barOpts() });
  }
}

// =================================================================== BUDGETS
function renderBudgets(s){
  const rate=rates();
  const m = an.monthly(rate);
  if(!m.length){ s.innerHTML = empty('🎯','Još nema podataka','Uvezi ili dodaj transakcije pa postavi mesečne budžete.','Dodaj/Uvezi','tx'); return; }
  const monthsList = m.map(x=>x.month).reverse();
  const month = (budgetMonth && monthsList.includes(budgetMonth)) ? budgetMonth : monthsList[0];
  const status = an.budgetStatus(month, rate);
  const cats = repo.getCategories().filter(c=>c.kind==='expense');
  const totalBudget = status.reduce((a,b)=>a+b.amount,0);
  const totalSpent = status.reduce((a,b)=>a+b.spent,0);
  s.innerHTML = `
    <div class="toolbar2">
      <select data-bmonth>${monthsList.map(mm=>`<option value="${mm}" ${mm===month?'selected':''}>${an.fmtMonth(mm)}</option>`).join('')}</select>
    </div>
    ${status.length?`<section class="card">
      <div class="row-between"><h3>Ukupno · ${an.fmtMonth(month)}</h3><b class="${totalSpent>totalBudget?'neg':''}">${fmt(totalSpent)} / ${fmt(totalBudget)}</b></div>
      ${status.map(b=>`<div data-action="drill" data-cat="${b.category_id}" style="cursor:pointer">${budgetBar(b)}</div>`).join('')}
    </section>`:`<div class="empty"><div class="ei">🎯</div><h3>Postavi prve budžete</h3><p>Unesi mesečni limit za kategorije ispod — pratićeš napredak i upozorenja.</p></div>`}
    <section class="card">
      <h3>Mesečni limiti po kategoriji</h3>
      <p class="muted small">Ostavi prazno da ukloniš budžet.</p>
      ${cats.map(c=>{ const b=status.find(x=>x.category_id===c.id);
        return `<div class="brow"><span>${esc(c.icon)} ${esc(c.name)}</span>
          <input type="number" inputmode="numeric" class="binput" data-budget="${c.id}" placeholder="—" value="${b?Math.round(b.amount):''}"></div>`; }).join('')}
    </section>`;
  $('[data-bmonth]',s)?.addEventListener('change', e=>{ budgetMonth=e.target.value; render(); });
  s.querySelectorAll('[data-budget]').forEach(inp=> inp.addEventListener('change', async e=>{
    repo.setBudget(+e.target.dataset.budget, parseFloat(e.target.value)||0); await persist(); toast('Budžet sačuvan.'); render();
  }));
}

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
      : (p.recon && p.recon.ok===false ? '<span class="neg">⚠ saldo se NE slaže — proveri uvoz</span>'
      : '<span class="muted">⚠ saldo nije proveren (nije nađeno početno stanje)</span>');
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
  const nw = an.netWorth(rates());
  // currencies in use (non-RSD) → editable rates; always offer EUR
  const used = [...new Set(balances.map(a=>a.currency))].filter(c=>c!=='RSD');
  if(!used.includes('EUR')) used.unshift('EUR');
  s.innerHTML = `
    <section class="card"><div class="row-between"><h3>Neto vrednost</h3><b class="big-num">${fmt(nw.totalRSD)}</b></div>
      <div class="muted small" style="margin-top:8px">Kursna lista (preračun u RSD):</div>
      ${used.map(c=>`<div class="brow"><span>1 ${c} =</span><input type="number" class="binput" data-rate="${c}" value="${getRate(c)}" step="0.1"> <span style="flex:none">RSD</span></div>`).join('')}
    </section>
    ${balances.map(a=>`<section class="card acct-card">
      <div class="row-between"><div><b>${esc(a.name)}</b><div class="muted">${a.type==='cash'?'💵 keš':'🏦 banka'} · ${a.currency} · ${a.n} transakcija</div></div>
      <b class="${a.balance<0?'neg':''} big-num">${fmt(a.balance,a.currency)}</b></div>
      <div class="form-row" style="margin-top:10px">
        <button class="ghost" data-action="acct" data-acct="${a.id}">Transakcije</button>
        <button class="ghost" data-action="edit-account" data-id="${a.id}">✎ Izmeni</button>
        <button class="primary" data-action="add-to-acct" data-acct="${a.id}">＋ Dodaj</button>
      </div>
    </section>`).join('')}
    <section class="card">
      <h3>Dodaj račun</h3>
      <input id="naName" placeholder="Naziv (npr. Banka 2 – tekući)" />
      <div class="form-row">
        <select id="naType"><option value="bank">Banka</option><option value="cash">Keš</option></select>
        <select id="naCur">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select>
        <input id="naOpen" type="number" placeholder="Početno stanje" />
      </div>
      <button class="primary" data-action="add-account">Dodaj račun</button>
    </section>`;
  s.querySelectorAll('[data-rate]').forEach(inp=> inp.addEventListener('change', async e=>{
    setRate(e.target.dataset.rate, +e.target.value); await persist(); render();
  }));
}

// =================================================================== SETTINGS
const ACCENTS = ['#3b82f6','#22c55e','#8b5cf6','#f97316','#ec4899','#14b8a6'];
function renderSettings(s){
  const cats = repo.getCategories();
  const rules = db.all(`SELECT r.*, c.name AS cat, c.icon FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY r.priority, r.match`);
  const al = autolockMin();
  s.innerHTML = `
    <section class="card">
      <h3>📥 Uvoz izvoda</h3>
      <p class="muted small">Uvezi PDF izvode (Banca Intesa). Duplikati se preskaču.</p>
      <button class="primary big" data-action="goto" data-view="import">Uvezi PDF izvod</button>
    </section>
    <section class="card">
      <h3>Izvoz podataka</h3>
      <div class="form-row">
        <button data-action="export-xlsx">📊 Excel (.xlsx)</button>
        <button data-action="export-csv">📄 CSV</button>
      </div>
    </section>
    <section class="card">
      <h3>Kategorije <small>${cats.length}</small></h3>
      <p class="muted small">Dodirni kategoriju za izmenu (ime, boja, grupa) ili brisanje.</p>
      <div class="cat-grid">
        ${cats.map(c=>`<button class="catchip" data-action="edit-category" data-id="${c.id}" style="border-color:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
      </div>
      <button data-action="add-category">＋ Nova kategorija</button>
    </section>
    <section class="card">
      <h3>Pravila kategorizacije <small>${rules.length}</small></h3>
      <p class="muted small">Ako opis/trgovac sadrži tekst → dodeli kategoriju.</p>
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
      <h3>Izgled</h3>
      <div class="muted small">Akcenat boja</div>
      <div class="accent-row">${ACCENTS.map(c=>`<button class="accent-dot ${accent()===c?'sel':''}" data-action="set-accent" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
    </section>
    <section class="card">
      <h3>🔒 Sigurnost</h3>
      <div class="muted small">Automatsko zaključavanje pri neaktivnosti</div>
      <select id="autolock">
        ${[['0','Isključeno'],['1','1 minut'],['5','5 minuta'],['15','15 minuta'],['30','30 minuta']].map(([v,l])=>`<option value="${v}" ${al==+v?'selected':''}>${l}</option>`).join('')}
      </select>
      <div class="muted small" style="margin-top:10px">Promena lozinke</div>
      <input type="password" id="np1" placeholder="Nova lozinka" />
      <input type="password" id="np2" placeholder="Ponovi novu lozinku" />
      <button data-action="change-pass">Promeni lozinku</button>
      <button class="ghost" data-action="lock">🔒 Zaključaj sada</button>
    </section>
    <section class="card muted small">
      Moj Budžet · podaci su šifrovani (AES-256-GCM, PBKDF2 ${(600000).toLocaleString('sr-RS')} iteracija) i čuvaju se samo na ovom uređaju. Bez interneta i bez bankarske veze.
    </section>`;
  $('#autolock',s)?.addEventListener('change', async e=>{ db.setSetting('autolock_min', +e.target.value); await persist(); resetAutoLock(); toast('Sačuvano.'); });
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
  const m = an.monthly(rates()).map(x=>({ Mesec:x.month, Prihodi:Math.round(x.realIncome), Rashodi:Math.round(x.spending), Stednja:Math.round(x.net) }));
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
function addManualModal(opts={}){
  const accounts = repo.getAccounts();
  const cats = repo.getCategories();
  const today = todayLocal();
  const m = modal(`
    <h3>Nova transakcija</h3>
    <div class="seg"><button class="seg-b active" data-kind="expense">Rashod</button><button class="seg-b" data-kind="income">Prihod</button></div>
    <input id="mAmt" type="number" inputmode="decimal" placeholder="Iznos" />
    <input id="mDesc" placeholder="Opis / trgovac" />
    <label class="fld">Račun<select id="mAcc">${accounts.map(a=>`<option value="${a.id}" ${opts.accountId==a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label>
    <div class="form-row">
      <label class="fld">Valuta<select id="mCur">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select></label>
      <label class="fld">Datum (može i raniji)<input id="mDate" type="date" value="${today}" max="${today}" /></label>
    </div>
    <div class="muted small" id="mCurHint"></div>
    <select id="mCat">${cats.map(c=>`<option value="${c.id}" data-kind="${c.kind}">${esc(c.icon+' '+c.name)}</option>`).join('')}</select>
    <div class="form-row"><button class="ghost" data-close>Otkaži</button><button class="primary" id="mSave">Sačuvaj</button></div>
  `);
  let kind='expense';
  m.querySelectorAll('.seg-b').forEach(b=> b.onclick=()=>{ kind=b.dataset.kind; m.querySelectorAll('.seg-b').forEach(x=>x.classList.toggle('active',x===b)); });
  m.querySelector('[data-close]').onclick=()=>m.remove();
  const accSel=m.querySelector('#mAcc'), curSel=m.querySelector('#mCur'), hint=m.querySelector('#mCurHint');
  // Currency follows the account; for the cash "slamarica" it's free to choose
  // (a different currency routes to that currency's own cash account).
  function syncCur(){
    const a = accounts.find(x=>x.id===+accSel.value);
    const cash = a && a.type==='cash';
    curSel.value = a ? a.currency : 'RSD';   // default to the account's own currency
    curSel.disabled = !cash;                 // cash: free to change; bank: fixed
    onCur();
  }
  function onCur(){
    const a = accounts.find(x=>x.id===+accSel.value);
    if(a && a.type==='cash' && curSel.value!==a.currency)
      hint.textContent = `Ide u keš „${curSel.value}" (kreira se ako ne postoji).`;
    else hint.textContent = '';
  }
  syncCur(); accSel.onchange=syncCur; curSel.onchange=onCur;
  m.querySelector('#mSave').onclick = async ()=>{
    const amount = parseFloat(m.querySelector('#mAmt').value);
    if(!(amount>0)){ m.querySelector('#mAmt').focus(); return; }
    let accId = +accSel.value;
    const acc = accounts.find(a=>a.id===accId);
    if(acc && acc.type==='cash' && curSel.value!==acc.currency) accId = repo.findOrCreateCashAccount(curSel.value).id;
    repo.addManual({ account_id:accId, date:m.querySelector('#mDate').value,
      amount, kind, category_id:+m.querySelector('#mCat').value, description:m.querySelector('#mDesc').value });
    await persist(); m.remove(); toast('Transakcija dodata.'); render();
  };
  m.querySelector('#mAmt').focus();
}
function editCatModal(txId){
  const cats = repo.getCategories();
  const tx = db.get(`SELECT * FROM transactions WHERE id=?`,[txId]);
  const m = modal(`<h3>Kategorija</h3><div class="muted">${esc(tx.merchant||tx.description||'')}</div>
    <div class="cat-pick">${cats.map(c=>`<button class="catp" data-cat="${c.id}" style="border-color:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>
    <div class="form-row"><button class="ghost" data-close>Zatvori</button>
    <button class="del-tx" data-action="del-tx" data-id="${txId}">🗑 Obriši transakciju</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelectorAll('.catp').forEach(b=> b.onclick = async ()=>{ repo.setCategory(txId, +b.dataset.cat); await persist(); m.remove(); toast('Kategorija promenjena.'); render(); });
  m.querySelector('.del-tx').onclick = async ()=>{ if(confirm('Obrisati transakciju?')){ repo.deleteTransaction(txId); await persist(); m.remove(); render(); } };
}

// FAB quick-action sheet
function fabSheet(){
  const m = modal(`<h3>Dodaj</h3>
    <button class="primary big" id="fbTx">＋ Nova transakcija</button>
    <button class="big" id="fbImp" style="margin-top:8px">📥 Uvezi PDF izvod</button>
    <button class="ghost" data-close style="width:100%;margin-top:8px">Otkaži</button>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#fbTx').onclick=()=>{ m.remove(); addManualModal(); };
  m.querySelector('#fbImp').onclick=()=>{ m.remove(); view='import'; render(); };
}
const CAT_COLORS=['#22c55e','#f97316','#eab308','#ef4444','#ec4899','#8b5cf6','#0ea5e9','#14b8a6','#f43f5e','#06b6d4','#64748b','#3b82f6'];
function categoryEditModal(id){
  const c = db.get(`SELECT * FROM categories WHERE id=?`,[id]); if(!c) return;
  const sys = repo.isProtectedCategory(id); // system category: only color/icon/grp editable
  const m = modal(`<h3>Izmena kategorije</h3>
    ${sys?'<div class="muted small">Sistemska kategorija — naziv se ne može menjati ni obrisati (koristi se u analizi).</div>':''}
    <div class="form-row"><input id="ceIcon" value="${esc(c.icon||'')}" placeholder="🏷️" style="flex:0 0 64px;text-align:center" />
      <input id="ceName" value="${esc(c.name)}" placeholder="Naziv" ${sys?'disabled':''} /></div>
    <select id="ceGrp"><option value="">— grupa (50/30/20) —</option>
      <option value="needs" ${c.grp==='needs'?'selected':''}>Potrebe</option>
      <option value="wants" ${c.grp==='wants'?'selected':''}>Želje</option></select>
    <div class="muted small" style="margin-top:8px">Boja</div>
    <div class="accent-row">${CAT_COLORS.map(col=>`<button class="accent-dot ${c.color===col?'sel':''}" data-col="${col}" style="background:${col}"></button>`).join('')}</div>
    <div class="form-row" style="margin-top:10px"><button class="ghost" data-close>Otkaži</button><button class="primary" id="ceSave">Sačuvaj</button></div>
    ${sys?'':'<button class="del-tx" id="ceDel" style="width:100%;margin-top:8px">🗑 Obriši kategoriju</button>'}`);
  let color=c.color;
  m.querySelectorAll('[data-col]').forEach(b=>b.onclick=()=>{ color=b.dataset.col; m.querySelectorAll('[data-col]').forEach(x=>x.classList.toggle('sel',x===b)); });
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#ceSave').onclick=async()=>{ const name=m.querySelector('#ceName').value.trim(); if(!name) return;
    try { repo.updateCategory(id,{ name, icon:m.querySelector('#ceIcon').value, color, grp:m.querySelector('#ceGrp').value||null }); }
    catch(e){ toast(e.message==='exists'?'Kategorija sa tim imenom već postoji.':'Greška.', false); return; }
    await persist(); m.remove(); toast('Kategorija sačuvana.'); render(); };
  const del=m.querySelector('#ceDel');
  if(del) del.onclick=async()=>{ if(confirm('Obrisati kategoriju? Njene transakcije se premeštaju u „Ostalo / Nekategorisano".')){
    if(repo.deleteCategory(id)){ await persist(); m.remove(); toast('Kategorija obrisana.'); render(); } else toast('Ova kategorija se ne može obrisati.',false); } };
}
function categoryAddModal(){
  const m = modal(`<h3>Nova kategorija</h3>
    <div class="form-row"><input id="caIcon" value="🏷️" style="flex:0 0 64px;text-align:center" /><input id="caName" placeholder="Naziv" /></div>
    <div class="form-row"><select id="caKind"><option value="expense">Rashod</option><option value="income">Prihod</option></select>
      <select id="caGrp"><option value="">— grupa —</option><option value="needs">Potrebe</option><option value="wants">Želje</option></select></div>
    <div class="form-row"><button class="ghost" data-close>Otkaži</button><button class="primary" id="caSave">Dodaj</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#caSave').onclick=async()=>{ const name=m.querySelector('#caName').value.trim(); if(!name) return;
    try { repo.addCategory({ name, kind:m.querySelector('#caKind').value, icon:m.querySelector('#caIcon').value, grp:m.querySelector('#caGrp').value||null, color:'#6b7280' }); }
    catch(e){ toast(e.message==='exists'?'Kategorija sa tim imenom već postoji.':'Greška.', false); return; }
    await persist(); m.remove(); toast('Kategorija dodata.'); render(); };
}

function accountEditModal(id){
  const a = db.get(`SELECT * FROM accounts WHERE id=?`,[id]); if(!a) return;
  const n = repo.accountTxCount(id);
  const m = modal(`<h3>Izmena računa</h3>
    <input id="aeName" value="${esc(a.name)}" placeholder="Naziv" />
    <div class="form-row">
      <label class="fld">Tip<select id="aeType"><option value="bank" ${a.type==='bank'?'selected':''}>Banka</option><option value="cash" ${a.type==='cash'?'selected':''}>Keš</option></select></label>
      <label class="fld">Valuta<select id="aeCur" ${n>0?'disabled':''}>${CURRENCIES.map(c=>`<option ${a.currency===c?'selected':''}>${c}</option>`).join('')}</select></label>
    </div>
    ${n>0?`<div class="muted small">Valuta se ne može menjati jer račun ima ${n} transakcija.</div>`:''}
    <div class="form-row" style="margin-top:10px"><button class="ghost" data-close>Otkaži</button><button class="primary" id="aeSave">Sačuvaj</button></div>
    <button class="del-tx" id="aeDel" style="width:100%;margin-top:8px">🗑 Obriši račun${n>0?` (+ ${n} transakcija)`:''}</button>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#aeSave').onclick=async()=>{ const name=m.querySelector('#aeName').value.trim(); if(!name) return;
    const fields={ name, type:m.querySelector('#aeType').value };
    if(n===0) fields.currency=m.querySelector('#aeCur').value;
    repo.updateAccount(id, fields); await persist(); m.remove(); toast('Račun sačuvan.'); render(); };
  m.querySelector('#aeDel').onclick=async()=>{ if(confirm(`Obrisati račun „${a.name}"${n>0?` i njegovih ${n} transakcija`:''}? Ovo se ne može poništiti.`)){
    repo.deleteAccount(id); await persist(); m.remove(); toast('Račun obrisan.'); render(); } };
}

// ---------- auto-lock ----------
function resetAutoLock(){
  if(lockTimer){ clearTimeout(lockTimer); lockTimer=null; }
  if(!db.isOpen()) return;
  const min = autolockMin();
  // Full reload (not partial re-render) so any open modal/toast showing decrypted
  // data is wiped along with the in-memory key — same as manual lock.
  if(min>0) lockTimer = setTimeout(()=>{ lockTimer=null; db.lock(); location.reload(); }, min*60000);
}

// ---------- service-worker auto-update ----------
let hadController = false, userTriggeredUpdate = false;
async function registerSW(){
  if(!('serviceWorker' in navigator)) return;
  hadController = !!navigator.serviceWorker.controller; // false on first-ever install
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    swReg.addEventListener('updatefound', ()=>{
      const nw = swReg.installing;
      if(nw) nw.addEventListener('statechange', ()=>{
        if(nw.state==='installed' && navigator.serviceWorker.controller) { const b=$('#updateBanner'); if(b) b.classList.remove('hidden'); }
      });
    });
    let reloaded=false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if(reloaded) return;
      if(!hadController && !userTriggeredUpdate) return; // don't reload on first install
      reloaded=true; location.reload();
    });
    setInterval(()=>swReg && swReg.update().catch(()=>{}), 60000);
  } catch {}
}
function doUpdate(){ userTriggeredUpdate=true; if(swReg && swReg.waiting) swReg.waiting.postMessage('skipWaiting'); else location.reload(); }

// =================================================================== EVENTS
async function onClick(e){
  resetAutoLock();
  const tabBtn = e.target.closest('.tab'); if(tabBtn){ if(view!==tabBtn.dataset.tab){ drillCat=null; } view=tabBtn.dataset.tab; render(); return; }
  const a = e.target.closest('[data-action]'); if(!a) return;
  const act = a.dataset.action;
  if(act==='lock'){ db.lock(); location.reload(); }
  else if(act==='goto'){ view=a.dataset.view; render(); }
  else if(act==='fab'){ fabSheet(); }
  else if(act==='add-manual'){ addManualModal(); }
  else if(act==='edit-cat'){ editCatModal(+a.dataset.txid); }
  else if(act==='toggle-hide'){ db.setSetting('hide_amounts', hideAmounts()?'0':'1'); await persist(); applyPrefs(); const btn=$('[data-action="toggle-hide"]'); if(btn) btn.textContent=hideAmounts()?'🙈':'👁️'; }
  else if(act==='drill'){ if(a.dataset.cat){ clearFilters(); txFilter.category=+a.dataset.cat; view='tx'; render(); } }
  else if(act==='acct'){ clearFilters(); txFilter.account=+a.dataset.acct; view='tx'; render(); }
  else if(act==='merch'){ clearFilters(); txFilter.q=a.dataset.merch; view='tx'; render(); }
  else if(act==='add-to-acct'){ addManualModal({ accountId:+a.dataset.acct }); }
  else if(act==='edit-account'){ accountEditModal(+a.dataset.id); }
  else if(act==='spend-month'){ clearFilters(); filterMonth=a.dataset.month; txFilter.type='expense'; view='tx'; render(); }
  else if(act==='toggle-filters'){ showFilters=!showFilters; render(); }
  else if(act==='clear-filters'){ clearFilters(); showFilters=false; render(); }
  else if(act==='edit-category'){ categoryEditModal(+a.dataset.id); }
  else if(act==='add-category'){ categoryAddModal(); }
  else if(act==='set-accent'){ db.setSetting('accent', a.dataset.color); await persist(); applyPrefs(); render(); }
  else if(act==='do-update'){ doUpdate(); }
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
