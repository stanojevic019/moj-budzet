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

export { fmtMonth };
