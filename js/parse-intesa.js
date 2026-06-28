// Banca Intesa "IZVOD PLATNOG RAČUNA" parser — column-aware, browser-portable.
//
// Input: pages = [ { items: [ {str, x, y, w} , ... ] }, ... ]
//   where x = left edge, y = baseline (PDF coords, y grows upward), w = item width.
//   In pdf.js: x=transform[4], y=transform[5], w=item.width.
//
// Strategy: the statement is a fixed-template table. We locate column anchors from
// the header row, group items into transaction rows by the booking-date column,
// then assign each item to a field by its X position. Debit vs credit is decided by
// WHICH money column (Isplate vs Uplate) the amount's right edge lands in — and the
// running balance ("Stanje") is used as an independent cross-check.

const DATE = /^\d{2}\.\d{2}\.\d{4}$/;
const RSD  = /^\d{1,3}(\.\d{3})*,\d{1,2}$/;       // 1.234,56 (also matches split "175.600,0")
const PERIOD = /^\d+\.\d{2,4}$/;                    // 0.00 / 120.2687 / 21.51
const CCY = /^[A-Z]{3}$/;

// Tokens that occur ONLY in the page-bottom bank footer (NOT in the top promo
// paragraph, which also says "Banca Intesa"). Used to find the footer's top edge.
const FOOTER_TOK = /^(PIB:?|Mati[čc]ni|Milentija|Popovi[ćc]a|908-16001|žiro|Žiro)/i;

function num(s){ return parseFloat(s.replace(/\./g,'').replace(',', '.')); }

function findAccountNumber(lines){
  // header: "broj 160600000174040941 za mesec"
  for(const ln of lines){
    const m = ln.match(/broj\s+(\d{12,20})\s+za mesec/i);
    if(m) return m[1];
  }
  for(const ln of lines){ const m = ln.match(/\b(\d{16,20})\b/); if(m) return m[1]; }
  return '';
}

function findOpening(items){
  // "Početno stanje: RSD 749.733,09" or "... EUR 33,25" (account may be RSD or EUR)
  const flat = items.map(i=>i.str).join(' ');
  const m = flat.match(/stanje:?\s*([A-Z]{3})\s*([\d.]+,\d{2})/i);
  return m ? { amount: num(m[2]), currency: m[1].toUpperCase() } : { amount: null, currency: 'RSD' };
}

// Detect column X anchors from the header row (the row containing Isplate/Uplate/Stanje).
function detectColumns(items){
  const find = (re) => items.find(i => re.test(i.str.trim()));
  const isplate = find(/^Isplate$/), uplate = find(/^Uplate$/), stanje = find(/^Stanje$/);
  // Right-edge boundaries for right-aligned money columns; fall back to template constants.
  return {
    debitMax:  uplate ? uplate.x : 326.9,   // value right-edge < this  => Isplate (debit)
    creditMax: stanje ? stanje.x : 384.6,   // < this => Uplate (credit); >= => Stanje (balance)
  };
}

export function parseIntesaPages(pages){
  const allItems = [];
  pages.forEach((pg, pi) => pg.items.forEach(it => {
    if(it.str && it.str.trim()) allItems.push({ str: it.str.trim(), x: it.x, y: it.y, w: it.w||0, pi });
  }));
  const lines = pages.flatMap(pg => reconstructLines(pg.items));
  const account = findAccountNumber(lines);
  const { amount: opening, currency } = findOpening(allItems);
  const cols = detectColumns(allItems);

  // Per-page footer top edge: drop everything at/below it (bank address/PIB block).
  const footerTopY = {};
  for(const i of allItems){
    if(FOOTER_TOK.test(i.str)) footerTopY[i.pi] = Math.max(footerTopY[i.pi] ?? -Infinity, i.y);
  }

  // Booking-date items = date in the leftmost (Knjiženje) column.
  const dateItems = allItems
    .filter(i => i.x < 75 && DATE.test(i.str))
    .sort((a,b) => (b.pi - a.pi) * -1e6 + (b.y - a.y) * -1 ); // page asc, then y desc
  // sort properly: page ascending, within page y descending (top->bottom)
  dateItems.sort((a,b) => a.pi !== b.pi ? a.pi - b.pi : b.y - a.y);

  const txns = [];
  let prevBalance = opening;

  for(let k=0; k<dateItems.length; k++){
    const d = dateItems[k];
    const next = dateItems[k+1];
    // collect items in this transaction's band (same page, y between this date and next)
    const band = allItems.filter(i => {
      if(i.pi !== d.pi) return false;
      if(i.y > d.y + 3) return false;                 // above this row
      if(next && next.pi === d.pi && i.y <= next.y + 3) return false; // belongs to next
      if(footerTopY[d.pi] !== undefined && i.y <= footerTopY[d.pi] + 4) return false; // footer block
      return true;
    });

    const fields = assignFields(band, cols);
    if(!fields) continue;
    const { amount, balance, isCredit, description, counterparty, acct, fee, fx, ref } = fields;

    // cross-check sign with running balance when available
    let sign = isCredit ? 1 : -1;
    if(prevBalance != null && balance != null){
      const delta = balance - prevBalance;
      if(Math.abs(delta) > 0.005) sign = delta > 0 ? 1 : -1;
    }

    // magnitude: prefer parsed amount; else derive from balance delta; else unknown(0).
    let mag;
    if(amount != null) mag = Math.abs(amount);
    else if(balance != null && prevBalance != null) mag = Math.abs(balance - prevBalance);
    else mag = 0;
    txns.push({
      bookingDate: toISO(d.str),
      description, counterparty, acct,
      amount: round2(mag),
      signed: round2(sign * mag),
      sign: sign > 0 ? 'credit' : 'debit',
      balance: balance != null ? round2(balance) : null,
      fee, fx, ref, account, currency,
    });
    if(balance != null) prevBalance = balance;
  }
  return { account, currency, opening, transactions: txns };
}

