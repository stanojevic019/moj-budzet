// Business logic on top of db.js: accounts, categories/rules, transaction insert
// (with auto-categorization + dedupe), statement import, and manual entry.

import * as db from './db.js';
import { cleanMerchant, categorize, sanitizeIcon, PROTECTED_CATEGORY_NAMES, merchantKey, trainModel, isCompany,
  AMOUNT_BOUND, AMOUNT_TOL, amountKey, parseLearnedKey } from './categorize.js';

// Build the learning context: merchant memory + a Naive Bayes model trained on the
// user's already-categorized transactions. Cheap enough to build per import/recat.
export function buildCtx(){
  const learned = {}, learnedAmt = {};
  for(const r of db.all(`SELECT key, category_id FROM learned`)){
    const p = parseLearnedKey(r.key);
    if(p) (learnedAmt[p.key] || (learnedAmt[p.key] = [])).push({ amt: p.amt, cid: r.category_id });
    else learned[r.key] = r.category_id;
  }
  const m = catMap();
  const defE = m['Ostalo / Nekategorisano'], defI = m['Ostali prilivi'];
  const kind = {}; for(const c of getCategories(true)) kind[c.id] = c.kind;
  const bound = new Set(AMOUNT_BOUND.map(n => m[n]).filter(id => id != null));
  const samples = db.all(
    `SELECT merchant, description, category_id FROM transactions
     WHERE category_id IS NOT NULL AND category_id NOT IN (?,?)`, [defE, defI])
    .map(r => ({ text: `${r.merchant||''} ${r.description||''}`, category_id: r.category_id, kind: kind[r.category_id] }));
  return { learned, learnedAmt, bound, kind, model: trainModel(samples) };
}

export const isProtectedCategory = (id) => {
  const c = db.get(`SELECT name FROM categories WHERE id=?`, [id]);
  return !!(c && PROTECTED_CATEGORY_NAMES.has(c.name));
};

export const getAccounts = (incl=false) =>
  db.all(`SELECT * FROM accounts ${incl?'':'WHERE archived=0'} ORDER BY type, name`);
export const getCategories = (inclArchived=false) =>
  db.all(`SELECT * FROM categories ${inclArchived?'':'WHERE archived=0'} ORDER BY kind, name`);
