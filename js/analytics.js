// Analytics. All money math is per-currency; charts use the dominant currency (RSD).
// "Real spending"/"real income" exclude flows that are not consumption/earnings:
// cash withdrawals (money moved, not spent), internal transfers, FX conversion,
// and loan principal (debt repayment, not consumption — interest stays an expense).

import * as db from './db.js';

export const EXCLUDE_SPENDING = ['Podizanje keša','Interni prenos','Transfer drugima','Menjačnica (devize)','Kredit – glavnica'];
export const EXCLUDE_INCOME   = ['Menjačnica (devize)','Interni prenos','Transfer drugima'];

const fmtMonth = (m) => {
  const [y,mm] = m.split('-'); const names=['','jan','feb','mar','apr','maj','jun','jul','avg','sep','okt','nov','dec'];
  return `${names[+mm]} ${y.slice(2)}`;
};

function catLookup(){
  const map = {};
  for(const c of db.all(`SELECT * FROM categories`)) map[c.id] = c;
  return map;
}

// Monthly income / expense / spending / net, all converted to an RSD base
// (EUR amounts multiplied by eurRate) so every currency is included.
export function monthly(eurRate=117.5){
  const cats = catLookup();
  const exS = new Set(EXCLUDE_SPENDING), exI = new Set(EXCLUDE_INCOME);
  const rows = db.all(`SELECT substr(date,1,7) AS m, amount, currency, category_id FROM transactions`);
  const byM = {};
  for(const r of rows){
    const c = cats[r.category_id]; const nm = c?c.name:'';
    const amt = r.currency==='EUR' ? r.amount*eurRate : r.amount;
    const o = byM[r.m] || (byM[r.m] = { month:r.m, income:0, expense:0, spending:0, realIncome:0, net:0 });
    if(amt >= 0){ o.income += amt; if(!exI.has(nm)) o.realIncome += amt; }
    else { o.expense += -amt; if(!exS.has(nm)) o.spending += -amt; }
  }
  const list = Object.values(byM).sort((a,b)=>a.month.localeCompare(b.month));
  list.forEach(o => { o.net = o.realIncome - o.spending; o.label = fmtMonth(o.month); });
  return list;
}

// Category breakdown for a given month ('YYYY-MM') or null = all months. kind expense|income.
// Totals are in RSD base (EUR converted via eurRate).
export function categoryBreakdown(month, kind='expense', eurRate=117.5){
  const cats = catLookup();
  const sign = kind==='income' ? 'amount > 0' : 'amount < 0';
  const where = month ? `AND substr(date,1,7)=?` : '';
  const params = month ? [eurRate, month] : [eurRate];
  const rows = db.all(
    `SELECT category_id, SUM(ABS(amount) * (CASE currency WHEN 'EUR' THEN ? ELSE 1 END)) AS total, COUNT(*) AS n
     FROM transactions WHERE ${sign} ${where}
     GROUP BY category_id`, params);
  const out = rows.map(r => {
    const c = cats[r.category_id] || { name:'?', color:'#888', icon:'' };
    return { id:r.category_id, name:c.name, color:c.color, icon:c.icon, total:r.total, n:r.n, kind:c.kind };
  }).sort((a,b)=>b.total-a.total);
  return out;
}

// Per-account current balance = opening_balance + sum(signed amounts).
export function accountBalances(){
  return db.all(`
    SELECT a.id, a.name, a.type, a.currency, a.color,
           a.opening_balance + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id=a.id),0) AS balance,
           (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id) AS n
    FROM accounts a WHERE a.archived=0 ORDER BY a.type, a.name`);
}

export function netWorth(eurRate=117.5){
  let total = 0; const parts = [];
  for(const a of accountBalances()){
    const inRsd = a.currency==='EUR' ? a.balance * eurRate : a.balance;
    total += inRsd; parts.push(a);
  }
  return { totalRSD: total, accounts: parts };
}