function assignFields(band, cols){
  // money items (right-aligned numbers in Isplate/Uplate/Stanje area). Include lone
  // digit fragments ("5", "0") that are the wrapped tail of a split amount.
  const money = band.filter(i => (i.x > 250) && (i.x < 470) &&
    (RSD.test(i.str) || /^\d{1,2}$/.test(i.str) || /^\d{1,3}(\.\d{3})*,\d$/.test(i.str)));
  // group split money items by column using right edge
  let debit=[], credit=[], balanceArr=[];
  for(const m of money){
    const right = m.x + m.w;
    if(right < cols.debitMax)      debit.push(m);
    else if(right < cols.creditMax) credit.push(m);
    else                            balanceArr.push(m);
  }
  const joinNum = arr => arr.length ? num(arr.sort((a,b)=> b.y-a.y || a.x-b.x).map(i=>i.str).join('')) : null;
  let amount=null, isCredit=false;
  const dv = joinNum(debit), cv = joinNum(credit);
  if(cv != null){ amount = cv; isCredit = true; }
  if(dv != null){ amount = dv; isCredit = false; }
  const balance = joinNum(balanceArr);

  const inX = (i,a,b) => i.x >= a && i.x < b;
  const concat = (a,b) => band.filter(i => inX(i,a,b) && !RSD.test(i.str) && !DATE.test(i.str))
    .sort((p,q)=> q.y-p.y || p.x-q.x).map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();

  const description  = concat(180, 270);
  const counterparty = concat(415, 505);
  const acctTok = band.filter(i => inX(i,505,600) && /\d/.test(i.str)).sort((p,q)=>q.y-p.y||p.x-q.x).map(i=>i.str).join('');
  // fee
  const feeTok = band.filter(i => inX(i,600,645) && PERIOD.test(i.str)).map(i=>i.str)[0];
  const fee = feeTok ? parseFloat(feeTok) : 0;
  // FX: kurs(645-670), ccy(670-715), iznos(715-770)
  const kursTok = band.filter(i=>inX(i,640,675) && PERIOD.test(i.str)).map(i=>i.str)[0];
  const ccyTok  = band.filter(i=>inX(i,675,718) && CCY.test(i.str)).map(i=>i.str)[0];
  const iznTok  = band.filter(i=>inX(i,715,772) && PERIOD.test(i.str)).map(i=>i.str)[0];
  const fx = (kursTok && ccyTok) ? { kurs:parseFloat(kursTok), ccy:ccyTok, iznos: iznTok?parseFloat(iznTok):null } : null;
  // ref (x>=770): two parts across two lines
  const ref = band.filter(i => i.x >= 770).sort((p,q)=> q.y-p.y || p.x-q.x).map(i=>i.str).join('');

  if(amount == null && balance == null) return null;
  return { amount, balance, isCredit, description, counterparty, acct: acctTok, fee, fx, ref };
}

function reconstructLines(items, yTol=3){
  const rows=[];
  for(const it of items){
    if(!it.str || !it.str.trim()) continue;
    let r = rows.find(r => Math.abs(r.y-it.y)<=yTol);
    if(!r){ r={y:it.y,cells:[]}; rows.push(r); }
    r.cells.push({x:it.x,s:it.str});
  }
  rows.sort((a,b)=>b.y-a.y);
  return rows.map(r=>{ r.cells.sort((a,b)=>a.x-b.x); return r.cells.map(c=>c.s).join(' ').replace(/\s+/g,' ').trim(); }).filter(Boolean);
}

function toISO(d){ const [dd,mm,yy]=d.split('.'); return `${yy}-${mm}-${dd}`; }
function round2(n){ return Math.round(n*100)/100; }
