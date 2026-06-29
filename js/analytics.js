// Analytics. All money math is converted to an RSD base using a currency→rate map
// `rates` (e.g. { RSD:1, EUR:117.5, USD:108 }). "Real spending"/"real income"
// exclude flows that aren't consumption/earnings: cash withdrawals, internal
// transfers, FX conversion, and loan principal (interest stays an expense).

import * as db from './db.js';

export const EXCLUDE_SPENDING = ['Podizanje keša','Interni prenos','Transfer drugima','Menjačnica (devize)','Kredit – glavnica'];
export const EXCLUDE_INCOME   = ['Menjačnica (devize)','Interni prenos','Transfer drugima'];

// SQL fragment converting `amount`'s currency to RSD. Rates are our own numbers
// and currency codes are sanitized to A–Z, so inlining is injection-safe.
export function convExpr(rates, col='currency'){
  const parts = Object.entries(rates||{})
    .filter(([c]) => c !== 'RSD')
    .map(([c,r]) => `WHEN '${String(c).replace(/[^A-Z]/g,'')}' THEN ${Number(r)||1}`)
    .join(' ');
  return parts ? `(CASE ${col} ${parts} ELSE 1 END)` : `1`;
}
const toRSD = (amount, currency, rates) => amount * ((rates && rates[currency]) || 1);

const fmtMonth = (m) => {
  const [y,mm] = m.split('-'); const names=['','jan','feb','mar','apr','maj','jun','jul','avg','sep','okt','nov','dec'];
  return `${names[+mm]} ${y.slice(2)}`;
};

function catLookup(){
  const map = {};
  for(const c of db.all(`SELECT * FROM categories`)) map[c.id] = c;
  return map;
}

// Monthly income / expense / spending / net, all in RSD base.
export function monthly(rates){
  const cats = catLookup();
  const exS = new Set(EXCLUDE_SPENDING), exI = new Set(EXCLUDE_INCOME);
  const rows = db.all(`SELECT substr(date,1,7) AS m, amount, currency, category_id FROM transactions`);
  const byM = {};
  for(const r of rows){
    const c = cats[r.category_id]; const nm = c?c.name:'';
    const amt = toRSD(r.amount, r.currency, rates);
    const o = byM[r.m] || (byM[r.m] = { month:r.m, income:0, expense:0, spending:0, realIncome:0, net:0 });
    if(amt >= 0){ o.income += amt; if(!exI.has(nm)) o.realIncome += amt; }
    else { o.expense += -amt; if(!exS.has(nm)) o.spending += -amt; }
  }
  const list = Object.values(byM).sort((a,b)=>a.month.localeCompare(b.month));
  list.forEach(o => { o.net = o.realIncome - o.spending; o.label = fmtMonth(o.month); });
  return list;
}

// Category breakdown for a month ('YYYY-MM') or null = all months. kind expense|income. RSD base.
export function categoryBreakdown(month, kind='expense', rates){
  const cats = catLookup();
  const sign = kind==='income' ? 'amount > 0' : 'amount < 0';
  const where = month ? `AND substr(date,1,7)=?` : '';
  const rows = db.all(
    `SELECT category_id, SUM(ABS(amount) * ${convExpr(rates)}) AS total, COUNT(*) AS n
     FROM transactions WHERE ${sign} ${where}
     GROUP BY category_id`, month ? [month] : []);
  return rows.map(r => {
    const c = cats[r.category_id] || { name:'?', color:'#888', icon:'' };
    return { id:r.category_id, name:c.name, color:c.color, icon:c.icon, total:r.total, n:r.n, kind:c.kind };
  }).sort((a,b)=>b.total-a.total);
}

// Per-account current balance = opening_balance + sum(signed amounts).
export function accountBalances(){
  return db.all(`
    SELECT a.id, a.name, a.type, a.currency, a.color,
           a.opening_balance + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id=a.id),0) AS balance,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id) AS n
    FROM accounts a WHERE a.archived=0 ORDER BY a.type, a.name`);
}

