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
let dashPeriod = { preset:'6m', from:null, to:null };  // Pregled stats period
let dashRange = null;     // resolved {from,to,…} of dashPeriod for the current render
const charts = {};
let pendingImports = [];   // parsed files awaiting confirmation
let budgetMonth = null;    // budgets view month (separate from tx filterMonth)
let showFilters = false;   // advanced filter panel open
let lockTimer = null;      // auto-lock timer
let swReg = null;          // service-worker registration
let backArmed = false;     // history buffer for Android back button
let persistentStorage = null; // navigator.storage.persist() result (null = unknown)

const todayISO = () => todayLocal();

// ---------- formatting ----------
// Every amount on screen goes through fmt/fmtN, so "hide amounts" masks them all
// at the source (text, insights, chart axes and tooltips) — not via a CSS list.
let HIDE = false;
const MASK = '•••••';
const nfCache = {};
const nf = (cur) => nfCache[cur] || (nfCache[cur] = new Intl.NumberFormat('sr-RS', { style:'currency', currency:cur, maximumFractionDigits:0 }));
const nf2 = new Intl.NumberFormat('sr-RS', { maximumFractionDigits:0 });
function fmt(n, cur='RSD'){ return HIDE ? `${MASK} ${cur}` : nf(cur).format(n||0); }
function fmtN(n){ return HIDE ? MASK : nf2.format(Math.round(n||0)); }
const MONTHS_LONG = ['','januar','februar','mart','april','maj','jun','jul','avgust','septembar','oktobar','novembar','decembar'];
const MONTHS_SHORT = ['','jan','feb','mar','apr','maj','jun','jul','avg','sep','okt','nov','dec'];
// 'YYYY-MM' → "jun 2026"
const fmtMonthLong = (ym) => { const [y,m] = ym.split('-'); return `${MONTHS_SHORT[+m]} ${y}`; };
// range label: "jan – jun 2026" / "dec 2025 – jun 2026"
function fmtRange(from, to){
  if(from===to) return fmtMonthLong(to);
  const [fy,fm] = from.split('-'), [ty,tm] = to.split('-');
  return fy===ty ? `${MONTHS_SHORT[+fm]} – ${MONTHS_SHORT[+tm]} ${ty}` : `${fmtMonthLong(from)} – ${fmtMonthLong(to)}`;
}
// 'YYYY-MM-DD' → "Danas" / "Juče" / "29. jun 2026"
function fmtDay(iso){
  const t = todayLocal();
  const y = new Date(Date.parse(t) - 86400000).toISOString().slice(0,10);
  if(iso===t) return 'Danas'; if(iso===y) return 'Juče';
  const [yy,mm,dd] = iso.split('-');
  return `${+dd}. ${MONTHS_LONG[+mm]} ${yy}`;
}
// Statement names → readable: "Kupovina PAYSPOT DOO*BURGER HU BEOGRAD RS" → "PAYSPOT DOO · BURGER HU BEOGRAD"
function displayName(s){
  return String(s||'')
    .replace(/^(kupovina|plaćanje|placanje|uplata|isplata)\s+/i,'')
    .replace(/\s+[A-Z]{2}$/,'')          // trailing country code
    .replace(/\*/g,' · ').replace(/\s+/g,' ').trim() || '—';
}
function pct(n){ return (n>=0?'+':'') + (n==null?'–':n.toFixed(0)) + '%'; }
const esc = (s) => (s==null?'':String(s)).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayLocal = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
// grouped <select> options (optgroup per category group, subcategories as options)
function catSelectOptions(selectedId, kind){
  return repo.getCatTree().map(g => {
    const subs = kind ? g.subs.filter(c=>c.kind===kind) : g.subs;
    if(!subs.length) return '';
    return `<optgroup label="${esc(g.icon+' '+g.name)}">`
      + subs.map(c=>`<option value="${c.id}" ${selectedId==c.id?'selected':''}>${esc(c.icon+' '+c.name)}</option>`).join('')
      + `</optgroup>`;
  }).join('');
}
const groupSelectOptions = (selId) => repo.getCatTree()
  .map(g=>`<option value="${g.id}" ${selId==g.id?'selected':''}>${esc(g.icon+' '+g.name)}</option>`).join('');

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
const theme = () => db.getSetting('theme', 'auto');   // auto | dark | light
// Theme is also mirrored to localStorage (not sensitive) so the lock screen matches.
function applyTheme(t){
  const root = document.documentElement;
  if(t==='dark' || t==='light') root.dataset.theme = t; else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#0b1120';
  try { localStorage.setItem('mb-theme', t); } catch {}
}
function applyPrefs(){
  HIDE = hideAmounts();
  document.body.classList.toggle('hide-amounts', HIDE);
  document.documentElement.style.setProperty('--accent', accent());
  applyTheme(theme());
}
// Chart.js reads colors from the active theme (axes, grid, legend text).
function chartTheme(){
  const C = window.Chart; if(!C) return;
  const cs = getComputedStyle(document.body);
  C.defaults.color = cs.getPropertyValue('--muted').trim();
  C.defaults.borderColor = cs.getPropertyValue('--line').trim();
}
// Income/expense colors: blue vs orange stay distinguishable with red-green color blindness.
const C_INC = '#38bdf8', C_EXP = '#f97316', C_SAVE = '#a78bfa';

// ---------- icons (inline SVG: identical on every platform, unlike emoji) ----------
const svg = (p) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${p}</svg>`;
const ICON = {
  dash: svg('<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'),
  tx: svg('<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  budget: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  bank: svg('<path d="M3 21h18M5 21v-9M10 21v-9M14 21v-9M19 21v-9M2.5 10 12 4l9.5 6z"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5"/><path d="M3 3l18 18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

// ---------- accessibility pass (after every render / modal) ----------
// Tappable non-buttons become keyboard/screen-reader buttons; inputs that only
// have a placeholder get it as their accessible name.
function a11y(root){
  root.querySelectorAll('[data-action]:not(button):not(input):not(select):not(a),[data-cat].catp')
    .forEach(el => { if(!el.hasAttribute('role')){ el.setAttribute('role','button'); el.tabIndex = 0; } });
  root.querySelectorAll('input:not([type=hidden]),select').forEach(el => {
    if(el.getAttribute('aria-label') || el.closest('label')) return;
    const name = el.placeholder || el.dataset.filter;
    if(name) el.setAttribute('aria-label', el.placeholder || ({month:'Mesec',account:'Račun',category:'Kategorija'}[el.dataset.filter]) || name);
  });
}
document.addEventListener('keydown', e => {
  if((e.key==='Enter' || e.key===' ') && e.target.getAttribute && e.target.getAttribute('role')==='button'){
    e.preventDefault(); e.target.click();
  }
});

async function persist(){
  try { await db.save(); }
  catch(e){ toast('⚠ Greška pri čuvanju podataka na uređaju. Napravi rezervnu kopiju.', false); throw e; }
}
// Lock = wait for pending saves, drop the key, full reload (wipes decrypted DOM too).
async function lockNow(){
  try { await db.flush(); } catch {}
  db.lock(); location.reload();
}
// toast(msg, ok, action?) — action = { label, fn } adds a button (e.g. "Poništi").
function toast(msg, ok=true, action=null){
  document.querySelectorAll('.toast').forEach(x => x.remove());   // one at a time, no stacking
  const t = document.createElement('div'); t.className = 'toast '+(ok?'ok':'err');
  t.setAttribute('role', ok ? 'status' : 'alert'); t.setAttribute('aria-live', ok ? 'polite' : 'assertive');
  const span = document.createElement('span'); span.textContent = msg; t.appendChild(span);
  if(action){
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { t.remove(); action.fn(); }; t.appendChild(b);
  }
  document.body.appendChild(t); setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, action ? 7000 : 3200);
}
// Run a destructive change with a one-tap undo (in-memory DB snapshot).
async function withUndo(doneMsg, fn){
  const snap = db.snapshot();
  const res = fn();
  await persist(); render();
  toast(doneMsg, true, { label:'Poništi', fn: async () => {
    if(db.restoreSnapshot(snap)){ await persist(); render(); toast('Poništeno.'); }
  }});
  return res;
}

// =================================================================== LOCK
async function boot(){
  try { applyTheme(localStorage.getItem('mb-theme') || 'auto'); } catch {}
  registerSW();
  app.addEventListener('click', onClick); // bound once (not per unlock)
  window.addEventListener('popstate', onBack);
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
      <input type="password" id="pp" placeholder="Lozinka" aria-label="Lozinka" autocomplete="${exists?'current-password':'new-password'}" />
      ${exists?'':'<input type="password" id="pp2" placeholder="Ponovi lozinku" aria-label="Ponovi lozinku" autocomplete="new-password" />'}
      <button id="lockBtn" class="primary big">${exists?'Otključaj':'Kreiraj sef'}</button>
      <div class="lock-err" id="lockErr"></div>
      <button class="ghost" id="lockRestore" style="margin-top:10px">📂 Vrati iz rezervne kopije</button>
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
  $('#lockRestore').onclick = () => backupImportPick(false);
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
        <button class="iconbtn" data-action="toggle-hide" title="Sakrij/prikaži iznose" aria-label="${HIDE?'Prikaži iznose':'Sakrij iznose'}" aria-pressed="${HIDE}">${HIDE?ICON.eyeOff:ICON.eye}</button>
        <button class="iconbtn" data-action="lock" title="Zaključaj" aria-label="Zaključaj">${ICON.lock}</button>
      </div>
    </header>
    <div id="updateBanner" class="update-banner hidden" role="status">⬆️ Nova verzija je dostupna. <button data-action="do-update">Osveži</button></div>
    <main id="screen"></main>
    <button class="fab" data-action="fab" title="Dodaj" aria-label="Dodaj transakciju ili uvezi izvod">${ICON.plus}</button>
    <nav class="tabbar" aria-label="Glavni meni">
      ${tab('dashboard',ICON.dash,'Pregled')}
      ${tab('tx',ICON.tx,'Transakcije')}
      ${tab('budgets',ICON.budget,'Budžeti')}
      ${tab('accounts',ICON.bank,'Računi')}
      ${tab('settings',ICON.more,'Više')}
    </nav>`;
  // FAB hides while scrolling down a list (so it doesn't cover amounts), returns on scroll up
  let lastY = window.scrollY;
  window.onscroll = () => { const f=$('.fab'); if(!f) return; const y=window.scrollY;
    f.classList.toggle('fab-away', y > lastY + 4 && y > 120); if(y < lastY - 4) f.classList.remove('fab-away'); lastY = y; };
  if(updateReady){ const b=$('#updateBanner'); if(b) b.classList.remove('hidden'); }
  // one-time: after a migration that added rules, re-categorize the "Ostalo" backlog
  if(db.getSetting('recat_pending')==='1'){
    const n = repo.recategorizeAll(true); db.setSetting('recat_pending','0'); persist().catch(()=>{});
    if(n) setTimeout(()=>toast(`Auto-kategorizovano ${n} stavki novim pravilima.`), 700);
  }
  // one-time: bank transfers to companies (fuel, insurance, shops) were filed as
  // "Transfer drugima" and so missing from spending — re-categorize them.
  if(db.getSetting('fix_company_transfers')==='1'){
    const n = repo.fixCompanyTransfers(); db.setSetting('fix_company_transfers','0'); persist().catch(()=>{});
    if(n) setTimeout(()=>toast(`${n} plaćanja firmama prebačeno iz „Transfer drugima" u potrošnju.`), 1400);
  }
  // one-time (v13): bind "person → pass-through / exchange" memories to their amounts
  if(db.getSetting('bind_learned')==='1'){
    repo.bindLearnedAmounts(); db.setSetting('bind_learned','0'); persist().catch(()=>{});
  }
  // ask the browser to keep our data (no eviction on low storage / inactivity)
  db.requestPersistence().then(ok=>{ persistentStorage = ok; });
  resetAutoLock();
  render();
}
const tab = (id,icon,label) => `<button class="tab ${view===id?'active':''}" data-tab="${id}" ${view===id?'aria-current="page"':''}><span>${icon}</span>${label}</button>`;

