// Business logic on top of db.js: accounts, categories/rules, transaction insert
// (with auto-categorization + dedupe), statement import, and manual entry.

import * as db from './db.js';
import { cleanMerchant, categorize, sanitizeIcon, PROTECTED_CATEGORY_NAMES } from './categorize.js';

export const isProtectedCategory = (id) => {
  const c = db.get(`SELECT name FROM categories WHERE id=?`, [id]);
  return !!(c && PROTECTED_CATEGORY_NAMES.has(c.name));
};

export const getAccounts = (incl=false) =>
  db.all(`SELECT * FROM accounts ${incl?'':'WHERE archived=0'} ORDER BY type, name`);
export const getCategories = (inclArchived=false) =>
  db.all(`SELECT * FROM categories ${inclArchived?'':'WHERE archived=0'} ORDER BY kind, name`);
export const getRules = () => db.all(`SELECT r.*, c.kind FROM rules r JOIN categories c ON c.id=r.category_id`);

// ---------- budgets ----------
export function setBudget(category_id, amount){
  if(!(amount>0)){ db.run(`DELETE FROM budgets WHERE category_id=?`, [category_id]); return; }
  db.run(`INSERT INTO budgets(category_id,amount,period) VALUES(?,?,'monthly')
          ON CONFLICT(category_id) DO UPDATE SET amount=?`, [category_id, amount, amount]);
}

// ---------- category management ----------
const nameExists = (name, exceptId=null) =>
  !!db.get(`SELECT id FROM categories WHERE name=? ${exceptId?'AND id<>?':''}`, exceptId?[name,exceptId]:[name]);

// throws Error('exists') on duplicate name
export function addCategory({name, kind, color, icon, grp}){
  if(nameExists(name)) throw new Error('exists');
  db.run(`INSERT INTO categories(name,kind,color,icon,grp) VALUES(?,?,?,?,?)`,
    [name, kind||'expense', color||'#6b7280', sanitizeIcon(icon), grp||null]);
  return db.lastId();
}
// Protected (system) categories: only color/icon/grp editable, never name. throws Error('exists') on dup name.
export function updateCategory(id, fields){
  const protectedCat = isProtectedCategory(id);
  const allowed = protectedCat ? ['color','icon','grp'] : ['name','color','icon','grp'];
  const out = {};
  for(const k of allowed) if(k in fields) out[k] = k==='icon' ? sanitizeIcon(fields[k]) : fields[k];
  if(out.name!=null && nameExists(out.name, id)) throw new Error('exists');
  const keys = Object.keys(out);
  if(!keys.length) return;
  db.run(`UPDATE categories SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`, [...keys.map(k=>out[k]), id]);
}
// Delete a category: move its transactions to "Ostalo / Nekategorisano", drop its budget/rules.
// Protected/system categories cannot be deleted.
export function deleteCategory(id){
  if(isProtectedCategory(id)) return false;
  const fallback = catMap()['Ostalo / Nekategorisano'];
  if(id === fallback || fallback == null) return false;
  db.run(`UPDATE transactions SET category_id=? WHERE category_id=?`, [fallback, id]);
  db.run(`DELETE FROM budgets WHERE category_id=?`, [id]);
  db.run(`DELETE FROM rules WHERE category_id=?`, [id]);
  db.run(`DELETE FROM categories WHERE id=?`, [id]);
  return true;
}
export const catMap = () => { const m={}; for(const c of getCategories()) m[c.name]=c.id; return m; };

export function findOrCreateAccountByNumber(number, { bank, currency, name }){
  if(number){
    const a = db.get(`SELECT * FROM accounts WHERE account_number=?`, [number]);
    if(a) return a;
  } else {
    // no parseable account number — match by the deterministic name to avoid duplicates
    const a = db.get(`SELECT * FROM accounts WHERE account_number IS NULL AND name=?`, [name]);
    if(a) return a;
  }
  db.run(`INSERT INTO accounts(name,type,bank,account_number,currency,color) VALUES(?,?,?,?,?,?)`,
    [name, 'bank', bank||null, number||null, currency||'RSD', '#3b82f6']);
  return db.get(`SELECT * FROM accounts WHERE id=?`, [db.lastId()]);
}

// Find (or create) the cash "slamarica" account for a given currency, so cash can
// be held in multiple currencies (each currency = its own cash account, keeping
// per-currency balances correct).
export function findOrCreateCashAccount(currency){
  currency = (currency||'RSD').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3) || 'RSD';
  const a = db.get(`SELECT * FROM accounts WHERE type='cash' AND currency=? AND archived=0`, [currency]);
  if(a) return a;
  const name = currency==='RSD' ? 'Keš (slamarica)' : `Keš (${currency})`;
  db.run(`INSERT INTO accounts(name,type,currency,color) VALUES(?,?,?,?)`, [name,'cash',currency,'#64748b']);
  return db.get(`SELECT * FROM accounts WHERE id=?`, [db.lastId()]);
}

function defaultCategoryId(isCredit){
  const m = catMap();
  return isCredit ? m['Ostali prilivi'] : m['Ostalo / Nekategorisano'];
}