export function netWorth(rates){
  let total = 0; const parts = [];
  for(const a of accountBalances()){ total += toRSD(a.balance, a.currency, rates); parts.push(a); }
  return { totalRSD: total, accounts: parts };
}

// Recurring charges: same merchant in >= 3 distinct months. Estimated monthly cost (RSD).
export function recurring(rates){
  const rows = db.all(
    `SELECT merchant, substr(date,1,7) AS m, ABS(amount) AS amt, currency
     FROM transactions WHERE amount<0 AND merchant IS NOT NULL AND merchant<>''`);
  const byMerch = {};
  for(const r of rows){
    const amt = toRSD(r.amt, r.currency, rates);
    const o = byMerch[r.merchant] || (byMerch[r.merchant] = { merchant:r.merchant, months:new Set(), amts:[] });
    o.months.add(r.m); o.amts.push(amt);
  }
  const list = [];
  for(const o of Object.values(byMerch)){
    if(o.months.size >= 3){
      const avg = o.amts.reduce((s,x)=>s+x,0)/o.amts.length;
      const sorted=[...o.amts].sort((a,b)=>a-b); const med = sorted[Math.floor(sorted.length/2)];
      list.push({ merchant:o.merchant, months:o.months.size, count:o.amts.length, avg, median:med });
    }
  }
  return list.sort((a,b)=>b.median-a.median);
}

// Headline KPIs.
export function kpis(rates, m=null){
  m = m || monthly(rates);
  if(!m.length) return null;
  const cur = m[m.length-1], prev = m[m.length-2];
  const avgSpend = m.reduce((s,x)=>s+x.spending,0)/m.length;
  const avgInc = m.reduce((s,x)=>s+x.realIncome,0)/m.length;
  const totalSaved = m.reduce((s,x)=>s+x.net,0);
  const top = categoryBreakdown(cur.month,'expense',rates)[0] || null;
  const momSpend = prev && prev.spending ? (cur.spending-prev.spending)/prev.spending*100 : null;
  const savingsRate = cur.realIncome ? cur.net/cur.realIncome*100 : null;
  const avgSavingsRate = avgInc ? (avgInc-avgSpend)/avgInc*100 : null;
  return { current:cur, prev, avgSpend, avgInc, totalSaved, top, momSpend, savingsRate, avgSavingsRate, monthsCount:m.length };
}

// ---------- budgets ----------
export function budgetStatus(month, rates){
  const budgets = db.all(`SELECT b.category_id, b.amount, c.name, c.icon, c.color
    FROM budgets b JOIN categories c ON c.id=b.category_id WHERE c.archived=0`);
  const spendByCat = {};
  for(const r of categoryBreakdown(month,'expense',rates)) spendByCat[r.id] = r.total;
  const rows = budgets.map(b=>{
    const spent = spendByCat[b.category_id] || 0;
    const pct = b.amount ? spent/b.amount*100 : 0;
    return {...b, spent, pct, remaining:b.amount-spent, over:spent>b.amount};
  });
  return rows.sort((a,b)=>b.pct-a.pct);
}

// ---------- 50/30/20 ----------
export function needsWants(month, rates){
  const rows = db.all(`SELECT c.grp AS grp, SUM(ABS(t.amount)*${convExpr(rates)}) AS tot
    FROM transactions t JOIN categories c ON c.id=t.category_id
    WHERE t.amount<0 AND substr(t.date,1,7)=? GROUP BY c.grp`, [month]);
  let needs=0, wants=0;
  for(const r of rows){ if(r.grp==='needs') needs=r.tot; else if(r.grp==='wants') wants=r.tot; }
  return { needs, wants };
}

