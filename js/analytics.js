// Analytics. All money math is converted to an RSD base using a currency→rate map
// `rates` (e.g. { RSD:1, EUR:117.5, USD:108 }).
//
// Every transaction is classified ONCE (classify) into a money flow:
//   income  – real earnings (salary, other income)
//   spend   – real consumption (a debit in an expense/shared category)
//   refund  – money back into a spending category (store refund, partner paying
//             back their half of shared costs) → REDUCES spending
//   cash    – ATM withdrawals (where it's spent is unknown unless tracked in a wallet)
//   people  – transfers to/from other people (net)
//   loan    – loan principal repayment (interest stays spending)
//   neutral – money that only moves: own accounts, FX exchange, pass-through money
// "Real spending" = spend − refund; "real income" = income.

import * as db from './db.js';

export const NEUTRAL = ['Interni prenos','Menjačnica (devize)','Prolazni novac'];
export const EXCLUDE_SPENDING = ['Podizanje keša','Interni prenos','Transfer drugima','Menjačnica (devize)','Kredit – glavnica','Prolazni novac'];
export const EXCLUDE_INCOME   = ['Menjačnica (devize)','Interni prenos','Transfer drugima','Prolazni novac','Podizanje keša'];
// a single real-spending transaction at least this big (RSD) is a "one-off"
export const BIG_DEFAULT = 50000;

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

// Build a date condition for a "period": a 'YYYY-MM' string (single month),
// a { from, to } range (inclusive, 'YYYY-MM'), or null/undefined (all time).
// Returns a bare condition (no WHERE/AND) so callers compose it freely.
function monthCond(period, col='date'){
  const mm = `substr(${col},1,7)`;
  if(!period) return { cond:'', params:[] };
  if(typeof period === 'string') return { cond:`${mm}=?`, params:[period] };
  const c=[], p=[];
  if(period.from){ c.push(`${mm}>=?`); p.push(period.from); }
  if(period.to){   c.push(`${mm}<=?`); p.push(period.to); }
  return { cond: c.join(' AND '), params: p };
}

const fmtMonth = (m) => {
  const [y,mm] = m.split('-'); const names=['','jan','feb','mar','apr','maj','jun','jul','avg','sep','okt','nov','dec'];
  return `${names[+mm]} ${y.slice(2)}`;
};

function catLookup(){
  const map = {};
  for(const c of db.all(`SELECT * FROM categories`)) map[c.id] = c;
  return map;
}

// ---------- the single classification ----------
export function classify(cat, amount){
  const name = cat ? cat.name : '';
  const credit = amount >= 0;
  if(NEUTRAL.includes(name)) return 'neutral';
  if(name === 'Podizanje keša') return 'cash';
  if(name === 'Transfer drugima') return 'people';
  if(name === 'Kredit – glavnica') return credit ? 'neutral' : 'loan';
  if(!cat || cat.kind === 'income') return credit ? 'income' : 'spend';
  return credit ? 'refund' : 'spend';           // expense / shared (transfer-kind) categories
}

// Rows of a period with RSD value and their flow class.
function flowRows(period, rates, extraCols=''){
  const cats = catLookup();
  const { cond, params } = monthCond(period);
  return db.all(`SELECT id, date, substr(date,1,7) AS m, amount, currency, category_id, account_id, merchant, description ${extraCols}
    FROM transactions ${cond?'WHERE '+cond:''}`, params).map(r => {
    const cat = cats[r.category_id] || null;
    return { ...r, cat, v: Math.abs(toRSD(r.amount, r.currency, rates)), cls: classify(cat, r.amount) };
  });
}

// Monthly income / spending / net, all in RSD base. Optional `range`
// ({from,to} in 'YYYY-MM', or null = all) limits which months are included.
// Also splits spending into regular vs one-off (single tx >= big).
export function monthly(rates, range, big=BIG_DEFAULT){
  const byM = {};
  for(const r of flowRows(range, rates)){
    const o = byM[r.m] || (byM[r.m] = { month:r.m, income:0, expense:0, spending:0, realIncome:0, net:0, big:0, cash:0, people:0, loan:0 });
    if(r.amount >= 0) o.income += r.v; else o.expense += r.v;
    if(r.cls === 'income') o.realIncome += r.v;
    else if(r.cls === 'spend'){ o.spending += r.v; if(r.v >= big) o.big += r.v; }
    else if(r.cls === 'refund') o.spending -= r.v;
    else if(r.cls === 'cash') o.cash += r.amount < 0 ? r.v : -r.v;
    else if(r.cls === 'people') o.people += r.amount < 0 ? r.v : -r.v;
    else if(r.cls === 'loan') o.loan += r.v;
  }
  const list = Object.values(byM).sort((a,b)=>a.month.localeCompare(b.month));
  // net = what's really left: income minus every outflow (spending, cash, people, loan)
  list.forEach(o => { o.regular = o.spending - o.big; o.net = o.realIncome - o.spending - Math.max(0,o.cash) - Math.max(0,o.people) - o.loan; o.label = fmtMonth(o.month); });
  return list;
}