function render(){
  app.querySelectorAll('.tab').forEach(t=>{ const on = t.dataset.tab===view; t.classList.toggle('active', on);
    if(on) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current'); });
  const fab = $('.fab'); if(fab){ fab.style.display = view==='import' ? 'none' : ''; fab.classList.remove('fab-away'); }
  const s = $('#screen'); if(!s) return;
  Object.values(charts).forEach(c=>{ try{c.destroy();}catch{} });
  chartTheme();
  if(view==='dashboard') renderDashboard(s);
  else if(view==='tx') renderTx(s);
  else if(view==='budgets') renderBudgets(s);
  else if(view==='import') renderImport(s);
  else if(view==='accounts') renderAccounts(s);
  else if(view==='settings') renderSettings(s);
  a11y(s);
  ensureBackArmed();
}

// ---------- Android back button: step back / close modal instead of exiting ----------
function ensureBackArmed(){
  if(db.isOpen() && !backArmed){ try { history.pushState({ mb:1 }, ''); } catch {} backArmed = true; }
}
function onBack(){
  backArmed = false;                                  // our buffer entry was just consumed
  const m = document.querySelector('.modal-bg');
  if(m){ m.remove(); ensureBackArmed(); return; }     // 1) back closes an open modal
  if(db.isOpen() && view!=='dashboard'){ showFilters=false; view='dashboard'; render(); return; } // 2) → home (render re-arms)
  if(db.isOpen()) toast('Nazad još jednom za izlaz.'); // 3) on home: next back exits the app
}

// =================================================================== DASHBOARD
// Collapsible dashboard sections: open/closed state is remembered (encrypted setting).
const DASH_OPEN_DEFAULT = ['ie'];
function dashOpen(){ try { return new Set(JSON.parse(db.getSetting('dash_open','null')) || DASH_OPEN_DEFAULT); } catch { return new Set(DASH_OPEN_DEFAULT); } }
function fold(id, title, body, open, extra=''){
  return `<details class="card fold" data-fold="${id}" ${open.has(id)?'open':''}>
    <summary><h3>${title}</h3>${extra}</summary>${body}</details>`;
}
const UNCAT = 'Ostalo / Nekategorisano';

function renderDashboard(s){
  const rate = rates();                  // currency→RSD map
  const m = an.monthly(rate);            // full history — drives the timeline charts
  const nw = an.netWorth(rate);
  if(!m.length){
    s.innerHTML = empty('📥','Još nema podataka','Uvezi PDF izvod ili ručno dodaj transakciju da vidiš analizu.','Idi na uvoz','import');
    return;
  }
  // selected period governs every aggregate card and chart
  const range = resolveDashPeriod(m);
  dashRange = range;
  const periodObj = range.single ? range.from : { from:range.from, to:range.to };
  const prevRange = previousWindow(range);
  const big = bigThreshold();
  const mw = an.monthly(rate, { from:range.from, to:range.to }, big);  // windowed months
  const pSpending = mw.reduce((s,x)=>s+x.spending,0);
  const pNet      = mw.reduce((s,x)=>s+x.net,0);
  const pIncome   = mw.reduce((s,x)=>s+x.realIncome,0);
  const monthsData = mw.length || 1;
  const avgSpend  = pSpending / monthsData;   // average monthly spending within the selected period
  const savingsRate = pIncome ? pNet/pIncome*100 : null;
  // The current calendar month is still in progress: compare it with the SAME number
  // of days of the previous month, not the whole previous month (else every month
  // "drops" 50%+ mid-month).
  const today = todayISO(), curMonth = today.slice(0,7);
  const partial = range.single && range.to === curMonth;
  let prevSpending;
  if(partial){
    const pm = dashMonthAdd(curMonth, -1), [py,pmo] = pm.split('-').map(Number);
    const day = Math.min(+today.slice(8,10), new Date(py, pmo, 0).getDate());
    prevSpending = an.spendingBetween(`${pm}-01`, `${pm}-${String(day).padStart(2,'0')}`, rate);
  } else prevSpending = prevRange ? an.monthly(rate, prevRange).reduce((s,x)=>s+x.spending,0) : 0;
  const momSpend = prevSpending ? (pSpending-prevSpending)/prevSpending*100 : null;
  const cmpLabel = partial ? `vs prvih ${+today.slice(8,10)} dana pret. meseca` : 'vs pret. period';

  const allOut = an.categoryBreakdown(periodObj,'expense',rate);
  const exSet = new Set(an.EXCLUDE_SPENDING);
  const cidx = {}; repo.getCategories(true).forEach(c=>cidx[c.id]=c);
  const groupOf = (id)=>{ const c=cidx[id]; return c && c.parent_id!=null ? (cidx[c.parent_id]||c) : c; };
  const gAgg = {};                                                     // roll real spending up to groups
  for(const r of allOut){ if(exSet.has(r.name)) continue; const g=groupOf(r.id); if(!g) continue;
    const e = gAgg[g.id] || (gAgg[g.id]={ id:g.id, name:g.name, icon:g.icon, color:g.color, total:0 }); e.total += r.total; }
  const breakdown = Object.values(gAgg).sort((a,b)=>b.total-a.total).slice(0,8);
  const realOut = allOut.filter(c=>!exSet.has(c.name));
  const topCat = realOut.find(c=>c.name!==UNCAT) || null;              // "uncategorized" is not a category to celebrate
  const uncSpend = (realOut.find(c=>c.name===UNCAT)||{total:0}).total;
  const uncShare = pSpending>0 ? uncSpend/pSpending*100 : 0;
  const uncN = repo.uncategorizedCount();
  const flows = allOut.filter(c=>exSet.has(c.name));                   // transfers, cash, FX, loan principal
  const rec = an.recurring(rate);   // subscriptions need multiple months → always full history
  const recMonthly = rec.reduce((s,r)=>s+r.monthly,0);
  const nwsAll = an.netWorthSeries(rate);
  const nws = nwsAll.filter(x=> x.month>=range.from && x.month<=range.to);   // clip net-worth line to the period
  const nwTrend = nws.length>1 ? nws[nws.length-1].net - nws[nws.length-2].net : 0;
  // net worth as of the END of the period, the change (Δ) during it, and the
  // reconciliation: startNW + realIncome − realSpending + otherFlows = endNW
  const endNW = (nwsAll.find(x=>x.month===range.to) || { net: nw.totalRSD }).net;
  const pcond = range.preset==='all' ? '' : `WHERE substr(date,1,7) BETWEEN ? AND ?`;
  const nwDelta = db.get(`SELECT COALESCE(SUM(amount*${an.convExpr(rate)}),0) AS d FROM transactions ${pcond}`,
    range.preset==='all' ? [] : [range.from, range.to]).d;
  const startNW = endNW - nwDelta;
  const otherFlows = nwDelta - pNet;   // transfers / cash / FX / loan principal (excluded from spending & income)
  const ww = an.needsWants(periodObj, rate);
  const proj = range.single ? an.projection(range.to, rate, todayISO()) : null;
  const budgets = an.budgetStatus(periodObj, rate, range.single?1:range.months);
  const overBudget = budgets.filter(b=>b.over);
  const movers = an.categoryMovers(periodObj, prevRange, rate)
    .filter(x=>Math.abs(x.delta)>500 && x.cat.name!==UNCAT).slice(0,5);
  // period summary handed to the KPI cards + insights
  const P = { label:range.label, spending:pSpending, net:pNet, realIncome:pIncome,
    savingsRate, momSpend, cmpLabel, top:topCat, uncShare, uncN };
  const months = mw.map(x=>x.label);   // charts follow the selected period
  const PERIODS = [['month','Mesec'],['3m','3m'],['6m','6m'],['12m','12m'],['ytd','Godina'],['all','Sve'],['custom','Biraj']];
  const open = dashOpen();
  const flow = an.moneyFlow({ from:range.from, to:range.to }, rate, big);
  const ideas = an.savingIdeas({ from:range.from, to:range.to }, rate, range.months, big);
  const pBig = mw.reduce((s,x)=>s+x.big,0), pRegular = pSpending - pBig;
  P.big = pBig; P.bigN = flow.bigList.length; P.regularAvg = pRegular / monthsData; P.months = monthsData;

  s.innerHTML = `
    <div class="seg period-seg" role="group" aria-label="Period statistike">
      ${PERIODS.map(([v,l])=>`<button class="seg-b ${range.preset===v?'active':''}" data-action="dash-period" data-preset="${v}" aria-pressed="${range.preset===v}">${l}</button>`).join('')}
    </div>
    ${range.preset==='custom'?`<div class="form-row period-custom">
      <label class="fld">Od<input type="month" id="dpFrom" min="${m[0].month}" max="${m[m.length-1].month}" value="${range.from}"></label>
      <label class="fld">Do<input type="month" id="dpTo" min="${m[0].month}" max="${m[m.length-1].month}" value="${range.to}"></label>
    </div>`:''}
    <div class="muted small period-note">Period: <b>${esc(range.label)}</b>${range.single?'':` · ${range.months} mes.`}${partial?' · mesec je u toku':''}</div>

    <div class="kpis">
      ${kpi('Neto vrednost', fmt(endNW), `${nwDelta>=0?'▲':'▼'} ${fmtN(Math.abs(nwDelta))} u periodu`, 'wide', 'data-action="goto" data-view="accounts"')}
      ${kpi('Priliv', fmt(P.realIncome), 'po kategorijama', '', 'data-action="kpi-income"')}
      ${kpi('Potrošnja', fmt(P.spending), pBig>0 ? `redovno ${fmtN(pRegular)} · jednokratno ${fmtN(pBig)}` : (P.momSpend==null?'po kategorijama':`${P.momSpend<=0?'▼':'▲'} ${pct(P.momSpend)} ${cmpLabel}`), P.momSpend>10?'bad':'', 'data-action="kpi-spend"')}
      ${kpi('Ostalo ti je', fmt(P.net), P.savingsRate==null?'prihodi − svi odlivi':`stopa štednje ${P.savingsRate.toFixed(0)}%`, P.net>=0?'good':'bad', 'data-action="kpi-save"')}
      ${range.single ? '' : kpi('Redovno mesečno', fmt(P.regularAvg), `sa povremenim (servis…), bez jednokratnih · ${monthsData} mes.`, '', 'data-action="kpi-avg"')}
    </div>

    ${uncN ? `<section class="card uncat" data-action="triage">
      <div class="row-between"><h3>❓ ${uncN} ${uncN===1?'transakcija čeka':'transakcija čeka'} kategoriju</h3><span class="pill">Razvrstaj</span></div>
      <div class="muted small">${uncShare>=1?`${uncShare.toFixed(0)}% potrošnje u periodu nije razvrstano, pa grupe i budžeti nisu tačni. `:''}Aplikacija pamti tvoj izbor i sledeći put razvrstava sama.</div>
    </section>` : ''}

    ${cashCard()}

    ${flowCard(flow, monthsData, cidx)}

    ${passThroughCard()}

    ${insights(P, breakdown, recMonthly, proj)}

    ${budgets.length ? `<section class="card" data-action="goto" data-view="budgets">
      <div class="row-between"><h3>🎯 Budžeti</h3><small>${overBudget.length?`<span class="neg">${overBudget.length} prekoračeno</span>`:'sve u okviru ✓'}</small></div>
      ${budgets.slice(0,4).map(b=>budgetBar(b)).join('')}
    </section>`:''}

    <section class="card">
      <h3>Rashodi po grupama</h3>
      <div class="chart-wrap small"><canvas id="cCat" role="img" aria-label="Udeo grupa u potrošnji"></canvas></div>
      <div class="cat-legend">
        ${breakdown.map(c=>`<div class="cl" data-action="drill-group" data-group="${c.id}"><span class="dot" style="background:${c.color}"></span><span class="cl-n">${esc(c.icon)} ${esc(c.name)}</span><b>${fmt(c.total)}</b></div>`).join('')}
      </div>
    </section>

    ${ideasCard(ideas)}

    ${fold('ie','Prihodi i rashodi po mesecima', `<div class="chart-wrap"><canvas id="cIE" role="img" aria-label="Prihodi i rashodi po mesecima"></canvas></div>`, open)}
    ${fold('ratio','Pravilo 50/30/20', `
      ${ratioBar('Potrebe', ww.needs, P.realIncome, 50, '#22c55e')}
      ${ratioBar('Želje', ww.wants, P.realIncome, 30, '#f59e0b')}
      ${ratioBar('Štednja', Math.max(0,P.net), P.realIncome, 20, '#3b82f6')}
      <div class="muted small" style="margin-top:6px">Cilj: 50% potrebe · 30% želje · 20% štednja, od prihoda u periodu.</div>`, open)}
    ${fold('nw',`Neto vrednost kroz vreme`, `<div class="chart-wrap"><canvas id="cNW" role="img" aria-label="Neto vrednost kroz vreme"></canvas></div>`, open,
      `<small class="${nwTrend>=0?'pos':'neg'}">${nwTrend>=0?'▲':'▼'}</small>`)}
    ${fold('bridge','Kako se slaže neto vrednost', `
      <div class="rec-row"><div>${range.preset==='all'?'Početna stanja računa':'Na početku perioda'}</div><b>${fmt(startNW)}</b></div>
      <div class="rec-row"><div>＋ Realni prihodi</div><b class="pos">+${fmtN(pIncome)}</b></div>
      <div class="rec-row"><div>− Potrošnja</div><b class="neg">−${fmtN(pSpending)}</b></div>
      <div class="rec-row"><div>− Keš, prenosi ljudima, glavnica kredita</div><b class="neg">−${fmtN(pSpending ? pIncome - pSpending - pNet : 0)}</b></div>
      <div class="rec-row"><div>± Menjačnica, prolazni novac, kursne razlike</div><b class="${otherFlows<0?'neg':'pos'}">${otherFlows<0?'−':'+'}${fmtN(Math.abs(otherFlows))}</b></div>
      <div class="rec-row total"><div><b>Na kraju perioda</b></div><b>${fmt(endNW)}</b></div>
      <div class="muted small" style="margin-top:6px">„Ostalo ti je" = prihodi − svi odlivi. Razlika do neto vrednosti su kursne razlike i novac koji samo prođe (menjačnica, prolazni novac).</div>`, open)}
    ${fold('trend','Trend potrošnje i štednje', `<div class="chart-wrap"><canvas id="cTrend" role="img" aria-label="Trend potrošnje i štednje"></canvas></div>`, open)}
    ${movers.length ? fold('movers','Najveće promene vs prethodni period', movers.map(x=>`<div class="rec-row" data-action="drill" data-cat="${x.cat.id||''}"><div>${esc(x.cat.icon)} ${esc(x.cat.name)}</div>
        <b class="${x.delta>0?'neg':'pos'}">${x.delta>0?'▲':'▼'} ${fmtN(Math.abs(x.delta))}</b></div>`).join(''), open) : ''}
    ${rec.length ? fold('rec','Pretplate i redovna plaćanja', `
      <div class="muted small">Jednom mesečno, isti iznos, bar 3 meseca.</div>
      ${rec.slice(0,12).map(r=>`<div class="rec-row" data-action="merch" data-merch="${esc(r.merchant)}"><div>${esc(displayName(r.merchant))}<small>${cidx[r.category_id]?esc(cidx[r.category_id].icon+" "+cidx[r.category_id].name)+" · ":""}${r.months} meseci${r.count>r.months?` · ${r.count}×`:''}</small></div><b>${fmt(r.monthly)}/mes</b></div>`).join('')}`, open,
      `<small>~${fmt(recMonthly)}/mes</small>`) : ''}
  `;

  // charts — built only for open sections (and on first open), so a collapsed
  // dashboard stays light and canvases never render at 0×0
  const C = window.Chart;
  const builders = {
    ie: () => charts.ie = new C($('#cIE'), { type:'bar', data:{ labels:months, datasets:[
      { label:'Prihodi', data:mw.map(x=>x.realIncome), backgroundColor:C_INC, borderRadius:4, stack:'in' },
      { label:'Redovna potrošnja', data:mw.map(x=>Math.max(0,x.regular)), backgroundColor:C_EXP, stack:'out' },
      { label:'Jednokratno', data:mw.map(x=>x.big), backgroundColor:C_BIG, borderRadius:4, stack:'out' },
    ]}, options: barOpts({ stacked:true }) }),
    trend: () => charts.trend = new C($('#cTrend'), { type:'line', data:{ labels:months, datasets:[
      { label:'Redovna potrošnja', data:mw.map(x=>x.regular), borderColor:C_EXP, backgroundColor:'rgba(249,115,22,.1)', fill:true, tension:.3 },
      { label:'Štednja', data:mw.map(x=>x.net), borderColor:C_SAVE, backgroundColor:'rgba(167,139,250,.1)', fill:true, tension:.3, borderDash:[5,4] },
    ]}, options: barOpts() }),
    nw: () => charts.nw = new C($('#cNW'), { type:'line', data:{ labels:nws.map(x=>x.label), datasets:[
      { label:'Neto vrednost', data:nws.map(x=>x.net), borderColor:accent(), backgroundColor:'rgba(59,130,246,.12)', fill:true, tension:.3 },
    ]}, options: barOpts() }),
  };
  charts.cat = new C($('#cCat'), { type:'doughnut', data:{ labels:breakdown.map(c=>c.name),
    datasets:[{ data:breakdown.map(c=>c.total), backgroundColor:breakdown.map(c=>c.color), borderColor:getComputedStyle(document.body).getPropertyValue('--card').trim() }] },
    options:{ maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:c=>`${c.label}: ${fmt(c.parsed)}` } } }, cutout:'60%' } });
  s.querySelectorAll('details[data-fold]').forEach(d => {
    const id = d.dataset.fold;
    if(d.open && builders[id]) builders[id]();
    d.addEventListener('toggle', () => {
      if(d.open && builders[id] && !charts[id]?.canvas?.isConnected) builders[id]();
      const st = dashOpen(); d.open ? st.add(id) : st.delete(id);
      db.setSetting('dash_open', JSON.stringify([...st])); persist().catch(()=>{});
    });
  });

  $('#dpFrom',s)?.addEventListener('change', e=>{ dashPeriod.from = e.target.value||null; render(); });
  $('#dpTo',s)?.addEventListener('change', e=>{ dashPeriod.to = e.target.value||null; render(); });
}

const C_BIG = '#fbbf24';
const bigThreshold = () => +db.getSetting('big_tx', String(an.BIG_DEFAULT)) || an.BIG_DEFAULT;
// "Kuda ide novac": every outflow of the period in buckets that add up, against income.
function flowCard(f, months, cidx){
  const catId = (name) => (Object.values(cidx).find(c=>c.name===name) || {}).id || '';
  const rows = [
    { k:'regular', label:'Redovna potrošnja', sub:'hrana, gorivo, računi, kupovina…', v:f.regular, color:C_EXP, attrs:'data-action="kpi-spend"' },
    { k:'periodic', label:'Povremeni veliki troškovi', sub:(f.funds||[]).map(p=>p.cat.name).join(', ')+' · ponavljaju se', v:f.periodic, color:'#fb923c', attrs:'' },
    { k:'big', label:'Veliki jednokratni izdaci', sub:`pojedinačno od ${fmt(bigThreshold())}`, v:f.oneOffs, color:C_BIG, attrs:'' },
    { k:'cash', label:'Keš sa bankomata', sub:'ne zna se na šta je potrošen', v:f.cash, color:'#94a3b8', attrs:`data-action="drill" data-cat="${catId('Podizanje keša')}"` },
    { k:'people', label:'Prenosi ljudima', sub:'neto: poslato − primljeno', v:f.people, color:'#f59e0b', attrs:`data-action="drill" data-cat="${catId('Transfer drugima')}"` },
    { k:'loan', label:'Otplata kredita', sub:'glavnica', v:f.loan, color:'#b91c1c', attrs:`data-action="drill" data-cat="${catId('Kredit – glavnica')}"` },
  ].filter(r => r.v > 0.5);
  if(!rows.length && !f.income) return '';
  const scale = Math.max(f.income, f.out) || 1;
  const per = (v) => months > 1 ? `<small>≈ ${fmt(v/months)}/mes</small>` : '';
  return `<section class="card flow">
    <h3>Kuda ide novac</h3>
    <div class="flow-bar" aria-hidden="true">${rows.map(r=>`<span style="width:${(r.v/scale*100).toFixed(2)}%;background:${r.color}"></span>`).join('')}</div>
    <div class="flow-bar in" aria-hidden="true"><span style="width:${(f.income/scale*100).toFixed(2)}%;background:${C_INC}"></span></div>
    ${rows.map(r=>`<div class="rec-row" ${r.attrs}><span class="dot" style="background:${r.color}"></span><div>${r.label}<small>${r.sub}</small></div>
      <div class="flow-v"><b>${fmt(r.v)}</b>${per(r.v)}</div></div>
      ${r.k==='big' || r.k==='periodic' ? (r.k==='big' ? f.bigList : f.periodicList).slice(0,4).map(t=>`<div class="rec-row sub" data-action="edit-cat" data-txid="${t.id}"><div>${esc(displayName(t.merchant||t.description))}<small>${fmtDay(t.date)} · ${esc(t.cat?t.cat.name:'—')}</small></div><b>${fmt(t.v)}</b></div>`).join('') : ''}`).join('')}
    <div class="rec-row total"><span class="dot" style="background:${C_INC}"></span><div>Prilivi<small>plata i ostali prihodi</small></div><div class="flow-v"><b class="pos">${fmt(f.income)}</b>${per(f.income)}</div></div>
    <div class="rec-row"><div><b>${f.left>=0?'Ostalo ti je':'Potrošeno više nego što je ušlo'}</b></div><div class="flow-v"><b class="${f.left>=0?'pos':'neg'}">${f.left>=0?'+':'−'}${fmtN(Math.abs(f.left))}</b>${per(Math.abs(f.left))}</div></div>
    <div class="muted small" style="margin-top:6px">Ne računa se novac koji samo prolazi: između tvojih računa, menjačnica, „Prolazni novac".</div>
  </section>`;
}
// Recent untracked ATM withdrawals → "where did it go?" (one tap per part).
function cashCard(){
  const q = repo.cashToSplit(); if(!q.length) return '';
  const sum = q.reduce((s,t)=>s+Math.abs(t.amount),0);
  return `<section class="card uncat" data-action="cash-split">
    <div class="row-between"><h3>💵 Na šta je otišao keš?</h3><span class="pill">Razvrstaj</span></div>
    <div class="muted small">${q.length} ${q.length===1?'podizanje':'podizanja'} sa bankomata (${fmt(sum)}) ne zna se na šta je potrošeno. Par dodira po podizanju — i keš prestaje da bude slepa tačka.</div>
  </section>`;
}
// Pass-through money (e.g. rent collected for someone): was the last receipt forwarded?
function passThroughCard(){
  const p = repo.passThroughStatus(todayISO()); if(!p) return '';
  const inTxt = `${fmt(p.lastIn.amount, p.lastIn.currency)} primljeno ${fmtDay(p.lastIn.date)}`;
  if(p.forwarded){
    const o = p.out[p.out.length-1];
    return `<section class="card pt ok" data-action="drill" data-cat="${p.catId}"><div class="row-between"><h3>↔️ Prolazni novac</h3><span class="pos">prosleđeno ✓</span></div>
      <div class="muted small">${inTxt} → prosleđeno ${fmt(Math.abs(o.amount), o.currency)} (${fmtDay(o.date)}).</div></section>`;
  }
  return `<section class="card pt ${p.days>25?'late':''}" data-action="drill" data-cat="${p.catId}"><div class="row-between"><h3>↔️ Prolazni novac</h3><span class="${p.days>25?'neg':'muted'}">čeka (${p.days} d)</span></div>
    <div class="muted small">${inTxt} — još se ne vidi da je prosleđeno. Ako jeste, uvezi novi izvod.</div></section>`;
}
// Split recent ATM withdrawals into what the cash was spent on.
function cashSplitModal(){
  const snap = db.snapshot(); let done = 0;
  const skipped = new Set();
  const choices = repo.cashSplitChoices();
  const m = modal(`<h3>Na šta je otišao keš?</h3><div id="csBody"></div>`);
  const body = m.querySelector('#csBody');
  const finish = async () => {
    m.remove();
    if(done){ await persist(); render();
      toast(`Razvrstano ${done} ${done===1?'podizanje':'podizanja'} keša.`, true, { label:'Poništi', fn: async () => {
        if(db.restoreSnapshot(snap)){ await persist(); render(); toast('Poništeno.'); } } }); }
  };
  const show = () => {
    const tx = repo.cashToSplit().find(t => !skipped.has(t.id));
    if(!tx) return finish();
    const total = Math.abs(tx.amount); const parts = [];
    const draw = () => {
      const used = parts.reduce((s,p)=>s+(+p.amount||0),0), rest = Math.max(0, total-used);
      body.innerHTML = `${txSummaryHtml(tx)}
        <div class="muted small" style="margin:8px 0 4px">Dodirni na šta je otišao (može više):</div>
        <div class="cat-pick">${choices.map(c=>`<button class="catp" data-c="${c.id}" style="border-left-color:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>
        ${parts.map((p,i)=>`<div class="rec-row cs-row"><div>${esc(p.label)}</div><input type="number" inputmode="decimal" min="0" step="any" class="cs-amt" data-i="${i}" value="${p.amount}" aria-label="Iznos za ${esc(p.label)}"><button class="ghost cs-del" data-i="${i}" aria-label="Ukloni">✕</button></div>`).join('')}
        <div class="rec-row"><div>Nepoznato</div><b>${fmt(rest, tx.currency)}</b></div>
        <div class="form-row"><button class="ghost" data-x="close">Zatvori</button><button data-x="skip">Preskoči</button></div>
        <div class="form-row"><button data-x="unknown">Sve nepoznato</button><button class="primary" data-x="save" ${parts.length?'':'disabled'}>Sačuvaj</button></div>`;
      body.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
        const c = choices.find(x=>x.id===+b.dataset.c);
        const r = Math.max(0, total - parts.reduce((s,p)=>s+(+p.amount||0),0));
        parts.push({ category_id:c.id, label:`${c.icon} ${c.name}`, amount: Math.round(r) }); draw();
        const inp = body.querySelectorAll('.cs-amt'); const last = inp[inp.length-1]; if(last){ last.focus(); last.select(); }
      });
      body.querySelectorAll('.cs-amt').forEach(inp => inp.onchange = () => { parts[+inp.dataset.i].amount = Math.max(0, +inp.value||0); draw(); });
      body.querySelectorAll('.cs-del').forEach(b => b.onclick = () => { parts.splice(+b.dataset.i,1); draw(); });
      body.querySelector('[data-x="close"]').onclick = finish;
      body.querySelector('[data-x="skip"]').onclick = () => { skipped.add(tx.id); show(); };
      const commit = async (list) => { repo.splitCash(tx.id, list); done++; await persist(); show(); };
      body.querySelector('[data-x="unknown"]').onclick = () => commit([]);
      body.querySelector('[data-x="save"]').onclick = () => commit(parts);
    };
    draw();
  };
  show();
}
// "Gde možeš da uštediš": concrete, period-based suggestions.
function ideasCard(ideas){
  if(!ideas.length) return '';
  const cuts = ideas.filter(i=>i.type==='cut').slice(0,4);
  const total = cuts.reduce((s,i)=>s+i.save,0);
  return `<section class="card ideas">
    <div class="row-between"><h3>💰 Gde možeš da uštediš</h3>${total?`<small>do ${fmt(total)}/mes</small>`:''}</div>
    ${cuts.length ? `<div class="muted small">Ako „želje" smanjiš za 30%:</div>` : ''}
    ${cuts.map(i=>`<div class="rec-row" data-action="drill" data-cat="${i.cat.id}"><div>${esc(i.cat.icon)} ${esc(i.cat.name)}<small>sada ~${fmt(i.monthly)} mesečno</small></div>
      <div class="flow-v"><b class="pos">−${fmt(i.save)}</b><small>${fmt(i.save*12)} godišnje</small></div></div>`).join('')}
    ${ideas.filter(i=>i.type==='fund').map(i=>`<div class="tip" data-action="drill" data-cat="${i.cat.id}">🔧 <b>${esc(i.cat.name)}</b>: ${i.n} velika izdatka za ${i.span} mes. (ukupno ${fmt(i.total)}). To nije izuzetak nego redovan trošak — odvajaj <b>~${fmt(i.monthly)} mesečno</b> pa te sledeći neće iznenaditi.</div>`).join('')}
    ${ideas.filter(i=>i.type==='trips').map(i=>`<div class="tip">🛒 <b>${esc(displayName(i.merchant))}</b>: ~${i.perMonth.toFixed(0)} odlazaka mesečno, prosečno ${fmt(i.avg)}. Ređa, planirana kupovina obično smanji ukupan račun.</div>`).join('')}
    ${ideas.filter(i=>i.type==='cash').map(i=>`<div class="tip">💵 Oko <b>${fmt(i.monthly)}</b> mesečno podigneš u kešu bez evidencije. Uključi „Novčanik" (Više → Keš) ili plaćaj karticom — ne možeš da smanjiš ono što ne vidiš.</div>`).join('')}
  </section>`;
}

// Resolve the dashboard period selector into concrete month bounds, clamped to data.
function dashMonthAdd(ym, delta){ let [y,mo]=ym.split('-').map(Number); mo+=delta; y+=Math.floor((mo-1)/12); mo=((mo-1)%12+12)%12+1; return `${y}-${String(mo).padStart(2,'0')}`; }
function dashMonthDiff(a,b){ const [ay,am]=a.split('-').map(Number),[by,bm]=b.split('-').map(Number); return (by-ay)*12+(bm-am); }
function resolveDashPeriod(mAll){
  const all = mAll.map(x=>x.month); const first=all[0], last=all[all.length-1];
  const p = dashPeriod.preset; let from=first, to=last;
  if(p==='month'){ from=to=last; }
  else if(p==='3m'){ from=dashMonthAdd(last,-2); }
  else if(p==='6m'){ from=dashMonthAdd(last,-5); }
  else if(p==='12m'){ from=dashMonthAdd(last,-11); }
  else if(p==='ytd'){ from=last.slice(0,4)+'-01'; }
  else if(p==='all'){ from=first; to=last; }
  else if(p==='custom'){ from=dashPeriod.from||first; to=dashPeriod.to||last; if(from>to){ const t=from; from=to; to=t; } }
  if(from<first) from=first; if(to>last) to=last;
  const single = from===to;
  const label = p==='all' ? `sve (${fmtRange(from,to)})` : fmtRange(from, to);
  return { from, to, months: dashMonthDiff(from,to)+1, single, label, preset:p };
}
// The equal-length window immediately before the selected one (for % comparisons).
function previousWindow(range){
  if(range.preset==='all') return null;
  return { from: dashMonthAdd(range.from, -range.months), to: dashMonthAdd(range.from, -1) };
}
// Apply the active dashboard period as a date filter when drilling into the tx list.
function applyDashPeriod(){
  if(dashRange && dashRange.preset!=='all'){ txFilter.from=`${dashRange.from}-01`; txFilter.to=`${dashRange.to}-31`; }
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

function insights(P, breakdown, recMonthly, proj){
  const tips = [];
  if(proj && proj.day>=2){
    tips.push(`📅 Tempom od ${fmt(proj.spent)} za ${proj.day}. dana, do kraja meseca projektovano je <b>${fmt(proj.projected)}</b>.`);
  }
  if(P.savingsRate!=null){
    if(P.savingsRate>=20) tips.push(`✅ Odlična stopa štednje (<b>${P.savingsRate.toFixed(0)}%</b>) za period ${P.label}. Ekonomska preporuka je 20%+.`);
    else if(P.savingsRate>=0) tips.push(`🟡 Štednja u periodu ${P.label} je <b>${P.savingsRate.toFixed(0)}%</b>. Cilj 20% — ima prostora.`);
    else tips.push(`🔴 U periodu ${P.label} trošiš više nego što zarađuješ (štednja <b>${P.savingsRate.toFixed(0)}%</b>).`);
  }
  if(P.momSpend!=null){
    if(P.momSpend>10) tips.push(`📈 Potrošnja je skočila <b>${pct(P.momSpend)}</b> ${P.cmpLabel}.`);
    else if(P.momSpend<-10) tips.push(`📉 Bravo — potrošnja je pala <b>${pct(P.momSpend)}</b> ${P.cmpLabel}.`);
  }
  if(P.big>0) tips.push(`🧾 ${P.bigN===1?'Jedan veliki jednokratni izdatak':`${P.bigN} velikih jednokratnih izdataka`} (${fmt(P.big)}). Bez ${P.bigN===1?'njega':'njih'} trošiš oko <b>${fmt(P.regularAvg)}</b> mesečno.`);
  if(P.top){ const share = P.spending>0 ? (P.top.total/P.spending*100) : 0;
    tips.push(`🏷️ Najviše trošiš na <b>${esc(P.top.icon+' '+P.top.name)}</b> — ${fmt(P.top.total)} (${share.toFixed(0)}% potrošnje).`); }
  if(P.uncShare>=15) tips.push(`⚠️ <b>${P.uncShare.toFixed(0)}%</b> potrošnje nije razvrstano — uvidi ispod su zato nepotpuni. Razvrstaj ih gore ↑`);
  if(recMonthly>0) tips.push(`🔁 Pretplate i redovna plaćanja: oko <b>${fmt(recMonthly)}</b> mesečno (${fmt(recMonthly*12)} godišnje).`);
  if(!tips.length) return '';
  return `<section class="card insights"><h3>💡 Uvidi</h3>${tips.map(t=>`<div class="tip">${t}</div>`).join('')}</section>`;
}

const kpi = (label,val,sub,cls,attrs='')=>`<div class="kpi ${cls}" ${attrs}><div class="kl">${label}</div><div class="kv">${val}</div><div class="ks">${sub}</div></div>`;
function barOpts(o={}){ return { responsive:true, maintainAspectRatio:false,
  plugins:{ legend:{ labels:{ boxWidth:12, font:{size:12} } },
    tooltip:{ callbacks:{ label:c=>`${c.dataset.label}: ${fmtN(c.parsed.y)} RSD` } } },
  scales:{ y:{ stacked:!!o.stacked, ticks:{ font:{size:11}, callback:v=>HIDE ? '' : (Math.abs(v)>=1000 ? fmtN(v/1000)+'k' : fmtN(v)) } },
    x:{ stacked:!!o.stacked, ticks:{ font:{size:11} }, grid:{ display:false } } } }; }

// =================================================================== TRANSACTIONS
const txFilter = { account:null, category:null, group:null, q:null, from:null, to:null, min:null, max:null, type:null };
function activeFilterCount(){ let n = filterMonth?1:0;
  for(const k of ['account','category','group','q','from','to','type']) if(txFilter[k]) n++;
  if(+txFilter.min>0) n++; if(+txFilter.max>0) n++; return n; }
function clearFilters(){ Object.keys(txFilter).forEach(k=>txFilter[k]=null); filterMonth=null; }

function buildTxWhere(){
  const where=[], params=[];
  if(filterMonth){ where.push(`substr(date,1,7)=?`); params.push(filterMonth); }
  if(txFilter.account){ where.push(`account_id=?`); params.push(txFilter.account); }
  if(txFilter.category){ where.push(`category_id=?`); params.push(txFilter.category); }
  if(txFilter.group){ where.push(`category_id IN (SELECT id FROM categories WHERE id=? OR parent_id=?)`); params.push(txFilter.group, txFilter.group); }
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
  // +/− totals and the chart follow the dashboard's money-flow rules: real income
  // in, real spending out (net of refunds/shared paybacks); transfers, cash, FX and
  // pass-through money are neither.
  const allCats = Object.fromEntries(repo.getCategories(true).map(c=>[c.id,c]));
  const byMonth = {}; let sumIn = 0, sumOut = 0;
  const allRows = db.all(`SELECT date, amount, currency, category_id FROM transactions ${whereSql}`, params);
  for(const r of allRows){
    const cls = an.classify(allCats[r.category_id] || null, r.amount), v = Math.abs(r.amount * (rate[r.currency] || 1));
    const o = byMonth[r.date.slice(0,7)] || (byMonth[r.date.slice(0,7)] = { inc:0, ex:0 });
    if(cls==='income'){ sumIn += v; o.inc += v; } else if(cls==='spend'){ sumOut += v; o.ex += v; } else if(cls==='refund'){ sumOut -= v; o.ex -= v; }
  }
  const totalN = allRows.length;
  const drill = (txFilter.group ? catMapById[txFilter.group] : null) || (txFilter.category ? catMapById[txFilter.category] : null);
  const nFilters = activeFilterCount();
  // keep the search box focused across re-renders while typing
  const typing = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.filter==='q';

  // group rows by day: "Danas" / "Juče" / "29. jun 2026"
  let lastDay = null;
  const list = rows.map(r=>{
    const a=acctMap[r.account_id], c=catMapById[r.category_id]||{};
    const head = r.date!==lastDay ? `<div class="day-h">${fmtDay(r.date)}</div>` : '';
    lastDay = r.date;
    const uncat = c.name === UNCAT;
    return `${head}<div class="tx" data-action="edit-cat" data-txid="${r.id}" aria-label="${esc(displayName(r.merchant||r.description))}, ${r.amount<0?'rashod':'prihod'} ${esc(fmtN(Math.abs(r.amount)))} ${r.currency}, ${esc(c.name||'bez kategorije')}">
      <div class="tx-ic" style="background:${(c.color||'#888')}22;color:${c.color||'#888'}" aria-hidden="true">${esc(c.icon||'•')}</div>
      <div class="tx-main">
        <div class="tx-t">${esc(displayName(r.merchant||r.description))}</div>
        <div class="tx-s"><span class="tx-cat ${uncat?'uncat':''}">${uncat?'Razvrstaj':esc(c.name||'—')}</span> · ${esc(a?a.name:'')}</div>
      </div>
      <div class="tx-amt ${r.amount<0?'neg':'pos'}">${r.amount<0?'−':'+'}${fmtN(Math.abs(r.amount))}<small>${r.currency}</small></div>
    </div>`;
  }).join('');

  s.innerHTML = `
    <div class="toolbar">
      <input type="search" data-filter="q" placeholder="Traži trgovca ili opis…" aria-label="Pretraga transakcija" value="${esc(txFilter.q||'')}" />
      <select data-filter="month" aria-label="Mesec"><option value="">Svi meseci</option>${months.map(mm=>`<option value="${mm}" ${filterMonth===mm?'selected':''}>${fmtMonthLong(mm)}</option>`).join('')}</select>
      <select data-filter="account" aria-label="Račun"><option value="">Svi računi</option>${accounts.map(a=>`<option value="${a.id}" ${txFilter.account==a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select>
      <select data-filter="category" aria-label="Kategorija"><option value="">Sve kategorije</option>${catSelectOptions(txFilter.category)}</select>
      <button class="ghost filt-toggle ${nFilters?'on':''}" data-action="toggle-filters" aria-expanded="${showFilters}">Još filtera${nFilters?` · ${nFilters} aktivno`:''}</button>
    </div>
    ${showFilters?`<section class="card filters">
      <div class="seg type-seg" role="group" aria-label="Vrsta">
        <button class="seg-b ${!txFilter.type?'active':''}" data-type="" aria-pressed="${!txFilter.type}">Sve</button>
        <button class="seg-b ${txFilter.type==='expense'?'active':''}" data-type="expense" aria-pressed="${txFilter.type==='expense'}">Rashodi</button>
        <button class="seg-b ${txFilter.type==='income'?'active':''}" data-type="income" aria-pressed="${txFilter.type==='income'}">Prihodi</button>
      </div>
      <div class="form-row"><label class="fld">Od<input type="date" data-filter="from" value="${txFilter.from||''}"></label>
        <label class="fld">Do<input type="date" data-filter="to" value="${txFilter.to||''}"></label></div>
      <div class="form-row"><label class="fld">Min iznos<input type="number" inputmode="decimal" data-filter="min" value="${txFilter.min||''}"></label>
        <label class="fld">Max iznos<input type="number" inputmode="decimal" data-filter="max" value="${txFilter.max||''}"></label></div>
      <div class="form-row">
        <button class="ghost" data-action="clear-filters">Očisti filtere</button>
        ${nFilters && totalN>0 ? `<button class="del-tx" data-action="del-filtered">Obriši ovih ${totalN}</button>` : ''}
      </div>
    </section>`:''}
    ${rows.length ? `<section class="card">
      <div class="row-between"><h3>${drill?`${esc(drill.icon)} ${esc(drill.name)}`:'Po mesecima'}</h3>${nFilters?`<button class="ghost sm" data-action="clear-filters">✕ Očisti filtere</button>`:''}</div>
      <div class="chart-wrap small"><canvas id="cFlt" role="img" aria-label="Prihodi i rashodi po mesecima za izabrane filtere"></canvas></div>
    </section>`:''}
    <div class="tx-summary" role="status"><span>${totalN>rows.length?`prikazano ${rows.length} od ${totalN}`:`${totalN} transakcija`}</span><span class="pos">+${fmtN(sumIn)}</span><span class="neg">−${fmtN(sumOut)}</span></div>
    <div class="tx-list">
      ${list || empty('🧾','Nema transakcija', nFilters?'Nijedna transakcija ne odgovara filterima.':'Uvezi izvod ili dodaj transakciju dugmetom +.')}
    </div>`;

  s.querySelectorAll('[data-filter]').forEach(elm=> { if(elm.dataset.filter==='q') return; elm.addEventListener('change', e=>{
    const f=e.target.dataset.filter, v=e.target.value;
    if(f==='month') filterMonth=v||null; else txFilter[f]=v||null; render();
  }); });
  const q=$('[data-filter="q"]',s);
  if(q){
    q.addEventListener('input', debounce(e=>{ txFilter.q=e.target.value||null; render(); },300));
    if(typing){ q.focus(); const n=q.value.length; try { q.setSelectionRange(n,n); } catch {} }
  }
  s.querySelectorAll('[data-type]').forEach(b=> b.addEventListener('click', ()=>{ txFilter.type=b.dataset.type||null; render(); }));

  if(rows.length){
    // chart reflects the CURRENT filters (month/account/category/type/amount/search)
    const fm = Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([m,o]) => ({ m, inc:o.inc, ex:Math.max(0,o.ex) }));
    charts.flt = new window.Chart($('#cFlt'), { type:'bar', data:{ labels:fm.map(r=>an.fmtMonth(r.m)),
      datasets:[
        { label:'Prihodi', data:fm.map(r=>r.inc), backgroundColor:C_INC, borderRadius:4 },
        { label:'Rashodi', data:fm.map(r=>r.ex), backgroundColor:C_EXP, borderRadius:4 },
      ]}, options: barOpts() });
  }
}

// =================================================================== BUDGETS
function renderBudgets(s){
  const rate=rates();
  const m = an.monthly(rate);
  if(!m.length){ s.innerHTML = empty('🎯','Još nema podataka','Uvezi ili dodaj transakcije pa postavi mesečne budžete.','Idi na uvoz','import'); return; }
  const monthsList = m.map(x=>x.month).reverse();
  const month = (budgetMonth && monthsList.includes(budgetMonth)) ? budgetMonth : monthsList[0];
  const status = an.budgetStatus(month, rate);
  const tree = repo.getCatTree();   // budgets are set on leaf subcategories
  const totalBudget = status.reduce((a,b)=>a+b.amount,0);
  const totalSpent = status.reduce((a,b)=>a+b.spent,0);
  const avg = budgetAverages(rate);
  s.innerHTML = `
    <div class="toolbar2">
      <select data-bmonth aria-label="Mesec">${monthsList.map(mm=>`<option value="${mm}" ${mm===month?'selected':''}>${fmtMonthLong(mm)}</option>`).join('')}</select>
    </div>
    ${status.length?`<section class="card">
      <div class="row-between"><h3>Ukupno · ${fmtMonthLong(month)}</h3><b class="${totalSpent>totalBudget?'neg':''}">${fmt(totalSpent)} / ${fmt(totalBudget)}</b></div>
      ${status.map(b=>`<div data-action="drill" data-cat="${b.category_id}">${budgetBar(b)}</div>`).join('')}
    </section>`:`<section class="card empty-card">
      <h3>🎯 Postavi mesečne limite</h3>
      <p class="muted small">Najbrže: predlog na osnovu tvoje prosečne potrošnje u poslednja 3 meseca (zaokruženo naviše). Posle ga menjaš po želji.</p>
      <button class="primary big" data-action="budget-suggest">✨ Predloži budžete iz proseka</button>
    </section>`}
    <section class="card">
      <div class="row-between"><h3>Limiti po kategoriji</h3>${status.length?`<button class="ghost sm" data-action="budget-suggest">✨ Popuni prazne</button>`:''}</div>
      <p class="muted small">Mesečni iznos u RSD. Obriši broj da ukloniš limit. Sivo je tvoj prosek.</p>
      ${tree.map(g=>{ const subs=g.subs.filter(c=>c.kind==='expense' && !an.EXCLUDE_SPENDING.includes(c.name)); if(!subs.length) return '';
        return `<div class="catgrp-h" style="margin-top:8px">${esc(g.icon+' '+g.name)}</div>`
          + subs.map(c=>{ const b=status.find(x=>x.category_id===c.id);
            return `<label class="brow"><span>${esc(c.icon)} ${esc(c.name)}${avg[c.id]?`<small>Ø ${fmt(avg[c.id])}</small>`:''}</span>
              <input type="number" inputmode="numeric" class="binput" data-budget="${c.id}" placeholder="bez limita" aria-label="Mesečni limit za ${esc(c.name)}" value="${b?Math.round(b.monthly):''}"></label>`; }).join(''); }).join('')}
    </section>`;
  $('[data-bmonth]',s)?.addEventListener('change', e=>{ budgetMonth=e.target.value; render(); });
  s.querySelectorAll('[data-budget]').forEach(inp=> inp.addEventListener('change', async e=>{
    const y = window.scrollY;
    repo.setBudget(+e.target.dataset.budget, parseFloat(e.target.value)||0); await persist();
    render(); window.scrollTo(0, y); toast('Budžet sačuvan.');
  }));
}
// Average monthly spending per category over the last 3 complete months with data.
function budgetAverages(rate){
  const months = an.monthly(rate).map(x=>x.month).filter(mm => mm < todayISO().slice(0,7)).slice(-3);
  if(!months.length) return {};
  const out = {};
  for(const r of an.categoryBreakdown({ from:months[0], to:months[months.length-1] }, 'expense', rate))
    out[r.id] = r.total / months.length;
  return out;
}
async function budgetSuggest(){
  const avg = budgetAverages(rates());
  const existing = new Set(db.all(`SELECT category_id FROM budgets`).map(r=>r.category_id));
  const skip = new Set([...an.EXCLUDE_SPENDING, UNCAT]);
  const cats = repo.getCategories().filter(c=>c.kind==='expense' && c.parent_id!=null && !skip.has(c.name) && !existing.has(c.id) && avg[c.id] >= 500);
  if(!cats.length){ toast('Nema kategorija za predlog (potrebno je bar mesec dana podataka).', false); return; }
  const roundUp = v => Math.ceil(v / 1000) * 1000;
  await withUndo(`Predloženo ${cats.length} budžeta iz proseka.`, () => cats.forEach(c => repo.setBudget(c.id, roundUp(avg[c.id]))));
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
    const noOpening = p.parsed.opening == null
      ? `<div class="muted small" style="margin-top:8px">ℹ️ Ovaj format nema početno stanje računa. Ako je ovo prvi uvoz za račun, posle uvoza unesi početno stanje u <b>Računi → ✎ Izmeni</b>, inače neto vrednost neće biti tačna.</div>` : '';
    return `<section class="card imp"><div class="row-between"><b>✅ ${esc(p.file)}</b>${rec}</div>
      <div class="imp-grid">
        <div><span>Banka</span>${p.bank}</div>
        <div><span>Račun</span>···${esc((p.parsed.account||'').slice(-4))} (${p.parsed.currency})</div>
        <div><span>Transakcija</span>${t.length}</div>
        <div><span>Period</span>${dates[0]||'?'} – ${dates[dates.length-1]||'?'}</div>
        <div><span>Prihodi</span><b class="pos">+${fmtN(inc)}</b></div>
        <div><span>Rashodi</span><b>−${fmtN(exp)}</b></div>
      </div>${importOverlap(p.parsed)}${noOpening}</section>`;
  }).join('');
  if(ok.length) wrap.innerHTML += `<button class="primary big" data-action="confirm-import">Uvezi ${ok.length} izvod(a)</button>`;
}