// ---------- projection ----------
export function projection(month, rates, todayISO){
  if(!todayISO || todayISO.slice(0,7)!==month) return null;
  const [y,m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const day = Number(todayISO.slice(8,10));
  const r = db.get(`SELECT COALESCE(SUM(ABS(amount)*${convExpr(rates)}),0) AS s
    FROM transactions WHERE amount<0 AND substr(date,1,7)=?`, [month]);
  if(day<1) return null;
  return { spent:r.s, projected: r.s/day*daysInMonth, day, daysInMonth };
}

// ---------- net-worth over time ----------
export function netWorthSeries(rates){
  const accts = db.all(`SELECT id, currency, opening_balance FROM accounts WHERE archived=0`);
  const months = db.all(`SELECT DISTINCT substr(date,1,7) AS m FROM transactions ORDER BY m`).map(r=>r.m);
  if(!months.length) return [];
  const deltas = db.all(`SELECT account_id, substr(date,1,7) AS m, SUM(amount) AS s FROM transactions GROUP BY account_id, m`);
  const byAcct = {};
  for(const d of deltas){ (byAcct[d.account_id] || (byAcct[d.account_id]={}))[d.m] = d.s; }
  const cum = {}; for(const a of accts) cum[a.id] = a.opening_balance;
  return months.map(m=>{
    let total=0;
    for(const a of accts){
      cum[a.id] += (byAcct[a.id] && byAcct[a.id][m]) || 0;
      total += toRSD(cum[a.id], a.currency, rates);
    }
    return { month:m, label:fmtMonth(m), net: total };
  });
}

// ---------- biggest category movers ----------
export function categoryMovers(curMonth, prevMonth, rates){
  const cats = catLookup();
  const conv = convExpr(rates);
  const q = (mo)=>{ const rows=db.all(`SELECT category_id, SUM(ABS(amount)*${conv}) AS t
      FROM transactions WHERE amount<0 AND substr(date,1,7)=? GROUP BY category_id`, [mo]);
    const map={}; rows.forEach(r=>map[r.category_id]=r.t); return map; };
  const cur=q(curMonth), prev=prevMonth?q(prevMonth):{};
  const ids=new Set([...Object.keys(cur), ...Object.keys(prev)]);
  return [...ids].map(id=>({ cat:cats[id]||{name:'?',icon:'',color:'#888'}, cur:cur[id]||0, prev:prev[id]||0, delta:(cur[id]||0)-(prev[id]||0) }))
    .sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
}

// ---------- per-account stats (in each account's own currency) ----------
// avgSpend = avg monthly real spending; avgNet = avg monthly savings (real income − real spending).
export function accountStats(){
  const accts = db.all(`SELECT id,name,currency,color,type FROM accounts WHERE archived=0`);
  const cats = catLookup();
  const exS = new Set(EXCLUDE_SPENDING), exI = new Set(EXCLUDE_INCOME);
  const rows = db.all(`SELECT account_id, substr(date,1,7) AS m, amount, category_id FROM transactions`);
  const agg = {};
  for(const r of rows){
    const o = agg[r.account_id] || (agg[r.account_id] = { months:new Set(), spend:{}, net:{}, inSum:0, outSum:0 });
    const nm = cats[r.category_id]?cats[r.category_id].name:'';
    o.months.add(r.m);
    if(r.amount < 0){ o.outSum += -r.amount; if(!exS.has(nm)){ o.spend[r.m]=(o.spend[r.m]||0)+(-r.amount); o.net[r.m]=(o.net[r.m]||0)-(-r.amount); } }
    else { o.inSum += r.amount; if(!exI.has(nm)) o.net[r.m]=(o.net[r.m]||0)+r.amount; }
  }
  return accts.map(a=>{
    const o = agg[a.id];
    if(!o) return { ...a, months:0, avgSpend:0, avgNet:0, totalIn:0, totalOut:0 };
    const mc = o.months.size || 1;
    const sum = obj => Object.values(obj).reduce((s,x)=>s+x,0);
    return { ...a, months:o.months.size, avgSpend: sum(o.spend)/mc, avgNet: sum(o.net)/mc, totalIn:o.inSum, totalOut:o.outSum };
  });
}

export { fmtMonth };