// Category breakdown for a period: a 'YYYY-MM' month, a {from,to} range, or
// null = all. kind expense|income. RSD base.
//  - expense: spending categories are NET of refunds (shared costs paid back count
//    against them); flow categories (cash, transfers, FX…) show their gross outflow.
//  - income: real income only.
export function categoryBreakdown(period, kind='expense', rates){
  const agg = {};
  for(const r of flowRows(period, rates)){
    let d = 0;
    if(kind === 'income'){ if(r.cls === 'income') d = r.v; }
    else if(r.amount < 0) d = r.v;
    else if(r.cls === 'refund' || r.cls === 'people' || r.cls === 'cash') d = -r.v;
    if(!d) continue;
    const id = r.category_id;
    const o = agg[id] || (agg[id] = { id, total:0, n:0, cat:r.cat });
    o.total += d; o.n++;
  }
  return Object.values(agg).filter(o => o.total > 0.5).map(o => {
    const c = o.cat || { name:'?', color:'#888', icon:'' };
    return { id:o.id, name:c.name, color:c.color, icon:c.icon, total:o.total, n:o.n, kind:c.kind, grp:c.grp };
  }).sort((a,b)=>b.total-a.total);
}

// Where the money went in a period — every outflow, in buckets that add up:
//   income − (regular + oneOffs + cash + people + loan) = change in balance (≈, FX aside)
export function moneyFlow(period, rates, big=BIG_DEFAULT){
  const f = { income:0, regular:0, oneOffs:0, cash:0, people:0, loan:0, bigList:[] };
  const rows = flowRows(period, rates);
  for(const r of rows){
    if(r.cls === 'income') f.income += r.v;
    else if(r.cls === 'spend'){ if(r.v >= big){ f.oneOffs += r.v; f.bigList.push(r); } else f.regular += r.v; }
    else if(r.cls === 'refund') f.regular -= r.v;
    else if(r.cls === 'cash') f.cash += r.amount < 0 ? r.v : -r.v;
    else if(r.cls === 'people') f.people += r.amount < 0 ? r.v : -r.v;
    else if(r.cls === 'loan') f.loan += r.v;
  }
  // cash moved into a tracked wallet (Novčanik) is spent there and already counted
  const mirrored = db.get(`SELECT COALESCE(SUM(t.amount),0) AS s FROM transactions t
    WHERE t.dedupe_key LIKE '%|w' ${period ? 'AND ' + monthCond(period,'t.date').cond : ''}`, period ? monthCond(period,'t.date').params : []).s;
  f.cash = Math.max(0, f.cash - Math.abs(toRSD(mirrored, 'RSD', rates)));
  f.people = Math.max(0, f.people);
  f.bigList.sort((a,b)=>b.v-a.v);
  f.out = f.regular + f.oneOffs + f.cash + f.people + f.loan;
  f.left = f.income - f.out;
  return f;
}