// Detect recurring charges (subscriptions, regular bills): same merchant appearing
// in >= 3 distinct months. Returns estimated monthly cost.
export function recurring(eurRate=117.5){
  const rows = db.all(
    `SELECT merchant, substr(date,1,7) AS m, ABS(amount) AS amt, currency
     FROM transactions WHERE amount<0 AND merchant IS NOT NULL AND merchant<>''`);
  const byMerch = {};
  for(const r of rows){
    const amt = r.currency==='EUR' ? r.amt*eurRate : r.amt;
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

// Headline KPIs for the dashboard.
export function kpis(eurRate=117.5){
  const m = monthly(eurRate);
  if(!m.length) return null;
  const cur = m[m.length-1], prev = m[m.length-2];
  const avgSpend = m.reduce((s,x)=>s+x.spending,0)/m.length;
  const avgInc = m.reduce((s,x)=>s+x.realIncome,0)/m.length;
  const totalSaved = m.reduce((s,x)=>s+x.net,0);
  const top = categoryBreakdown(cur.month,'expense',eurRate)[0] || null;
  const momSpend = prev && prev.spending ? (cur.spending-prev.spending)/prev.spending*100 : null;
  const savingsRate = cur.realIncome ? cur.net/cur.realIncome*100 : null;
  const avgSavingsRate = avgInc ? (avgInc-avgSpend)/avgInc*100 : null;
  return { current:cur, prev, avgSpend, avgInc, totalSaved, top, momSpend, savingsRate, avgSavingsRate, monthsCount:m.length };
}

// ---------- budgets ----------
// Spending vs monthly budget for a given month. Returns rows sorted worst-first.
export function budgetStatus(month, eurRate=117.5){
  const budgets = db.all(`SELECT b.category_id, b.amount, c.name, c.icon, c.color FROM budgets b JOIN categories c ON c.id=b.category_id`);
  const rows = budgets.map(b=>{
    const r = db.get(`SELECT COALESCE(SUM(ABS(amount)*(CASE currency WHEN 'EUR' THEN ? ELSE 1 END)),0) AS spent
      FROM transactions WHERE category_id=? AND amount<0 AND substr(date,1,7)=?`, [eurRate, b.category_id, month]);
    const spent=r.spent, pct=b.amount? spent/b.amount*100 : 0;
    return {...b, spent, pct, remaining:b.amount-spent, over:spent>b.amount};
  });
  return rows.sort((a,b)=>b.pct-a.pct);
}

// ---------- 50/30/20 (needs / wants / savings) ----------
export function needsWants(month, eurRate=117.5){
  const rows = db.all(`SELECT c.grp AS grp, SUM(ABS(t.amount)*(CASE t.currency WHEN 'EUR' THEN ? ELSE 1 END)) AS tot
    FROM transactions t JOIN categories c ON c.id=t.category_id
    WHERE t.amount<0 AND substr(t.date,1,7)=? GROUP BY c.grp`, [eurRate, month]);
  let needs=0, wants=0;
  for(const r of rows){ if(r.grp==='needs') needs=r.tot; else if(r.grp==='wants') wants=r.tot; }
  return { needs, wants };
}

// ---------- projection: extrapolate this month's spending to month end ----------
export function projection(month, eurRate, todayISO){
  // only meaningful when `month` is the month that contains todayISO
  if(!todayISO || todayISO.slice(0,7)!==month) return null;
  const [y,m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const day = Number(todayISO.slice(8,10));
  const r = db.get(`SELECT COALESCE(SUM(ABS(amount)*(CASE currency WHEN 'EUR' THEN ? ELSE 1 END)),0) AS s
    FROM transactions WHERE amount<0 AND substr(date,1,7)=?`, [eurRate, month]);
  const spent=r.s; if(day<1) return null;
  return { spent, projected: spent/day*daysInMonth, day, daysInMonth };
}

// ---------- net-worth over time (per-account, all currencies → RSD) ----------
export function netWorthSeries(eurRate=117.5){
  const accts = db.all(`SELECT id, currency, opening_balance FROM accounts WHERE archived=0`);
  const months = db.all(`SELECT DISTINCT substr(date,1,7) AS m FROM transactions ORDER BY m`).map(r=>r.m);
  return months.map(m=>{
    let total=0;
    for(const a of accts){
      const r = db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id=? AND substr(date,1,7)<=?`, [a.id, m]);
      const bal = a.opening_balance + r.s;
      total += a.currency==='EUR' ? bal*eurRate : bal;
    }
    return { month:m, label:fmtMonth(m), net: total };
  });
}

// ---------- biggest category movers (cur vs prev month) ----------
export function categoryMovers(curMonth, prevMonth, eurRate=117.5){
  const cats = catLookup();
  const q = (mo)=>{ const rows=db.all(`SELECT category_id, SUM(ABS(amount)*(CASE currency WHEN 'EUR' THEN ? ELSE 1 END)) AS t
      FROM transactions WHERE amount<0 AND substr(date,1,7)=? GROUP BY category_id`, [eurRate, mo]);
    const map={}; rows.forEach(r=>map[r.category_id]=r.t); return map; };
  const cur=q(curMonth), prev=prevMonth?q(prevMonth):{};
  const ids=new Set([...Object.keys(cur), ...Object.keys(prev)]);
  return [...ids].map(id=>({ cat:cats[id]||{name:'?',icon:'',color:'#888'}, cur:cur[id]||0, prev:prev[id]||0, delta:(cur[id]||0)-(prev[id]||0) }))
    .sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
}

// ---------- per-category mini history (for drill-down) ----------
export function categoryHistory(categoryId, eurRate=117.5){
  const rows = db.all(`SELECT substr(date,1,7) AS m, SUM(ABS(amount)*(CASE currency WHEN 'EUR' THEN ? ELSE 1 END)) AS t
    FROM transactions WHERE category_id=? AND amount<0 GROUP BY m ORDER BY m`, [eurRate, categoryId]);
  return rows.map(r=>({ month:r.m, label:fmtMonth(r.m), total:r.t }));
}

export { fmtMonth };