// Warn if this account already has transactions in the statement's date range.
// Different statement FORMATS (izvod vs transakcije) have different dedupe keys,
// so they are NOT recognized as duplicates of each other.
function importOverlap(parsed){
  if(!parsed.account || !parsed.transactions.length) return '';
  const acc = db.get(`SELECT id FROM accounts WHERE account_number=?`, [parsed.account]);
  if(!acc) return '';
  const dates = parsed.transactions.map(t=>t.bookingDate).sort();
  const min = dates[0], max = dates[dates.length-1];
  const r = db.get(`SELECT COUNT(*) AS c FROM transactions WHERE account_id=? AND date>=? AND date<=?`, [acc.id, min, max]);
  if(r.c > 0) return `<div class="neg small" style="margin-top:8px">⚠ Ovaj račun već ima ${r.c} transakcija u periodu ${min} – ${max}. Različiti formati izvoda se ne prepoznaju kao duplikati — uvoz bi napravio duplikate. Uvezi samo jedan format po periodu.</div>`;
  return '';
}

async function confirmImport(){
  let totalIns=0, totalSkip=0;
  const batch = todayLocal()+'T'+new Date().toTimeString().slice(0,8);  // local stamp, shared per import run
  for(const p of pendingImports){
    if(!p.ok) continue;
    const r = repo.importStatement(p.parsed, p.file, batch, p.bank);
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
  const stMap = Object.fromEntries(an.accountStats().map(x=>[x.id,x]));
  // currencies in use (non-RSD) → editable rates; always offer EUR
  const used = [...new Set(balances.map(a=>a.currency))].filter(c=>c!=='RSD');
  if(!used.includes('EUR')) used.unshift('EUR');
  s.innerHTML = `
    <section class="card"><div class="row-between"><h3>Neto vrednost</h3><b class="big-num">${fmt(nw.totalRSD)}</b></div>
      <div class="muted small" style="margin-top:8px">Kursna lista (preračun u RSD):</div>
      ${used.map(c=>`<div class="brow"><span>1 ${c} =</span><input type="number" inputmode="decimal" class="binput" data-rate="${c}" value="${getRate(c)}" step="0.1" aria-label="Kurs: 1 ${c} u dinarima"> <span style="flex:none">RSD</span></div>`).join('')}
    </section>
    ${balances.map(a=>{ const st=stMap[a.id]; return `<section class="card acct-card">
      <div class="row-between"><div><b>${esc(a.name)}</b><div class="muted">${a.type==='cash'?'💵 keš':'🏦 banka'} · ${a.currency} · ${a.n} transakcija</div></div>
      <b class="${a.balance<0?'neg':''} big-num">${fmt(a.balance,a.currency)}</b></div>
      ${st&&st.months?`<div class="muted small" style="margin-top:6px">Ø potrošnja ${fmt(st.avgSpend,a.currency)}/mes · Ø štednja <span class="${st.avgNet<0?'neg':'pos'}">${fmt(st.avgNet,a.currency)}/mes</span></div>`:''}
      <div class="form-row" style="margin-top:10px">
        <button class="ghost" data-action="acct" data-acct="${a.id}">Transakcije</button>
        <button class="ghost" data-action="edit-account" data-id="${a.id}">✎ Izmeni</button>
        <button class="primary" data-action="add-to-acct" data-acct="${a.id}">＋ Dodaj</button>
      </div>
    </section>`; }).join('')}
    <section class="card">
      <h3>Dodaj račun</h3>
      <input id="naName" placeholder="Naziv (npr. Banka 2 – tekući)" />
      <div class="form-row">
        <select id="naType" aria-label="Vrsta računa"><option value="bank">Banka</option><option value="cash">Keš</option></select>
        <select id="naCur" aria-label="Valuta">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select>
        <input id="naOpen" type="number" inputmode="decimal" placeholder="Početno stanje" />
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
  const rules = db.all(`SELECT r.*, c.name AS cat, c.icon FROM rules r JOIN categories c ON c.id=r.category_id ORDER BY r.match`);
  const batches = repo.getImportBatches();
  const al = autolockMin();
  const cashN = repo.unmirroredCashCount();
  const lastBk = db.getSetting('last_backup', '');
  const bkDays = lastBk ? Math.floor((Date.now()-Date.parse(lastBk))/86400000) : null;
  const th = theme();
  const set = (id, title, body, extra='') => `<details class="card fold" data-set="${id}" ${settingsOpen.has(id)?'open':''}><summary><h3>${title}</h3>${extra}</summary>${body}</details>`;
  s.innerHTML = `
    <section class="card">
      <h3>💾 Rezervna kopija</h3>
      <p class="muted small">Podaci postoje samo na ovom uređaju — ako se telefon ili browser obriše, bez kopije su izgubljeni.
        Kopija je <b>šifrovana tvojom lozinkom</b>; čuvaj je npr. na Drive/iCloud.</p>
      <div class="small">Poslednja kopija: <b class="${bkDays==null||bkDays>30?'neg':'pos'}">${bkDays==null?'nikad':bkDays===0?'danas':`pre ${bkDays} dana`}</b>
        ${persistentStorage===false?'<div class="muted small">⚠ Browser nije odobrio trajno čuvanje — kopija je još važnija.</div>':''}</div>
      <div class="form-row" style="margin-top:10px">
        <button class="primary" data-action="backup-export">Sačuvaj kopiju</button>
        <button class="ghost" data-action="backup-import">Vrati iz kopije</button>
      </div>
    </section>

    <section class="card">
      <h3>📥 Uvoz i izvoz</h3>
      <button class="primary big" data-action="goto" data-view="import">Uvezi PDF izvod</button>
      <label class="fld" style="margin-top:12px">Izvoz u Excel/CSV — opseg
        <select id="expScope">
          <option value="all">Sve vreme</option>
          ${dashRange && dashRange.preset!=='all' ? `<option value="period">Period sa Pregleda (${esc(dashRange.label)})</option>` : ''}
        </select></label>
      <div class="form-row">
        <button data-action="export-xlsx">Excel (.xlsx)</button>
        <button data-action="export-csv">CSV</button>
      </div>
    </section>

    <section class="card">
      <h3>🔒 Sigurnost</h3>
      <label class="fld">Zaključaj posle neaktivnosti
        <select id="autolock">
          ${[['0','Nikad'],['1','1 minut'],['5','5 minuta'],['15','15 minuta'],['30','30 minuta']].map(([v,l])=>`<option value="${v}" ${al==+v?'selected':''}>${l}</option>`).join('')}
        </select></label>
      <div class="muted small">Kad je uključeno, aplikacija se zaključava i ako je u pozadini duže od minuta.</div>
      <details class="sub-fold"><summary>Promeni lozinku</summary>
        <input type="password" id="np0" placeholder="Trenutna lozinka" aria-label="Trenutna lozinka" autocomplete="current-password" />
        <input type="password" id="np1" placeholder="Nova lozinka (bar 6 znakova)" aria-label="Nova lozinka" autocomplete="new-password" />
        <input type="password" id="np2" placeholder="Ponovi novu lozinku" aria-label="Ponovi novu lozinku" autocomplete="new-password" />
        <button class="primary" data-action="change-pass" style="width:100%">Promeni lozinku</button>
      </details>
    </section>

    <section class="card">
      <h3>🎨 Izgled</h3>
      <div class="muted small">Tema</div>
      <div class="seg" role="group" aria-label="Tema">
        ${[['auto','Kao sistem'],['dark','Tamna'],['light','Svetla']].map(([v,l])=>`<button class="seg-b ${th===v?'active':''}" data-action="set-theme" data-theme="${v}" aria-pressed="${th===v}">${l}</button>`).join('')}
      </div>
      <label class="fld" style="margin-top:6px">Jednokratni izdatak je pojedinačni trošak od (RSD)
        <input type="number" inputmode="numeric" id="bigTx" value="${bigThreshold()}" min="5000" step="5000"></label>
      <div class="muted small">Akcenat boja</div>
      <div class="accent-row" role="group" aria-label="Akcenat boja">${ACCENTS.map((c,i)=>`<button class="accent-dot ${accent()===c?'sel':''}" data-action="set-accent" data-color="${c}" style="background:${c}" aria-label="Boja ${i+1}" aria-pressed="${accent()===c}"></button>`).join('')}</div>
    </section>

    <section class="card">
      <h3>👛 Keš / Novčanik</h3>
      <p class="muted small">Podizanja sa bankomata se pri uvozu prebacuju u keš račun „Novčanik", da pratiš keš na ruci i keš potrošnju.</p>
      <label class="fld">Praćenje keša
        <select id="mirrorToggle">
          ${[['1','Uključeno'],['0','Isključeno']].map(([v,l])=>`<option value="${v}" ${db.getSetting('mirror_atm','0')===v?'selected':''}>${l}</option>`).join('')}
        </select></label>
      <button class="ghost" data-action="add-wallet-cash" style="width:100%">＋ Dodaj keš u Novčanik</button>
      ${cashN>0?`<div class="muted small" style="margin-top:12px">${cashN} podizanja keša nisu u Novčaniku. Pošto taj keš nije praćen, možeš ga računati kao trošak:</div>
      <button class="ghost" data-action="cash-as-expense" style="width:100%;margin-top:6px">Neevidentiran keš → trošak (${cashN})</button>`:''}
    </section>

    ${set('cats', `🏷️ Kategorije`, `
      <p class="muted small">Dodirni kategoriju za izmenu. „＋" dodaje potkategoriju u grupu.</p>
      ${repo.getCatTree().map(g=>`<div class="catgrp">
        <div class="catgrp-h">
          <button class="catchip grp" data-action="edit-category" data-id="${g.id}" style="border-color:${g.color}">${esc(g.icon)} ${esc(g.name)}</button>
          <button class="addsub" data-action="add-sub" data-id="${g.id}" aria-label="Dodaj potkategoriju u ${esc(g.name)}">＋</button>
        </div>
        <div class="cat-grid">${g.subs.map(c=>`<button class="catchip" data-action="edit-category" data-id="${c.id}" style="border-color:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('') || '<span class="muted small">—</span>'}</div>
      </div>`).join('')}
      <button data-action="add-category" style="margin-top:8px;width:100%">＋ Nova grupa</button>`, `<small>${cats.length}</small>`)}

    ${set('rules', `🧠 Pravila kategorizacije`, `
      <p class="muted small">Ako naziv ili opis sadrži reč → dodeli kategoriju. Aplikacija uči i sama: kad promeniš kategoriju, zapamti trgovca (naučeno: <b>${repo.learnedCount()}</b>).</p>
      <input id="rMatch" placeholder="Reč iz naziva, npr. LIDL" aria-label="Tekst pravila" />
      <div class="form-row">
        <select id="rCat" aria-label="Kategorija pravila">${catSelectOptions()}</select>
        <button class="primary" data-action="add-rule" style="flex:0 0 auto">Dodaj</button>
      </div>
      <button data-action="recat" style="width:100%">↻ Primeni na nerazvrstane</button>
      <input type="search" id="ruleQ" placeholder="Pretraži ${rules.length} pravila…" aria-label="Pretraga pravila" style="margin-top:12px" />
      <div class="rules" id="ruleList">
        ${rules.map(r=>`<div class="rule" data-q="${esc((r.match+' '+r.cat).toUpperCase())}"><code>${esc(r.match)}</code><span class="rule-c">→ ${esc(r.icon+' '+r.cat)}</span><button class="del" data-action="del-rule" data-id="${r.id}" aria-label="Obriši pravilo ${esc(r.match)}">✕</button></div>`).join('')}
      </div>`, `<small>${rules.length}</small>`)}

    ${batches.length ? set('batches', `📄 Uvezeni fajlovi`, `
      <p class="muted small">Obriši ceo uvoz odjednom (sve stavke iz tog fajla).</p>
      <div class="rules">
        ${batches.map(b=>{ const fn=b.batch.split('|')[1]||b.batch;
          return `<div class="rule"><div style="flex:1;min-width:0">${esc(fn)}<small style="display:block">${b.mn} – ${b.mx} · ${b.n} stavki</small></div><button class="del" data-action="del-batch" data-batch="${esc(b.batch)}" aria-label="Obriši uvoz ${esc(fn)}">🗑</button></div>`; }).join('')}
      </div>`, `<small>${batches.length}</small>`) : ''}

    <section class="card danger">
      <h3>⚠️ Opasna zona</h3>
      <p class="muted small">Trajno briše sve podatke sa ovog uređaja. Prvo sačuvaj rezervnu kopiju.</p>
      <button class="del-tx" data-action="wipe-all" style="width:100%">Obriši sve podatke</button>
    </section>
    <p class="muted small about">Moj Budžet · AES-256-GCM, PBKDF2 ${(600000).toLocaleString('sr-RS')} iteracija · podaci samo na ovom uređaju, bez interneta i bez veze sa bankom.</p>`;
  $('#autolock',s)?.addEventListener('change', async e=>{ db.setSetting('autolock_min', +e.target.value); await persist(); resetAutoLock(); toast('Sačuvano.'); });
  $('#mirrorToggle',s)?.addEventListener('change', async e=>{ db.setSetting('mirror_atm', e.target.value); await persist(); toast(e.target.value==='1'?'Praćenje keša uključeno.':'Praćenje keša isključeno.'); });
  $('#bigTx',s)?.addEventListener('change', async e=>{ const v=Math.max(5000, +e.target.value||0); db.setSetting('big_tx', v); await persist(); toast('Sačuvano.'); });
  $('#ruleQ',s)?.addEventListener('input', e=>{ const q=e.target.value.trim().toUpperCase();
    s.querySelectorAll('#ruleList .rule').forEach(r=>{ r.hidden = q && !r.dataset.q.includes(q); }); });
  s.querySelectorAll('details[data-set]').forEach(d=> d.addEventListener('toggle', ()=>{ d.open ? settingsOpen.add(d.dataset.set) : settingsOpen.delete(d.dataset.set); }));
}
const settingsOpen = new Set();   // which collapsible settings sections are open (this session)

// =================================================================== EXPORT
function exportRows(period){
  const has = !!(period && period.from && period.to);
  const cond = has ? `WHERE substr(t.date,1,7) BETWEEN ? AND ?` : '';
  return db.all(`SELECT t.date AS Datum, a.name AS Racun, t.currency AS Valuta,
    CASE WHEN t.amount>0 THEN t.amount ELSE NULL END AS Priliv,
    CASE WHEN t.amount<0 THEN -t.amount ELSE NULL END AS Rashod,
    c.name AS Kategorija, t.merchant AS Trgovac, t.description AS Opis, t.balance AS Stanje, t.source AS Izvor
    FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id
    ${cond} ORDER BY t.date, t.id`, has ? [period.from, period.to] : []);
}
// scope chosen in the Settings export card: null = all, else the active dashboard period
function exportPeriod(){
  const sel = $('#expScope');
  if(sel && sel.value==='period' && dashRange && dashRange.preset!=='all') return { from:dashRange.from, to:dashRange.to };
  return null;
}
function exportXlsx(period){
  const rows = exportRows(period);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Transakcije');
  // monthly summary sheet (same scope)
  const m = an.monthly(rates(), period).map(x=>({ Mesec:x.month, Prihodi:Math.round(x.realIncome), Rashodi:Math.round(x.spending), Stednja:Math.round(x.net) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m), 'Po mesecima');
  XLSX.writeFile(wb, `moj-budzet-${new Date().toISOString().slice(0,10)}.xlsx`);
}
function exportCsv(period){
  const rows = exportRows(period);
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=`moj-budzet-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
}

// =================================================================== MODALS
// Bottom-sheet dialog: role=dialog, Escape/backdrop closes, focus moves in and
// returns to the opener on close.
function modal(html){
  const opener = document.activeElement;
  const m = document.createElement('div'); m.className='modal-bg';
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const h = m.querySelector('h3'); if(h){ h.id = 'dlg-' + Date.now(); m.firstElementChild.setAttribute('aria-labelledby', h.id); }
  const close = () => { m.remove(); };
  m.addEventListener('click', e=>{ if(e.target===m) close(); });
  m.addEventListener('keydown', e=>{ if(e.key==='Escape'){ e.stopPropagation(); close(); } });
  // when removed (by any path), give focus back to what opened it
  new MutationObserver((_, obs) => { if(!m.isConnected){ obs.disconnect(); try { opener && opener.isConnected && opener.focus(); } catch {} } })
    .observe(document.body, { childList:true });
  document.body.appendChild(m);
  a11y(m);
  setTimeout(() => { if(!m.contains(document.activeElement)){ const f = m.querySelector('input,select,button'); f && f.focus({ preventScroll:true }); } }, 30);
  return m;
}
// In-app confirm (native confirm() is unreliable in installed/standalone PWAs).
function confirmModal(message, okLabel='Obriši'){
  return new Promise(res=>{
    const m = modal(`<h3>Potvrda</h3><div class="muted small">${esc(message)}</div>
      <div class="form-row" style="margin-top:14px"><button class="ghost" data-no>Otkaži</button>
      <button class="del-tx" data-yes style="flex:1">${esc(okLabel)}</button></div>`);
    let done=false; const fin=(v)=>{ if(done)return; done=true; m.remove(); res(v); };
    m.querySelector('[data-no]').onclick=()=>fin(false);
    m.querySelector('[data-yes]').onclick=()=>fin(true);
    m.addEventListener('click', e=>{ if(e.target===m) fin(false); });
    new MutationObserver((_, obs)=>{ if(!m.isConnected){ obs.disconnect(); fin(false); } }).observe(document.body, { childList:true });
    m.querySelector('[data-no]').focus();
  });
}
// Default account for a new entry: last one used, else the first RSD bank account.
function defaultAccountId(accounts){
  const last = +db.getSetting('last_acct', '0');
  if(accounts.some(a=>a.id===last)) return last;
  const rsdBank = accounts.find(a=>a.currency==='RSD' && a.type==='bank') || accounts.find(a=>a.currency==='RSD');
  return (rsdBank || accounts[0] || {}).id;
}
function addManualModal(opts={}){
  const accounts = repo.getAccounts();
  if(!accounts.length){ toast('Prvo dodaj račun (Računi → Dodaj račun).', false); return; }
  const today = todayLocal();
  let kind = opts.kind || 'expense';
  const accId0 = opts.accountId || defaultAccountId(accounts);
  const m = modal(`
    <h3>Nova transakcija</h3>
    <div class="seg" role="group" aria-label="Vrsta"><button class="seg-b ${kind==='expense'?'active':''}" data-kind="expense" aria-pressed="${kind==='expense'}">Rashod</button><button class="seg-b ${kind==='income'?'active':''}" data-kind="income" aria-pressed="${kind==='income'}">Prihod</button></div>
    <label class="fld">Iznos<input id="mAmt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" /></label>
    <label class="fld">Opis / trgovac<input id="mDesc" placeholder="npr. Pijaca" /></label>
    <label class="fld">Kategorija<select id="mCat">${catSelectOptions(opts.categoryId, kind)}</select></label>
    <label class="fld">Račun<select id="mAcc">${accounts.map(a=>`<option value="${a.id}" ${accId0==a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label>
    <div class="form-row">
      <label class="fld">Valuta<select id="mCur">${CURRENCIES.map(c=>`<option>${c}</option>`).join('')}</select></label>
      <label class="fld">Datum<input id="mDate" type="date" value="${today}" max="${today}" /></label>
    </div>
    <div class="muted small" id="mCurHint" aria-live="polite"></div>
    <div class="form-row" style="margin-top:6px"><button class="ghost" data-close>Otkaži</button><button class="primary" id="mSave">Sačuvaj</button></div>
  `);
  // category list follows the selected kind (Rashod → rashodne, Prihod → prihodne)
  m.querySelectorAll('.seg-b').forEach(b=> b.onclick=()=>{ kind=b.dataset.kind;
    m.querySelectorAll('.seg-b').forEach(x=>{ x.classList.toggle('active',x===b); x.setAttribute('aria-pressed', String(x===b)); });
    m.querySelector('#mCat').innerHTML = catSelectOptions(null, kind); });
  m.querySelector('[data-close]').onclick=()=>m.remove();
  const accSel=m.querySelector('#mAcc'), curSel=m.querySelector('#mCur'), hint=m.querySelector('#mCurHint');
  // Currency follows the account; for cash accounts it's free to choose
  // (a different currency routes to that currency's own cash account).
  function syncCur(){
    const a = accounts.find(x=>x.id===+accSel.value);
    const cash = a && a.type==='cash';
    curSel.value = a ? a.currency : 'RSD';
    curSel.disabled = !cash;
    onCur();
  }
  function onCur(){
    const a = accounts.find(x=>x.id===+accSel.value);
    if(a && a.type==='cash' && curSel.value!==a.currency) hint.textContent = `Ide u keš „${curSel.value}" (kreira se ako ne postoji).`;
    else if(a && a.type!=='cash') hint.textContent = `Valuta prati račun (${a.currency}).`;
    else hint.textContent = '';
  }
  syncCur(); accSel.onchange=syncCur; curSel.onchange=onCur;
  const save = async ()=>{
    const amount = parseFloat(m.querySelector('#mAmt').value);
    if(!(amount>0)){ toast('Unesi iznos veći od nule.', false); m.querySelector('#mAmt').focus(); return; }
    const date = m.querySelector('#mDate').value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayLocal()){ toast('Unesi ispravan datum (ne u budućnosti).', false); m.querySelector('#mDate').focus(); return; }
    let accId = +accSel.value;
    const acc = accounts.find(a=>a.id===accId);
    if(acc && acc.type==='cash' && curSel.value!==acc.currency) accId = repo.findOrCreateCashAccount(curSel.value).id;
    try {
      repo.addManual({ account_id:accId, date, amount, kind,
        category_id:+m.querySelector('#mCat').value || null, description:m.querySelector('#mDesc').value });
    } catch { toast('Transakcija nije sačuvana — proveri unos.', false); return; }
    db.setSetting('last_acct', +accSel.value);
    await persist(); m.remove(); toast('Transakcija dodata.'); render();
  };
  m.querySelector('#mSave').onclick = save;
  m.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if(e.key==='Enter') save(); }));
  m.querySelector('#mAmt').focus();
}
// Category picker grid, limited to kinds that fit the amount's sign.
function catPicker(isCredit, currentId, exclude=[]){
  const ok = c => (isCredit ? true : c.kind!=='income') && !exclude.includes(c.name);   // a credit in a spending category = refund
  return `<div class="cat-tree">${repo.getCatTree().map(g=>{ const subs=g.subs.filter(ok); if(!subs.length) return '';
    return `<div class="ctg-h">${esc(g.icon+' '+g.name)}</div><div class="cat-pick">`
      + subs.map(c=>`<button class="catp ${c.id===currentId?'cur':''}" data-cat="${c.id}" style="border-left-color:${c.color}" ${c.id===currentId?'aria-current="true"':''}>${esc(c.icon)} ${esc(c.name)}</button>`).join('')
      + `</div>`; }).join('')}</div>`;
}
function txSummaryHtml(tx){
  const a = db.get(`SELECT name FROM accounts WHERE id=?`, [tx.account_id]);
  return `<div class="tx-card">
    <div class="tx-card-t">${esc(displayName(tx.merchant||tx.description))}</div>
    <div class="tx-card-a ${tx.amount<0?'neg':'pos'}">${tx.amount<0?'−':'+'}${fmt(Math.abs(tx.amount), tx.currency)}</div>
    <div class="muted small">${fmtDay(tx.date)} · ${esc(a?a.name:'')}</div>
    ${tx.description && tx.description!==tx.merchant ? `<div class="muted small tx-card-d">${esc(tx.description)}</div>` : ''}
  </div>`;
}
function editCatModal(txId){
  const tx = db.get(`SELECT * FROM transactions WHERE id=?`,[txId]); if(!tx) return;
  const m = modal(`<h3>Izmeni kategoriju</h3>${txSummaryHtml(tx)}
    ${catPicker(tx.amount>=0, tx.category_id)}
    <div class="form-row"><button class="ghost" data-close>Zatvori</button>
    <button class="del-tx" data-id="${txId}">Obriši transakciju</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelectorAll('.catp').forEach(b=> b.onclick = async ()=>{ repo.setCategory(txId, +b.dataset.cat); await persist(); m.remove(); toast('Kategorija promenjena — zapamćeno za ovog trgovca.'); render(); });
  m.querySelector('.del-tx').onclick = async ()=>{ m.remove(); await withUndo('Transakcija obrisana.', () => repo.deleteTransaction(txId)); };
}
// Triage: go through uncategorized debits one merchant at a time. Each choice is
// learned and immediately applied to the same merchant's other rows.
function triageModal(){
  const skipped = [];
  let sortedTotal = 0;
  const m = modal(`<h3>Razvrstavanje</h3><div id="trBody"></div>`);
  const body = m.querySelector('#trBody');
  const show = (note='') => {
    const left = repo.uncategorizedCount();
    const tx = repo.nextUncategorized(skipped);
    if(!tx){
      body.innerHTML = `<div class="empty" style="padding:24px 8px"><div class="ei">🎉</div><h3>${left?'Preskočeno je ostalo':'Sve je razvrstano'}</h3>
        <p>${sortedTotal?`Razvrstano ${sortedTotal} transakcija.`:''}${left?` ${left} preskočenih možeš razvrstati kasnije.`:''}</p></div>
        <button class="primary big" data-close>Gotovo</button>`;
      body.querySelector('[data-close]').onclick = () => m.remove();
      body.querySelector('[data-close]').focus();
      return;
    }
    body.innerHTML = `<div class="muted small" aria-live="polite">${left} preostalo${tx.same>1?` · ovaj trgovac: ${tx.same} stavki`:''}${note?` · <span class="pos">${note}</span>`:''}</div>
      ${txSummaryHtml(tx)}
      ${catPicker(false, null, [UNCAT])}
      <div class="form-row"><button class="ghost" data-close>Zatvori</button><button data-skip>Preskoči</button></div>`;
    body.querySelector('[data-close]').onclick = () => m.remove();
    body.querySelector('[data-skip]').onclick = () => { skipped.push(tx.id); show(); };
    body.querySelectorAll('.catp').forEach(b => b.onclick = async () => {
      const others = repo.triageAssign(tx.id, +b.dataset.cat);
      sortedTotal += 1 + others;
      await persist();
      show(others ? `+${others} istog trgovca razvrstano automatski` : '✓ sačuvano');
    });
    a11y(body);
    const first = body.querySelector('.catp'); first && first.focus({ preventScroll:true });
  };
  new MutationObserver((_, obs)=>{ if(!m.isConnected){ obs.disconnect(); if(sortedTotal) render(); } }).observe(document.body, { childList:true });
  show();
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
    <select id="ceGrp"><option value="">— tip (50/30/20) —</option>
      <option value="needs" ${c.grp==='needs'?'selected':''}>Potrebe</option>
      <option value="wants" ${c.grp==='wants'?'selected':''}>Želje</option></select>
    ${db.all(`SELECT id FROM categories WHERE parent_id=?`,[id]).length ? '' :
      `<select id="ceParent" style="margin-top:6px"><option value="">— bez grupe (sopstvena grupa) —</option>${groupSelectOptions(c.parent_id)}</select>`}
    <div class="muted small" style="margin-top:8px">Boja</div>
    <div class="accent-row">${CAT_COLORS.map(col=>`<button class="accent-dot ${c.color===col?'sel':''}" data-col="${col}" style="background:${col}"></button>`).join('')}</div>
    <div class="form-row" style="margin-top:10px"><button class="ghost" data-close>Otkaži</button><button class="primary" id="ceSave">Sačuvaj</button></div>
    ${sys?'':'<button class="del-tx" id="ceDel" style="width:100%;margin-top:8px">🗑 Obriši kategoriju</button>'}`);
  let color=c.color;
  m.querySelectorAll('[data-col]').forEach(b=>b.onclick=()=>{ color=b.dataset.col; m.querySelectorAll('[data-col]').forEach(x=>x.classList.toggle('sel',x===b)); });
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#ceSave').onclick=async()=>{ const name=m.querySelector('#ceName').value.trim(); if(!name) return;
    const pe=m.querySelector('#ceParent'); const fields={ name, icon:m.querySelector('#ceIcon').value, color, grp:m.querySelector('#ceGrp').value||null };
    if(pe) fields.parent_id = pe.value? +pe.value : null;
    try { repo.updateCategory(id, fields); }
    catch(e){ toast(e.message==='exists'?'Kategorija sa tim imenom već postoji.':'Greška.', false); return; }
    await persist(); m.remove(); toast('Kategorija sačuvana.'); render(); };
  const del=m.querySelector('#ceDel');
  if(del) del.onclick=async()=>{ if(await confirmModal('Obrisati kategoriju? Njene transakcije se premeštaju u „Ostalo / Nekategorisano".')){
    if(repo.isProtectedCategory(id)){ toast('Ova kategorija se ne može obrisati.',false); return; }
    m.remove(); await withUndo('Kategorija obrisana.', () => repo.deleteCategory(id)); } };
}
function categoryAddModal(parentId){
  const m = modal(`<h3>Nova ${parentId?'potkategorija':'kategorija'}</h3>
    <div class="form-row"><input id="caIcon" value="🏷️" style="flex:0 0 64px;text-align:center" /><input id="caName" placeholder="Naziv" /></div>
    <label class="fld">Grupa<select id="caParent"><option value="">— nova grupa (bez nadkategorije) —</option>${groupSelectOptions(parentId)}</select></label>
    <div class="form-row"><select id="caKind"><option value="expense">Rashod</option><option value="income">Prihod</option><option value="transfer">Transfer</option></select>
      <select id="caGrp"><option value="">— tip —</option><option value="needs">Potrebe</option><option value="wants">Želje</option></select></div>
    <div class="form-row"><button class="ghost" data-close>Otkaži</button><button class="primary" id="caSave">Dodaj</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#caSave').onclick=async()=>{ const name=m.querySelector('#caName').value.trim(); if(!name) return;
    const pv=m.querySelector('#caParent').value;
    try { repo.addCategory({ name, kind:m.querySelector('#caKind').value, icon:m.querySelector('#caIcon').value, grp:m.querySelector('#caGrp').value||null, color:'#6b7280', parent_id: pv?+pv:null }); }
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
    <label class="fld">Početno stanje (${esc(a.currency)})<input id="aeOpen" type="number" step="0.01" inputmode="decimal" value="${a.opening_balance??0}"></label>
    <div class="muted small">Stanje pre prve transakcije na ovom računu. Ispravi ga ako saldo ne odgovara banci (npr. posle uvoza „Račun transakcije", koji nema početno stanje).</div>
    <div class="form-row" style="margin-top:10px"><button class="ghost" data-close>Otkaži</button><button class="primary" id="aeSave">Sačuvaj</button></div>
    <button class="del-tx" id="aeDel" style="width:100%;margin-top:8px">🗑 Obriši račun${n>0?` (+ ${n} transakcija)`:''}</button>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#aeSave').onclick=async()=>{ const name=m.querySelector('#aeName').value.trim(); if(!name) return;
    const fields={ name, type:m.querySelector('#aeType').value };
    if(n===0) fields.currency=m.querySelector('#aeCur').value;
    const ob = parseFloat(m.querySelector('#aeOpen').value);
    if(Number.isFinite(ob)) fields.opening_balance = ob;
    repo.updateAccount(id, fields); await persist(); m.remove(); toast('Račun sačuvan.'); render(); };
  m.querySelector('#aeDel').onclick=async()=>{ if(await confirmModal(`Obrisati račun „${a.name}"${n>0?` i njegovih ${n} transakcija`:''}? `)){
    m.remove(); await withUndo('Račun obrisan.', () => repo.deleteAccount(id)); } };
}