// Practical saving ideas for a period (monthly figures):
//  - "wants" categories (restaurants, shopping, fun…) with the effect of −30%
//  - frequent small purchases at the same merchant (impulse trips)
//  - untracked cash
export function savingIdeas(period, rates, months, big=BIG_DEFAULT){
  const mc = Math.max(1, months||1);
  const ideas = [];
  const wants = categoryBreakdown(period, 'expense', rates).filter(c => c.grp === 'wants');
  // per-category: regular spending only (one-offs aren't a habit)
  const bigByCat = {};
  for(const r of flowRows(period, rates)) if(r.cls==='spend' && r.v >= big) bigByCat[r.category_id] = (bigByCat[r.category_id]||0) + r.v;
  for(const c of wants){
    const m = (c.total - (bigByCat[c.id]||0)) / mc;
    if(m >= 3000) ideas.push({ type:'cut', cat:c, monthly:m, save:m*0.3 });
  }
  ideas.sort((a,b)=>b.save-a.save);
  // impulse trips: same merchant, >= 2 visits/month on average, small baskets
  const { cond, params } = monthCond(period, 't.date');
  const ex = excludedIds(EXCLUDE_SPENDING);
  const trips = db.all(`SELECT t.merchant AS merchant, t.category_id AS cid, COUNT(*) AS n, SUM(ABS(t.amount)*${convExpr(rates,'t.currency')}) AS total
    FROM transactions t WHERE t.amount<0 AND t.merchant IS NOT NULL AND t.merchant<>''
    ${ex.length?`AND (t.category_id IS NULL OR t.category_id NOT IN (${ex.join(',')}))`:''}
    ${cond?'AND '+cond:''} GROUP BY t.merchant HAVING n >= ? ORDER BY n DESC LIMIT 3`, [...params, Math.ceil(2*mc)]);
  for(const t of trips){ const avg = t.total/t.n; if(avg < 1500) ideas.push({ type:'trips', merchant:t.merchant, perMonth:t.n/mc, avg, monthly:t.total/mc }); }
  const flow = moneyFlow(period, rates, big);
  if(flow.cash/mc >= 5000) ideas.push({ type:'cash', monthly: flow.cash/mc });
  return ideas;
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

// Recurring charges (subscriptions, bills): same merchant in >= 3 distinct months
// with a STABLE amount. Transfers to people, cash withdrawals, FX and loan
// principal are not subscriptions and are excluded. Estimated monthly cost (RSD).
export function recurring(rates, range){
  const { cond, params } = monthCond(range);
  const ex = excludedIds(EXCLUDE_SPENDING);
  const rows = db.all(
    `SELECT merchant, substr(date,1,7) AS m, ABS(amount) AS amt, currency, category_id
     FROM transactions WHERE amount<0 AND merchant IS NOT NULL AND merchant<>''
     ${ex.length?`AND (category_id IS NULL OR category_id NOT IN (${ex.join(',')}))`:''}
     ${cond?'AND '+cond:''}`, params);
  const byMerch = {};
  const transferCats = new Set(db.all(`SELECT id FROM categories WHERE kind='transfer'`).map(r=>r.id));
  for(const r of rows){
    const amt = toRSD(r.amt, r.currency, rates);
    const o = byMerch[r.merchant] || (byMerch[r.merchant] = { merchant:r.merchant, months:new Set(), amts:[], cats:{} });
    if(transferCats.has(r.category_id)) continue;   // shared costs / transfers aren't subscriptions
    o.months.add(r.m); o.amts.push(amt); o.cats[r.category_id] = (o.cats[r.category_id]||0) + 1;
  }
  const list = [];
  for(const o of Object.values(byMerch)){
    if(o.months.size >= 3){
      const avg = o.amts.reduce((s,x)=>s+x,0)/o.amts.length;
      const sorted=[...o.amts].sort((a,b)=>a-b); const med = sorted[Math.floor(sorted.length/2)];
      // A subscription/bill looks like: about once a month (not a shop or a petrol
      // station you visit often), in most months of its lifetime, at a stable price.
      const ms = [...o.months].sort(), [fy,fm] = ms[0].split('-').map(Number), [ly,lm] = ms[ms.length-1].split('-').map(Number);
      const span = (ly-fy)*12 + (lm-fm) + 1;
      const perMonth = o.amts.length / o.months.size, coverage = o.months.size / span;
      const near = o.amts.filter(x => Math.abs(x-med) <= med*0.2).length;
      if(med > 0 && perMonth <= 1.25 && coverage >= 0.75 && near/o.amts.length >= 0.7)
        list.push({ merchant:o.merchant, months:o.months.size, count:o.amts.length, avg, median:med,
          monthly: med * o.amts.length / o.months.size,   // e.g. charged twice a month
          category_id: +Object.entries(o.cats).sort((a,b)=>b[1]-a[1])[0]?.[0] || null });
    }
  }
  return list.sort((a,b)=>b.median-a.median);
}

// ---------- budgets ----------
// `period` may be a month, a {from,to} range, or null. For multi-month periods
// pass `monthsCount` so the (monthly) budget amount is scaled to the window.
export function budgetStatus(period, rates, monthsCount=1){
  const budgets = db.all(`SELECT b.category_id, b.amount, c.name, c.icon, c.color
    FROM budgets b JOIN categories c ON c.id=b.category_id WHERE c.archived=0`);
  const spendByCat = {};
  for(const r of categoryBreakdown(period,'expense',rates)) spendByCat[r.id] = r.total;
  const rows = budgets.map(b=>{
    const amount = b.amount * (monthsCount||1);
    const spent = spendByCat[b.category_id] || 0;
    const pct = amount ? spent/amount*100 : 0;
    return {...b, amount, monthly:b.amount, spent, pct, remaining:amount-spent, over:spent>amount};
  });
  return rows.sort((a,b)=>b.pct-a.pct);
}

// ---------- 50/30/20 ----------
export function needsWants(period, rates){
  let needs=0, wants=0;
  for(const c of categoryBreakdown(period, 'expense', rates)){
    if(EXCLUDE_SPENDING.includes(c.name)) continue;
    if(c.grp==='needs') needs += c.total; else if(c.grp==='wants') wants += c.total;
  }
  return { needs, wants };
}

// ---------- projection ----------
export function projection(month, rates, todayISO){
  if(!todayISO || todayISO.slice(0,7)!==month) return null;
  const [y,m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const day = Number(todayISO.slice(8,10));
  if(day<1) return null;
  // real spending only (same definition as the "Potrošnja" KPI it sits next to)
  const spent = spendingBetween(`${month}-01`, todayISO, rates);
  return { spent, projected: spent/day*daysInMonth, day, daysInMonth };
}

// Real spending (RSD, net of refunds; excludes transfers/cash/FX/principal) between two ISO dates, inclusive.
export function spendingBetween(fromISO, toISO, rates){
  const cats = catLookup();
  let s = 0;
  for(const r of db.all(`SELECT amount, currency, category_id FROM transactions WHERE date>=? AND date<=?`, [fromISO, toISO])){
    const cls = classify(cats[r.category_id] || null, r.amount), v = Math.abs(toRSD(r.amount, r.currency, rates));
    if(cls === 'spend') s += v; else if(cls === 'refund') s -= v;
  }
  return s;
}
function excludedIds(names){
  if(!names.length) return [];
  return db.all(`SELECT id FROM categories WHERE name IN (${names.map(()=>'?').join(',')})`, names).map(r=>+r.id);
}
// ids of categories whose credits count as refunds / shared-cost paybacks
export function refundCategoryIds(){
  return db.all(`SELECT id, name, kind FROM categories`).filter(c => classify(c, 1) === 'refund').map(c => +c.id);
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

// ---------- biggest category movers (real spending only) ----------
export function categoryMovers(curPeriod, prevPeriod, rates){
  const cats = catLookup();
  const q = (period) => { const map = {};
    for(const c of categoryBreakdown(period, 'expense', rates)) if(!EXCLUDE_SPENDING.includes(c.name)) map[c.id] = c.total;
    return map; };
  const cur=q(curPeriod), prev=prevPeriod?q(prevPeriod):{};
  const ids=new Set([...Object.keys(cur), ...Object.keys(prev)]);
  return [...ids].map(id=>({ cat:cats[id]||{name:'?',icon:'',color:'#888'}, cur:cur[id]||0, prev:prev[id]||0, delta:(cur[id]||0)-(prev[id]||0) }))
    .sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
}

// ---------- per-account stats (in each account's own currency) ----------
// avgSpend = avg monthly real spending; avgNet = avg monthly savings (real income − real spending).
export function accountStats(period){
  const accts = db.all(`SELECT id,name,currency,color,type FROM accounts WHERE archived=0`);
  const cats = catLookup();
  const { cond, params } = monthCond(period);
  const rows = db.all(`SELECT account_id, substr(date,1,7) AS m, amount, category_id FROM transactions ${cond?'WHERE '+cond:''}`, params);
  const agg = {};
  for(const r of rows){
    const o = agg[r.account_id] || (agg[r.account_id] = { months:new Set(), spend:0, net:0, inSum:0, outSum:0 });
    const cls = classify(cats[r.category_id] || null, r.amount), v = Math.abs(r.amount);
    o.months.add(r.m);
    if(r.amount < 0) o.outSum += v; else o.inSum += v;
    if(cls === 'spend'){ o.spend += v; o.net -= v; }
    else if(cls === 'refund'){ o.spend -= v; o.net += v; }
    else if(cls === 'income') o.net += v;
  }
  return accts.map(a=>{
    const o = agg[a.id];
    if(!o) return { ...a, months:0, avgSpend:0, avgNet:0, totalIn:0, totalOut:0 };
    const mc = o.months.size || 1;
    return { ...a, months:o.months.size, avgSpend: o.spend/mc, avgNet: o.net/mc, totalIn:o.inSum, totalOut:o.outSum };
  });
}

export { fmtMonth };