export const getRules = () => db.all(`SELECT r.*, c.kind, c.name AS cat_name FROM rules r JOIN categories c ON c.id=r.category_id`);

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
export function addCategory({name, kind, color, icon, grp, parent_id}){
  if(nameExists(name)) throw new Error('exists');
  db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES(?,?,?,?,?,?)`,
    [name, kind||'expense', color||'#6b7280', sanitizeIcon(icon), grp||null, parent_id||null]);
  return db.lastId();
}
// Protected (system) categories: only color/icon/grp editable, never name. throws Error('exists') on dup name.
export function updateCategory(id, fields){
  const protectedCat = isProtectedCategory(id);
  const allowed = protectedCat ? ['color','icon','grp','parent_id'] : ['name','color','icon','grp','parent_id'];
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
  db.run(`UPDATE categories SET parent_id=NULL WHERE parent_id=?`, [id]);   // children become top-level groups
  db.run(`UPDATE transactions SET category_id=? WHERE category_id=?`, [fallback, id]);
  db.run(`DELETE FROM budgets WHERE category_id=?`, [id]);
  db.run(`DELETE FROM rules WHERE category_id=?`, [id]);
  db.run(`DELETE FROM categories WHERE id=?`, [id]);
  return true;
}
// Categories grouped as [{group, subs:[...]}] for pickers / management.
export function getCatTree(){
  const cats = getCategories();
  const groups = cats.filter(c=>c.parent_id==null);
  return groups.map(g => ({ ...g, subs: cats.filter(c=>c.parent_id===g.id) }));
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
// Find or create a type='cash' account. `byName` keys the lookup on the exact
// name (used by the wallet, which can coexist with the slamarica in one currency);
// otherwise one cash account per currency. The type='cash' guard means a bank
// account that merely happens to share the name is never treated as the target.
function findOrCreateCash(currency, { name, color='#64748b', byName=false } = {}){
  currency = (currency||'RSD').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3) || 'RSD';
  const finalName = name || (currency==='RSD' ? 'Keš (slamarica)' : `Keš (${currency})`);
  const a = byName
    ? db.get(`SELECT * FROM accounts WHERE type='cash' AND name=? AND archived=0`, [finalName])
    : db.get(`SELECT * FROM accounts WHERE type='cash' AND currency=? AND archived=0`, [currency]);
  if(a) return a;
  db.run(`INSERT INTO accounts(name,type,currency,color) VALUES(?,?,?,?)`, [finalName,'cash',currency,color]);
  return db.get(`SELECT * FROM accounts WHERE id=?`, [db.lastId()]);
}
export function findOrCreateCashAccount(currency){ return findOrCreateCash(currency); }

// The "Novčanik" wallet (per currency) that receives mirrored ATM withdrawals.
export function findOrCreateWallet(currency){
  currency = (currency||'RSD').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3) || 'RSD';
  const name = currency==='RSD' ? 'Novčanik' : `Novčanik (${currency})`;
  return findOrCreateCash(currency, { name, color:'#0ea5e9', byName:true });
}

// Insert one transaction. tx: {account_id,date,amount(signed),currency,description,
//   counterparty,merchant,ref,fee,fx,balance,source,note,dedupe_key,category_id?}
// Returns 'inserted' | 'skipped'(duplicate).
export function insertTransaction(tx, rules, ctx, opts){
  if(tx.dedupe_key){
    const dup = db.get(`SELECT id FROM transactions WHERE dedupe_key=?`, [tx.dedupe_key]);
    if(dup) return 'skipped';
  }
  const m = catMap();
  const isCredit = tx.amount >= 0;
  let catId = tx.category_id;
  if(catId == null){
    catId = categorize({ merchant_clean: tx.merchant, description: tx.description, counterparty: tx.counterparty, amount: tx.amount },
                       rules || getRules(), isCredit, ctx);
    if(catId == null) catId = isCredit ? m['Ostali prilivi'] : m['Ostalo / Nekategorisano'];
  }
  db.run(`INSERT INTO transactions
    (account_id,date,amount,currency,description,counterparty,merchant,category_id,ref,fee,fx,balance,source,note,dedupe_key,import_batch,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tx.account_id, tx.date, tx.amount, tx.currency||'RSD', tx.description||null, tx.counterparty||null,
     tx.merchant||null, catId, tx.ref||null, tx.fee||0, tx.fx?JSON.stringify(tx.fx):null,
     tx.balance??null, tx.source||'manual', tx.note||null, tx.dedupe_key||null, tx.import_batch||null, new Date().toISOString()]);
  // ATM withdrawal → mirror the cash into the "Novčanik" wallet as an internal
  // transfer, so cash on hand (and cash spending) can be tracked. Only on import
  // (opts.allowMirror), only for actual cash withdrawals, only with a dedupe key.
  // The mirror dedupe key is the parent key + '|w', so a single-row delete can
  // cascade to it (see deleteTransaction) and re-import stays idempotent.
  if(opts && opts.allowMirror && tx.amount < 0 && tx.dedupe_key && catId === m['Podizanje keša']){
    const cur = (tx.currency||'RSD');
    const wallet = findOrCreateWallet(cur);
    const dk = tx.dedupe_key + '|w';
    if(!db.get(`SELECT id FROM transactions WHERE dedupe_key=?`, [dk])){
      db.run(`INSERT INTO transactions
        (account_id,date,amount,currency,description,merchant,category_id,source,dedupe_key,import_batch,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [wallet.id, tx.date, Math.abs(tx.amount), cur, 'Podizanje keša → Novčanik',
         'Novčanik', m['Interni prenos'], 'pdf', dk, opts.importBatch||null, new Date().toISOString()]);
    }
  }
  return 'inserted';
}

// Import a parsed Banca Intesa statement. `batch` tags every inserted row so a
// whole import can later be deleted as a unit.
export function importStatement(parsed, fileName, batch, bankLabel){
  const rules = getRules();
  const ctx = buildCtx();
  const importBatch = `${batch||new Date().toISOString()}|${fileName||''}`;
  const bank = (bankLabel||'Banca Intesa').replace(/\s*\(.*\)\s*/,'').trim() || 'Banka';  // strip "(izvod)" etc.
  const last4 = (parsed.account||'').slice(-4);
  const acct = findOrCreateAccountByNumber(parsed.account, {
    bank, currency: parsed.currency || 'RSD',
    name: bank==='Banca Intesa'
      ? `Banca Intesa ${parsed.currency==='EUR'?'devizni':'tekući'} ···${last4}`
      : `${bank} ···${last4}`,
  });
  let inserted=0, skipped=0;
  const mirror = db.getSetting('mirror_atm','0')==='1';
  const dates = parsed.transactions.map(t=>t.bookingDate).sort();
  const seen = {};
  for(const t of parsed.transactions){
    const merchant = cleanMerchant(t.counterparty, t.description);
    // include running balance: it is unique per row, so two same-day same-amount
    // transactions with no reference number no longer collide and get dropped.
    // Formats without a running balance/ref (e.g. "Račun transakcije") give two
    // identical same-day purchases the same key — number repeats within the file so
    // the 2nd coffee isn't silently dropped. The 1st keeps the original key.
    const base = `${parsed.account||acct.id}|${t.ref||''}|${t.bookingDate}|${t.signed}|${t.balance??''}`;
    seen[base] = (seen[base]||0) + 1;
    const dedupe = seen[base] > 1 ? `${base}#${seen[base]}` : base;
    const r = insertTransaction({
      account_id: acct.id, date: t.bookingDate, amount: t.signed, currency: t.currency||acct.currency,
      description: t.description, counterparty: t.counterparty, merchant,
      ref: t.ref, fee: t.fee, fx: t.fx, balance: t.balance, source: 'pdf', dedupe_key: dedupe, import_batch: importBatch,
    }, rules, ctx, { allowMirror: mirror, importBatch });
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
  if(!acct || !/^\d{4}-\d{2}-\d{2}$/.test(date||'')) throw new Error('invalid');
  // The account's opening balance was stated as of opening_date, so it already
  // reflects anything that happened before it. Shift it so the current balance
  // (opening + Σ amounts) is unchanged by a back-dated entry.
  if(acct.opening_date && date < acct.opening_date){
    db.run(`UPDATE accounts SET opening_balance=opening_balance-? WHERE id=?`, [signed, account_id]);
  }
  const res = insertTransaction({
    account_id, date, amount: signed, currency: acct?.currency||'RSD',
    description, merchant: description, category_id, source:'manual', note,
  });
  if(res==='inserted' && category_id) learnFromTx(db.lastId(), category_id);  // teach from manual entries too
  return res;
}

export function deleteTransaction(id){
  const t = db.get(`SELECT dedupe_key FROM transactions WHERE id=?`, [id]);
  db.run(`DELETE FROM transactions WHERE id=?`, [id]);
  // also drop the Novčanik mirror row (dedupe_key + '|w') so cash isn't left orphaned
  if(t && t.dedupe_key) db.run(`DELETE FROM transactions WHERE dedupe_key=?`, [t.dedupe_key + '|w']);
}
// Keep the Novčanik mirror in sync with a transaction's category: present only while
// it is a "Podizanje keša" debit (and wallet tracking is on), otherwise removed.
function syncMirror(txId){
  const t = db.get(`SELECT * FROM transactions WHERE id=?`, [txId]);
  if(!t || !t.dedupe_key || t.dedupe_key.endsWith('|w')) return;
  const dk = t.dedupe_key + '|w';
  const isCash = t.amount < 0 && t.category_id === catMap()['Podizanje keša'];
  const has = db.get(`SELECT id FROM transactions WHERE dedupe_key=?`, [dk]);
  if(!isCash && has) db.run(`DELETE FROM transactions WHERE id=?`, [has.id]);
  else if(isCash && !has && db.getSetting('mirror_atm','0')==='1'){
    const wallet = findOrCreateWallet(t.currency||'RSD');
    db.run(`INSERT INTO transactions
      (account_id,date,amount,currency,description,merchant,category_id,source,dedupe_key,import_batch,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [wallet.id, t.date, Math.abs(t.amount), t.currency||'RSD', 'Podizanje keša → Novčanik',
       'Novčanik', catMap()['Interni prenos'], 'pdf', dk, t.import_batch||null, new Date().toISOString()]);
  }
}
// teach: remember this merchant→category so future imports recognize it
export function learnFromTx(txId, catId){
  const t = db.get(`SELECT merchant, description, counterparty, amount FROM transactions WHERE id=?`, [txId]);
  if(!t) return;
  const k = merchantKey(t.merchant, t.description);
  if(!k) return;
  const upsert = (key) => db.run(`INSERT INTO learned(key,category_id,n) VALUES(?,?,1)
          ON CONFLICT(key) DO UPDATE SET category_id=?, n=n+1`, [key, catId, catId]);
  const c = db.get(`SELECT name FROM categories WHERE id=?`, [catId]);
  const amt = Math.abs(t.amount || 0);
  if(c && AMOUNT_BOUND.includes(c.name) && amt && !isCompany(t.counterparty || t.merchant)){ upsert(amountKey(k, amt)); return; }
  // a different choice for this amount overrides an older amount-bound memory
  for(const r of db.all(`SELECT key FROM learned WHERE substr(key,1,?)=?`, [k.length+1, k+'#'])){
    const p = parseLearnedKey(r.key);
    if(p && p.key === k && Math.abs(amt - p.amt) <= p.amt * AMOUNT_TOL) db.run(`DELETE FROM learned WHERE key=?`, [r.key]);
  }
  upsert(k);
}
// One-time (migration v13): older "person → pass-through / currency exchange" memories
// were by name only. Re-learn them with the amounts actually seen, so that a different
// amount from the same person is no longer silently dropped from the analysis.
export function bindLearnedAmounts(){
  const m = catMap(); let n = 0;
  const ids = AMOUNT_BOUND.map(x => m[x]).filter(id => id != null);
  if(!ids.length) return 0;
  const keys = new Set(db.all(`SELECT key FROM learned WHERE category_id IN (${ids.join(',')})`).map(r => r.key));
  for(const t of db.all(`SELECT merchant, description, counterparty, amount, category_id FROM transactions WHERE category_id IN (${ids.join(',')})`)){
    const k = merchantKey(t.merchant, t.description);
    if(!k || !keys.has(k) || !t.amount || isCompany(t.counterparty || t.merchant)) continue;
    const key = amountKey(k, t.amount);
    if(db.get(`SELECT 1 AS x FROM learned WHERE key=?`, [key])) continue;
    db.run(`INSERT INTO learned(key,category_id,n) VALUES(?,?,1)`, [key, t.category_id]); n++;
  }
  return n;
}
export const learnedCount = () => db.get(`SELECT COUNT(*) AS c FROM learned`).c;
// Debits still in "Ostalo / Nekategorisano" — the triage queue.
export function uncategorizedCount(){
  const u = catMap()['Ostalo / Nekategorisano']; if(u == null) return 0;
  return db.get(`SELECT COUNT(*) AS c FROM transactions WHERE category_id=? AND amount<0`, [u]).c;
}
// Next item to triage: the merchant with the most uncategorized debits first (one
// decision then sorts the most rows), newest row of that merchant.
export function nextUncategorized(skip=[]){
  const u = catMap()['Ostalo / Nekategorisano']; if(u == null) return null;
  const ph = skip.length ? `AND id NOT IN (${skip.map(()=>'?').join(',')})` : '';
  return db.get(`SELECT t.*, (SELECT COUNT(*) FROM transactions x WHERE x.category_id=t.category_id AND x.amount<0
      AND COALESCE(x.merchant,'')=COALESCE(t.merchant,'')) AS same
    FROM transactions t WHERE category_id=? AND amount<0 ${ph}
    ORDER BY same DESC, date DESC, id DESC LIMIT 1`, [u, ...skip]);
}
// Assign a category from triage: teach it, then let the learned memory sort every
// other uncategorized row of the same merchant. Returns how many others were sorted.
export function triageAssign(txId, catId){
  setCategory(txId, catId);
  return recategorizeAll(true);
}
// How many "Podizanje keša" debits are NOT mirrored into a Novčanik (i.e. untracked cash)?
export function unmirroredCashCount(){
  const podz = catMap()['Podizanje keša']; if(!podz) return 0;
  return db.get(`SELECT COUNT(*) AS c FROM transactions t WHERE t.category_id=? AND t.amount<0
    AND NOT EXISTS(SELECT 1 FROM transactions w WHERE w.dedupe_key = t.dedupe_key || '|w')`, [podz]).c;
}
// Reclassify those untracked cash withdrawals into a real expense category ("Gotovina (keš)"),
// so they count as spending (the cash left the accounts and wasn't tracked in a wallet).
export function cashWithdrawalsToExpense(){
  const podz = catMap()['Podizanje keša']; if(!podz) return 0;
  let cash = db.get(`SELECT id FROM categories WHERE name='Gotovina (keš)'`);
  if(!cash){
    const grp = db.get(`SELECT id FROM categories WHERE name='Ostalo' AND parent_id IS NULL`);
    db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES('Gotovina (keš)','expense','#64748b','💵',NULL,?)`, [grp ? grp.id : null]);
    cash = { id: db.lastId() };
  }
  const rows = db.all(`SELECT id FROM transactions t WHERE t.category_id=? AND t.amount<0
    AND NOT EXISTS(SELECT 1 FROM transactions w WHERE w.dedupe_key = t.dedupe_key || '|w')`, [podz]);
  for(const r of rows) db.run(`UPDATE transactions SET category_id=? WHERE id=?`, [cash.id, r.id]);
  return rows.length;
}
// Bulk delete by an arbitrary WHERE (built by the UI from the active filters).
export function countWhere(whereSql, params){ return db.get(`SELECT COUNT(*) AS c FROM transactions ${whereSql}`, params).c; }
export function deleteWhere(whereSql, params){
  // collect Novčanik mirror keys of the rows about to be deleted, then cascade
  const mirrorKeys = db.all(`SELECT dedupe_key FROM transactions ${whereSql}`, params)
    .map(r=>r.dedupe_key).filter(Boolean).map(k=>k+'|w');
  db.run(`DELETE FROM transactions ${whereSql}`, params);
  if(mirrorKeys.length){
    db.run(`DELETE FROM transactions WHERE dedupe_key IN (${mirrorKeys.map(()=>'?').join(',')})`, mirrorKeys);
  }
}
// Import batches: list and delete a whole import.
export const getImportBatches = () => db.all(`
  SELECT import_batch AS batch, COUNT(*) AS n, MIN(date) AS mn, MAX(date) AS mx
  FROM transactions WHERE import_batch IS NOT NULL GROUP BY import_batch ORDER BY mx DESC, batch DESC`);
export function deleteByBatch(batch){ db.run(`DELETE FROM transactions WHERE import_batch=?`, [batch]); }
export function setCategory(txId, catId){
  db.run(`UPDATE transactions SET category_id=? WHERE id=?`, [catId, txId]);
  syncMirror(txId);           // moving a cash withdrawal away drops its wallet mirror (no double count)
  learnFromTx(txId, catId);   // every manual correction teaches the model
}

export function addAccount({name,type,bank,currency,opening_balance,color}){
  db.run(`INSERT INTO accounts(name,type,bank,currency,opening_balance,opening_date,color) VALUES(?,?,?,?,?,?,?)`,
    [name, type||'bank', bank||null, currency||'RSD', opening_balance||0,
     opening_balance?new Date().toISOString().slice(0,10):null, color||'#3b82f6']);
  return db.lastId();
}
export function updateAccount(id, fields){
  const allowed = ['name','type','currency','color','opening_balance'];
  const keys = Object.keys(fields).filter(k=>allowed.includes(k));
  if(!keys.length) return;
  db.run(`UPDATE accounts SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`, [...keys.map(k=>fields[k]), id]);
}
export const accountTxCount = (id) => db.get(`SELECT COUNT(*) AS c FROM transactions WHERE account_id=?`, [id]).c;
// Delete an account and all of its transactions.
export function deleteAccount(id){
  deleteWhere('WHERE account_id=?', [id]);   // cascades to Novčanik mirror rows
  db.run(`DELETE FROM accounts WHERE id=?`, [id]);
}

export function addRule(match, category_id, priority=3){
  db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [match.toUpperCase(), category_id, priority]);
}
export function deleteRule(id){ db.run(`DELETE FROM rules WHERE id=?`, [id]); }

// Re-run categorization for all uncategorized / or all transactions.
export function recategorizeAll(onlyDefault=true){
  const rules = getRules();
  const ctx = buildCtx();   // learned memory + ML model
  const m = catMap();
  const defExp = m['Ostalo / Nekategorisano'], defInc = m['Ostali prilivi'];
  const rows = db.all(`SELECT * FROM transactions`);
  let changed=0;
  for(const t of rows){
    if(onlyDefault && t.category_id !== defExp && t.category_id !== defInc) continue;
    const cat = categorize(t, rules, t.amount>=0, ctx);
    if(cat && cat !== t.category_id){ db.run(`UPDATE transactions SET category_id=? WHERE id=?`,[cat,t.id]); changed++; }
  }
  return changed;
}

// One-time (migration v11): debit "Transfer drugima" rows paid to a company are
// re-run through the categorizer (learned memory first, so the user's own explicit
// choices are kept). Returns how many changed.
export function fixCompanyTransfers(){
  const m = catMap(); const tr = m['Transfer drugima']; if(!tr) return 0;
  const rules = getRules(); const ctx = buildCtx();
  const def = m['Ostalo / Nekategorisano'];
  let n = 0;
  for(const t of db.all(`SELECT * FROM transactions WHERE category_id=? AND amount<0`, [tr])){
    if(!isCompany(t.counterparty || t.merchant)) continue;
    const c = categorize(t, rules, false, ctx) ?? def;
    if(c != null && c !== tr){ db.run(`UPDATE transactions SET category_id=? WHERE id=?`, [c, t.id]); n++; }
  }
  return n;
}