// Insert one transaction. tx: {account_id,date,amount(signed),currency,description,
//   counterparty,merchant,ref,fee,fx,balance,source,note,dedupe_key,category_id?}
// Returns 'inserted' | 'skipped'(duplicate).
export function insertTransaction(tx, rules){
  if(tx.dedupe_key){
    const dup = db.get(`SELECT id FROM transactions WHERE dedupe_key=?`, [tx.dedupe_key]);
    if(dup) return 'skipped';
  }
  const isCredit = tx.amount >= 0;
  let catId = tx.category_id;
  if(catId == null){
    catId = categorize({ merchant_clean: tx.merchant, description: tx.description, counterparty: tx.counterparty },
                       rules || getRules(), isCredit);
    if(catId == null) catId = defaultCategoryId(isCredit);
  }
  db.run(`INSERT INTO transactions
    (account_id,date,amount,currency,description,counterparty,merchant,category_id,ref,fee,fx,balance,source,note,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tx.account_id, tx.date, tx.amount, tx.currency||'RSD', tx.description||null, tx.counterparty||null,
     tx.merchant||null, catId, tx.ref||null, tx.fee||0, tx.fx?JSON.stringify(tx.fx):null,
     tx.balance??null, tx.source||'manual', tx.note||null, tx.dedupe_key||null, new Date().toISOString()]);
  return 'inserted';
}

// Import a parsed Banca Intesa statement (output of parseIntesaPages).
export function importStatement(parsed, fileName){
  const rules = getRules();
  const acct = findOrCreateAccountByNumber(parsed.account, {
    bank: 'Banca Intesa', currency: parsed.currency || 'RSD',
    name: `Banca Intesa ${parsed.currency==='EUR'?'devizni':'tekući'} ···${(parsed.account||'').slice(-4)}`,
  });
  let inserted=0, skipped=0;
  const dates = parsed.transactions.map(t=>t.bookingDate).sort();
  for(const t of parsed.transactions){
    const merchant = cleanMerchant(t.counterparty, t.description);
    // include running balance: it is unique per row, so two same-day same-amount
    // transactions with no reference number no longer collide and get dropped.
    const dedupe = `${parsed.account||acct.id}|${t.ref||''}|${t.bookingDate}|${t.signed}|${t.balance??''}`;
    const r = insertTransaction({
      account_id: acct.id, date: t.bookingDate, amount: t.signed, currency: t.currency||acct.currency,
      description: t.description, counterparty: t.counterparty, merchant,
      ref: t.ref, fee: t.fee, fx: t.fx, balance: t.balance, source: 'pdf', dedupe_key: dedupe,
    }, rules);
    if(r==='inserted') inserted++; else skipped++;
  }
  // maintain earliest opening balance for correct running totals
  if(parsed.opening != null && dates.length){
    const firstDate = dates[0];
    if(!acct.opening_date || firstDate < acct.opening_date){
      db.run(`UPDATE accounts SET opening_balance=?, opening_date=? WHERE id=?`,
        [parsed.opening, firstDate, acct.id]);
    }
  }
  return { account: acct, inserted, skipped, total: parsed.transactions.length };
}

export function addManual({account_id, date, amount, kind, category_id, description, note}){
  const signed = kind==='income' ? Math.abs(amount) : -Math.abs(amount);
  const acct = db.get(`SELECT * FROM accounts WHERE id=?`, [account_id]);
  return insertTransaction({
    account_id, date, amount: signed, currency: acct?.currency||'RSD',
    description, merchant: description, category_id, source:'manual', note,
  });
}

export function deleteTransaction(id){ db.run(`DELETE FROM transactions WHERE id=?`, [id]); }
export function setCategory(txId, catId){ db.run(`UPDATE transactions SET category_id=? WHERE id=?`, [catId, txId]); }

export function addAccount({name,type,bank,currency,opening_balance,color}){
  db.run(`INSERT INTO accounts(name,type,bank,currency,opening_balance,opening_date,color) VALUES(?,?,?,?,?,?,?)`,
    [name, type||'bank', bank||null, currency||'RSD', opening_balance||0,
     opening_balance?new Date().toISOString().slice(0,10):null, color||'#3b82f6']);
  return db.lastId();
}
export function updateAccount(id, fields){
  const keys = Object.keys(fields);
  db.run(`UPDATE accounts SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`, [...keys.map(k=>fields[k]), id]);
}

export function addRule(match, category_id, priority=3){
  db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [match.toUpperCase(), category_id, priority]);
}
export function deleteRule(id){ db.run(`DELETE FROM rules WHERE id=?`, [id]); }

// Re-run categorization for all uncategorized / or all transactions.
export function recategorizeAll(onlyDefault=true){
  const rules = getRules();
  const m = catMap();
  const defExp = m['Ostalo / Nekategorisano'], defInc = m['Ostali prilivi'];
  const rows = db.all(`SELECT * FROM transactions`);
  let changed=0;
  for(const t of rows){
    if(onlyDefault && t.category_id !== defExp && t.category_id !== defInc) continue;
    const cat = categorize(t, rules, t.amount>=0);
    if(cat && cat !== t.category_id){ db.run(`UPDATE transactions SET category_id=? WHERE id=?`,[cat,t.id]); changed++; }
  }
  return changed;
}