// SQL condition (+params) on t.date for a period: 'YYYY-MM', {from,to} or null.
function periodSql(period){
  if(period==null) return { cond:'', params:[] };
  if(typeof period==='string') return { cond:` AND substr(t.date,1,7)=?`, params:[period] };
  const c=[], p=[];
  if(period.from){ c.push(` AND substr(t.date,1,7)>=?`); p.push(period.from); }
  if(period.to){ c.push(` AND substr(t.date,1,7)<=?`); p.push(period.to); }
  return { cond:c.join(''), params:p };
}
// Per-account totals of one money-flow class for a period (RSD base).
function acctFlow(period, rate, kind){
  const cats = Object.fromEntries(repo.getCategories(true).map(c=>[c.id,c]));
  const { cond, params } = periodSql(period);
  const tot = {}, names = {};
  for(const r of db.all(`SELECT a.id, a.name, t.amount, t.currency, t.category_id FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE a.archived=0 ${cond}`, params)){
    const cls = an.classify(cats[r.category_id] || null, r.amount), v = Math.abs(r.amount * (rate[r.currency] || 1));
    const d = kind==='income' ? (cls==='income' ? v : 0) : (cls==='spend' ? v : cls==='refund' ? -v : 0);
    if(d){ tot[r.id] = (tot[r.id]||0) + d; names[r.id] = r.name; }
  }
  return Object.keys(tot).filter(id => tot[id] > 0.5).sort((a,b)=>tot[b]-tot[a]).map(id => ({ id, name:names[id], tot:tot[id] }));
}
// Per-account "real spending" for a period (net of refunds; excludes transfers/cash/FX/principal).
function acctSpendRows(period, rate){
  const rows = acctFlow(period, rate, 'spend');
  return rows.map(r=>`<div class="rec-row" data-action="acct" data-acct="${r.id}"><div>${esc(r.name)}</div><b>${fmt(r.tot)}</b></div>`).join('')
    || '<div class="muted small">—</div>';
}
// Per-account "real income" for a period (RSD base, excludes transfers/FX).
function acctIncomeRows(period, rate){
  const rows = acctFlow(period, rate, 'income');
  return rows.map(r=>`<div class="rec-row" data-action="acct" data-acct="${r.id}"><div>${esc(r.name)}</div><b class="pos">+${fmt(r.tot)}</b></div>`).join('')
    || '<div class="muted small">—</div>';
}
// Dashboard KPI breakdown (decompose a headline number) — honors the selected period.
function statsModal(metric){
  const rate = rates();
  const range = dashRange || { from:null, to:null, label:'sve vreme', single:false, months:1, preset:'all' };
  const periodObj = range.preset==='all' ? null : (range.single ? range.from : { from:range.from, to:range.to });
  const mw = an.monthly(rate, range.preset==='all' ? null : { from:range.from, to:range.to });
  const pSpending = mw.reduce((s,x)=>s+x.spending,0);
  const pIncome   = mw.reduce((s,x)=>s+x.realIncome,0);
  const pNet      = mw.reduce((s,x)=>s+x.net,0);
  const monthsData = mw.length || 1;
  const savingsRate = pIncome ? pNet/pIncome*100 : null;
  const label = range.label;
  const exSet = new Set(an.EXCLUDE_SPENDING);
  let title='', body='';
  if(metric==='avg'){
    title = 'Prosečno mesečno — po računu · '+label;
    const st = an.accountStats(periodObj).filter(a=>a.months>0);
    body = (st.map(a=>`<div class="rec-row" data-action="acct" data-acct="${a.id}">
        <div>${esc(a.name)}<small>${a.months} mes.</small></div>
        <div style="text-align:right"><b>${fmt(a.avgSpend,a.currency)}</b><br><small>štednja <span class="${a.avgNet<0?'neg':'pos'}">${fmt(a.avgNet,a.currency)}</span></small></div>
      </div>`).join('') || '<div class="muted small">Nema podataka.</div>')
      + `<div class="muted small" style="margin-top:8px">Ukupno (RSD): Ø potrošnja ${fmt(pSpending/monthsData)} · Ø štednja ${fmt(pNet/monthsData)} /mes</div>`;
  } else if(metric==='income'){
    title = 'Priliv · '+label;
    const exI = new Set(an.EXCLUDE_INCOME);
    const cats = an.categoryBreakdown(periodObj,'income',rate).filter(c=>!exI.has(c.name)).slice(0,12);
    body = `<div class="muted small">Po kategoriji</div>`
      + (cats.map(c=>`<div class="rec-row" data-action="drill" data-cat="${c.id}"><div>${esc(c.icon)} ${esc(c.name)}</div><b class="pos">+${fmt(c.total)}</b></div>`).join('') || '<div class="muted small">—</div>')
      + `<div class="muted small" style="margin-top:10px">Po računu</div>` + acctIncomeRows(periodObj, rate)
      + `<div class="muted small" style="margin-top:8px">Ukupno realni priliv: <b>${fmt(pIncome)}</b></div>`;
  } else if(metric==='spend'){
    title = 'Potrošnja · '+label;
    const cats = an.categoryBreakdown(periodObj,'expense',rate).filter(c=>!exSet.has(c.name)).slice(0,12);
    body = `<div class="muted small">Po kategoriji</div>`
      + (cats.map(c=>`<div class="rec-row" data-action="drill" data-cat="${c.id}"><div>${esc(c.icon)} ${esc(c.name)}</div><b>${fmt(c.total)}</b></div>`).join('') || '<div class="muted small">—</div>')
      + `<div class="muted small" style="margin-top:10px">Po računu</div>` + acctSpendRows(periodObj, rate);
  } else { // save
    title = 'Ostalo ti je · '+label;
    const f = an.moneyFlow(range.preset==='all' ? null : { from:range.from, to:range.to }, rate, bigThreshold());
    body = `<div class="rec-row"><div>Prihodi</div><b class="pos">+${fmtN(f.income)}</b></div>
            <div class="rec-row"><div>Redovna potrošnja</div><b class="neg">−${fmtN(f.regular)}</b></div>
            <div class="rec-row"><div>Povremeni veliki troškovi</div><b class="neg">−${fmtN(f.periodic)}</b></div>
            <div class="rec-row"><div>Jednokratni izdaci</div><b class="neg">−${fmtN(f.oneOffs)}</b></div>
            <div class="rec-row"><div>Keš sa bankomata</div><b class="neg">−${fmtN(f.cash)}</b></div>
            <div class="rec-row"><div>Prenosi ljudima (neto)</div><b class="neg">−${fmtN(f.people)}</b></div>
            <div class="rec-row"><div>Glavnica kredita</div><b class="neg">−${fmtN(f.loan)}</b></div>
            <div class="rec-row total"><div><b>Ostalo ti je</b> ${f.income?`(${(f.left/f.income*100).toFixed(0)}%)`:''}</div><b class="${f.left<0?'neg':'pos'}">${fmtN(f.left)}</b></div>`;
  }
  const m = modal(`<h3>${title}</h3>${body}<div class="form-row" style="margin-top:12px"><button class="ghost" data-close style="flex:1">Zatvori</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.addEventListener('click', e=>{
    if(e.target.closest('[data-close]')) return;
    const el=e.target.closest('[data-action]'); if(!el) return;
    if(el.dataset.action==='drill' && el.dataset.cat){ clearFilters(); applyDashPeriod(); txFilter.category=+el.dataset.cat; view='tx'; m.remove(); render(); }
    else if(el.dataset.action==='acct'){ clearFilters(); applyDashPeriod(); txFilter.account=+el.dataset.acct; view='tx'; m.remove(); render(); }
  });
}

// ---------- encrypted backup ----------
function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
async function backupExport(){
  try {
    const text = await db.exportBackup();
    const name = `moj-budzet-kopija-${todayLocal()}.mbbackup`;
    const file = new File([text], name, { type:'application/octet-stream' });
    // phones: share sheet (save to Files/Drive); desktop: plain download
    if(navigator.canShare && navigator.canShare({ files:[file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)){
      try { await navigator.share({ files:[file], title:'Moj Budžet — rezervna kopija' }); }
      catch(e){ if(e && e.name==='AbortError') return; downloadBlob(file, name); }
    } else downloadBlob(file, name);
    db.setSetting('last_backup', new Date().toISOString()); await persist();
    toast('Rezervna kopija sačuvana (šifrovana).');
    if(view==='settings') render();
  } catch { toast('Pravljenje kopije nije uspelo.', false); }
}
// Pick a .mbbackup file and replace the vault on this device with it.
function backupImportPick(fromApp){
  const inp = document.createElement('input'); inp.type='file'; inp.accept='.mbbackup,application/json,application/octet-stream';
  inp.onchange = async ()=>{
    const f = inp.files && inp.files[0]; if(!f) return;
    const msg = (fromApp || await db.vaultExists())
      ? 'Vraćanje kopije ZAMENJUJE sve trenutne podatke na ovom uređaju podacima iz kopije. Nastaviti?'
      : 'Vratiti podatke iz kopije?';
    if(!await confirmModal(msg, 'Vrati kopiju')) return;
    try {
      await db.flush();
      await db.importBackup(await f.text());
      toast('Kopija vraćena. Otključaj je lozinkom koja je važila kad je kopija napravljena.');
      setTimeout(()=>location.reload(), 1200);
    } catch(e){ toast(e && e.message==='format' ? 'Fajl nije ispravna Moj Budžet kopija.' : 'Vraćanje nije uspelo.', false); }
  };
  inp.click();
}

function wipeAllModal(){
  const m = modal(`<h3>⚠️ Obriši sve podatke</h3>
    <div class="muted small">Ovo trajno briše ceo sef sa ovog uređaja: sve transakcije, račune, budžete, kategorije i podešavanja. <b>Ne može se poništiti.</b></div>
    <p class="muted small" style="margin-top:8px">Za potvrdu upiši <b>OBRIŠI</b>:</p>
    <input id="wipeC" placeholder="OBRIŠI" autocapitalize="characters" autocomplete="off" />
    <div class="form-row"><button class="ghost" data-close>Otkaži</button><button class="del-tx" id="wipeGo" style="flex:1">Obriši sve</button></div>`);
  m.querySelector('[data-close]').onclick=()=>m.remove();
  m.querySelector('#wipeGo').onclick=async()=>{
    // accept OBRIŠI / OBRISI / DELETE (tolerate missing diacritic on phone keyboards)
    const v = m.querySelector('#wipeC').value.trim().toUpperCase().replace(/Š/g,'S');
    if(v!=='OBRISI' && v!=='DELETE'){ toast('Upiši OBRIŠI (ili OBRISI) za potvrdu.',false); return; }
    try { await db.flush(); } catch {}
    await db.wipeVault(); location.reload();
  };
  m.querySelector('#wipeC').focus();
}

// ---------- auto-lock ----------
function resetAutoLock(){
  if(lockTimer){ clearTimeout(lockTimer); lockTimer=null; }
  if(!db.isOpen()) return;
  const min = autolockMin();
  // Full reload (not partial re-render) so any open modal/toast showing decrypted
  // data is wiped along with the in-memory key — same as manual lock.
  lastActivity = Date.now();
  if(min>0) lockTimer = setTimeout(()=>{ lockTimer=null; lockNow(); }, min*60000);
}
// Background: timers are throttled/frozen while the app is hidden, so measure the
// time away on return. Away ≥ 1 min (or past the inactivity limit) → lock. While
// hidden, the content is blurred so the OS app-switcher thumbnail doesn't show it.
let lastActivity = Date.now(), hiddenAt = null;
const BACKGROUND_LOCK_MS = 60000;
document.addEventListener('visibilitychange', ()=>{
  if(!db.isOpen()) return;
  if(document.hidden){
    hiddenAt = Date.now();
    if(autolockMin()>0) document.body.classList.add('privacy-blur');
    return;
  }
  const min = autolockMin();
  const away = hiddenAt ? Date.now()-hiddenAt : 0; hiddenAt = null;
  if(min>0 && (away >= BACKGROUND_LOCK_MS || Date.now()-lastActivity >= min*60000)){ lockNow(); return; }
  document.body.classList.remove('privacy-blur');
});

// ---------- service-worker auto-update ----------
let hadController = false, userTriggeredUpdate = false, updateReady = false;
function showUpdateBanner(){ updateReady = true; const b = $('#updateBanner'); if(b) b.classList.remove('hidden'); }
async function registerSW(){
  if(!('serviceWorker' in navigator)) return;
  hadController = !!navigator.serviceWorker.controller; // false on first-ever install
  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    // a new version may already be downloaded and waiting at load time
    if(swReg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    swReg.addEventListener('updatefound', ()=>{
      const nw = swReg.installing;
      if(nw) nw.addEventListener('statechange', ()=>{
        if(nw.state==='installed' && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });
    let reloaded=false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if(reloaded) return;
      if(!hadController && !userTriggeredUpdate) return; // don't reload on first install
      reloaded=true; location.reload();
    });
    swReg.update().catch(()=>{});                          // check immediately
    setInterval(()=>swReg && swReg.update().catch(()=>{}), 60000);
  } catch {}
}
function doUpdate(){ userTriggeredUpdate=true; if(swReg && swReg.waiting) swReg.waiting.postMessage('skipWaiting'); else location.reload(); }

// =================================================================== EVENTS
async function onClick(e){
  resetAutoLock();
  const tabBtn = e.target.closest('.tab'); if(tabBtn){ view=tabBtn.dataset.tab; render(); window.scrollTo(0,0); return; }
  const a = e.target.closest('[data-action]'); if(!a) return;
  const act = a.dataset.action;
  if(act==='lock'){ lockNow(); }
  else if(act==='goto'){ view=a.dataset.view; render(); }
  else if(act==='fab'){ fabSheet(); }
  else if(act==='edit-cat'){ editCatModal(+a.dataset.txid); }
  else if(act==='toggle-hide'){ db.setSetting('hide_amounts', hideAmounts()?'0':'1'); await persist(); applyPrefs();
    a.innerHTML = HIDE?ICON.eyeOff:ICON.eye; a.setAttribute('aria-pressed', String(HIDE)); a.setAttribute('aria-label', HIDE?'Prikaži iznose':'Sakrij iznose');
    render(); toast(HIDE?'Iznosi su sakriveni.':'Iznosi su vidljivi.'); }
  else if(act==='triage'){ triageModal(); }
  else if(act==='cash-split'){ cashSplitModal(); }
  else if(act==='budget-suggest'){ await budgetSuggest(); }
  else if(act==='drill'){ if(a.dataset.cat){ clearFilters(); applyDashPeriod(); txFilter.category=+a.dataset.cat; view='tx'; render(); } }
  else if(act==='drill-group'){ if(a.dataset.group){ clearFilters(); applyDashPeriod(); txFilter.group=+a.dataset.group; view='tx'; render(); } }
  else if(act==='dash-period'){ dashPeriod.preset=a.dataset.preset; if(a.dataset.preset!=='custom'){ dashPeriod.from=null; dashPeriod.to=null; } render(); }
  else if(act==='acct'){ clearFilters(); txFilter.account=+a.dataset.acct; view='tx'; render(); }
  else if(act==='merch'){ clearFilters(); txFilter.q=a.dataset.merch; view='tx'; render(); }
  else if(act==='add-to-acct'){ addManualModal({ accountId:+a.dataset.acct }); }
  else if(act==='edit-account'){ accountEditModal(+a.dataset.id); }
  else if(act==='wipe-all'){ wipeAllModal(); }
  else if(act==='kpi-spend'){ statsModal('spend'); }
  else if(act==='kpi-save'){ statsModal('save'); }
  else if(act==='kpi-avg'){ statsModal('avg'); }
  else if(act==='kpi-income'){ statsModal('income'); }
  else if(act==='del-filtered'){
    const { whereSql, params } = buildTxWhere();
    const n = repo.countWhere(whereSql, params);
    if(n>0 && await confirmModal(`Obrisati ${n} transakcija koje odgovaraju filterima?`, `Obriši ${n}`)){
      await withUndo(`Obrisano ${n} transakcija.`, () => repo.deleteWhere(whereSql, params));
    }
  }
  else if(act==='del-batch'){
    const batch = a.dataset.batch; const fn = (batch.split('|')[1]||batch);
    const n = repo.countWhere('WHERE import_batch=?', [batch]);
    if(await confirmModal(`Obrisati ceo uvoz „${fn}" (${n} stavki)?`, `Obriši ${n}`)){
      await withUndo(`Uvoz obrisan (${n}).`, () => repo.deleteByBatch(batch));
    }
  }
  else if(act==='toggle-filters'){ showFilters=!showFilters; render(); }
  else if(act==='clear-filters'){ clearFilters(); showFilters=false; render(); }
  else if(act==='edit-category'){ categoryEditModal(+a.dataset.id); }
  else if(act==='add-category'){ categoryAddModal(); }
  else if(act==='add-sub'){ categoryAddModal(+a.dataset.id); }
  else if(act==='set-accent'){ db.setSetting('accent', a.dataset.color); await persist(); applyPrefs(); render(); }
  else if(act==='set-theme'){ db.setSetting('theme', a.dataset.theme); await persist(); applyPrefs(); render(); }
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
  else if(act==='del-rule'){ await withUndo('Pravilo obrisano.', () => repo.deleteRule(+a.dataset.id)); }
  else if(act==='recat'){ const n=repo.recategorizeAll(true); await persist(); toast(`Ažurirano ${n} transakcija.`); render(); }
  else if(act==='add-wallet-cash'){ const w=repo.findOrCreateWallet('RSD'); await persist(); addManualModal({ accountId:w.id, kind:'income' }); }
  else if(act==='cash-as-expense'){
    const n=repo.unmirroredCashCount();
    if(n>0 && await confirmModal(`Označiti ${n} podizanja keša (koja nisu u Novčaniku) kao stvaran trošak? Prebacuju se u kategoriju „Gotovina (keš)".`, `Označi ${n}`)){
      repo.cashWithdrawalsToExpense(); await persist(); toast(`${n} podizanja keša označeno kao trošak.`); render();
    }
  }
  else if(act==='export-xlsx'){ exportXlsx(exportPeriod()); }
  else if(act==='export-csv'){ exportCsv(exportPeriod()); }
  else if(act==='change-pass'){
    const p0=$('#np0').value, p1=$('#np1').value, p2=$('#np2').value;
    if(!p0){ toast('Unesi trenutnu lozinku.',false); return; }
    if(p1.length<6){ toast('Lozinka mora imati bar 6 znakova.',false); return; }
    if(p1!==p2){ toast('Lozinke se ne poklapaju.',false); return; }
    a.disabled = true;
    try {
      if(!await db.verifyPassphrase(p0)){ toast('Trenutna lozinka nije tačna.',false); return; }
      await db.flush(); await db.changePassphrase(p1);
      ['#np0','#np1','#np2'].forEach(id=>{ const el=$(id); if(el) el.value=''; });
      toast('Lozinka promenjena. Stare rezervne kopije i dalje traže staru lozinku.');
    } catch { toast('Promena lozinke nije uspela.', false); }
    finally { a.disabled = false; }
  }
  else if(act==='backup-export'){ await backupExport(); }
  else if(act==='backup-import'){ backupImportPick(true); }
}

// empty-state helper
function empty(icon,title,sub,btn,gotoView){
  return `<div class="empty"><div class="ei">${icon}</div><h3>${title}</h3><p>${sub}</p>${btn?`<button class="primary" data-action="goto" data-view="${gotoView}">${btn}</button>`:''}</div>`;
}
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

boot();
