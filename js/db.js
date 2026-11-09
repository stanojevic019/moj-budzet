// Encrypted SQLite storage (sql.js in-memory DB, persisted as one encrypted blob
// in IndexedDB). The whole DB is decrypted into memory on unlock and re-encrypted
// on every save. Fine for personal-scale data (thousands of rows).

import { deriveKey, randomBytes, encryptBytes, decryptBytes, makeVerifier, checkVerifier, DEFAULT_ITERATIONS } from './crypto.js';
import { SEED_CATEGORIES, SEED_RULES } from './categorize.js';

const IDB_NAME = 'my-budget';
const STORE = 'vault';
const SCHEMA_VERSION = 13;
const LEGACY_ITERATIONS = 310000; // vaults created before KDF params were stored

let SQL = null;     // sql.js module
let db = null;      // current Database
let cryptoKey = null;

// ---------- tiny IndexedDB key/value ----------
let _conn = null;
function idb(){
  if(_conn) return Promise.resolve(_conn);
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => { _conn = r.result; res(_conn); };
    r.onerror = () => rej(r.error);
  });
}

// Permanently delete the whole vault (all data) from this device.
export async function wipeVault(){
  db = null; cryptoKey = null;
  if(_conn){ try { _conn.close(); } catch {} _conn = null; }
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase(IDB_NAME);
    r.onsuccess = () => res(); r.onerror = () => res(); r.onblocked = () => res();
  });
}
async function idbGet(key){
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error);
  });
}
async function idbSet(key, val){
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key);
    tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error);
  });
}
// Atomic multi-key write: all puts share one transaction (all-or-nothing).
async function idbSetMany(pairs){
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for(const [k,v] of pairs) store.put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export async function vaultExists(){
  return !!(await idbGet('verifier'));
}

async function ensureSql(){
  if(SQL) return;
  SQL = await window.initSqlJs({ locateFile: f => 'vendor/' + f });
}

// First-time setup: create vault with a passphrase (atomic write).
export async function createVault(passphrase){
  await ensureSql();
  const salt = randomBytes(16);
  const iterations = DEFAULT_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);
  db = new SQL.Database();
  createSchema();
  seed();
  const blob = await encryptBytes(key, db.export());
  const verifier = await makeVerifier(key);
  await idbSetMany([['salt', salt], ['kdf', { iterations }], ['verifier', verifier], ['db', blob]]);
  cryptoKey = key;
}

// Unlock existing vault. Returns true on success, false on wrong passphrase.
export async function unlock(passphrase){
  await ensureSql();
  const salt = await idbGet('salt');
  const verifier = await idbGet('verifier');
  if(!salt || !verifier) return false;
  const kdf = await idbGet('kdf');
  const iterations = (kdf && kdf.iterations) || LEGACY_ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);
  if(!await checkVerifier(key, verifier)) return false;
  cryptoKey = key;
  const blob = await idbGet('db');
  db = blob ? new SQL.Database(await decryptBytes(cryptoKey, blob)) : new SQL.Database();
  if(!blob){ createSchema(); seed(); }
  // migration + persistence are best-effort: a disk-write failure must NOT lock the
  // user out of a vault that already decrypted correctly.
  try { migrate(); await save(); } catch {}
  // transparently upgrade a legacy KDF (e.g. 310k → 600k) on unlock, best-effort,
  // so the stored work factor matches what the UI advertises.
  if(iterations < DEFAULT_ITERATIONS){ try { await changePassphrase(passphrase); } catch {} }
  return true;
}

export function lock(){ db = null; cryptoKey = null; }
export function isOpen(){ return !!db; }

// Saves are serialized: each one snapshots the DB only when its turn comes, so an
// older snapshot can never finish after (and overwrite) a newer one.
let saveChain = Promise.resolve();
async function doSave(){
  if(!db || !cryptoKey) return;
  const key = cryptoKey, bytes = db.export();
  await idbSet('db', await encryptBytes(key, bytes));
}
export function save(){
  const p = saveChain.then(doSave);
  saveChain = p.catch(()=>{});   // keep the queue alive after a failure
  return p;                      // …but report it to the caller
}
// Wait for pending saves (call before lock/reload so the last change isn't lost).
export function flush(){ return saveChain; }

// Ask the browser not to evict our storage under pressure / inactivity (best-effort).
export async function requestPersistence(){
  try {
    if(navigator.storage && navigator.storage.persist){
      if(await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {}
  return false;
}

// Check a passphrase against the stored verifier without changing any state.
export async function verifyPassphrase(passphrase){
  const salt = await idbGet('salt'), verifier = await idbGet('verifier');
  if(!salt || !verifier) return false;
  const kdf = await idbGet('kdf');
  const key = await deriveKey(passphrase, salt, (kdf && kdf.iterations) || LEGACY_ITERATIONS);
  return checkVerifier(key, verifier);
}

// ---------- encrypted backup file ----------
// The backup is the vault exactly as stored (already encrypted with the user's
// passphrase) — nothing is ever written in plaintext. Restoring it needs the
// passphrase that was active when the backup was made.
const b64 = (u8) => { let s=''; for(let i=0;i<u8.length;i+=0x8000) s+=String.fromCharCode.apply(null, u8.subarray(i,i+0x8000)); return btoa(s); };
const unb64 = (str) => { const s=atob(str); const u=new Uint8Array(s.length); for(let i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u; };
export async function exportBackup(){
  await save();                                  // include the latest in-memory state
  const [salt, kdf, verifier, blob] = await Promise.all(['salt','kdf','verifier','db'].map(idbGet));
  if(!salt || !verifier || !blob) throw new Error('empty');
  return JSON.stringify({ app:'moj-budzet', format:1, created:new Date().toISOString(),
    kdf: kdf || { iterations: LEGACY_ITERATIONS }, salt:b64(salt), verifier:b64(verifier), db:b64(blob) });
}
// Replaces the vault on this device with the backup (caller confirms first).
export async function importBackup(text){
  let o; try { o = JSON.parse(text); } catch { throw new Error('format'); }
  if(!o || o.app!=='moj-budzet' || o.format!==1 || !o.salt || !o.verifier || !o.db) throw new Error('format');
  let salt, verifier, blob;
  try { salt = unb64(o.salt); verifier = unb64(o.verifier); blob = unb64(o.db); } catch { throw new Error('format'); }
  const kdf = { iterations: +(o.kdf && o.kdf.iterations) || LEGACY_ITERATIONS };
  db = null; cryptoKey = null;
  await idbSetMany([['salt', salt], ['kdf', kdf], ['verifier', verifier], ['db', blob]]);
}

// Runs inside the save queue: a save still in flight under the OLD key could
// otherwise land after the new verifier and leave the vault undecryptable.
export function changePassphrase(newPass){
  const p = saveChain.then(() => rekey(newPass));
  saveChain = p.catch(()=>{});
  return p;
}
async function rekey(newPass){
  if(!db) return;
  const salt = randomBytes(16);
  const iterations = DEFAULT_ITERATIONS;
  const key = await deriveKey(newPass, salt, iterations);
  // Re-encrypt the DB under the new key and write salt+kdf+verifier+db atomically,
  // so a mid-write failure can never leave them keyed differently.
  const blob = await encryptBytes(key, db.export());
  const verifier = await makeVerifier(key);
  await idbSetMany([['salt', salt], ['kdf', { iterations }], ['verifier', verifier], ['db', blob]]);
  cryptoKey = key;
}

// ---------- schema ----------
function createSchema(){
  db.run(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE accounts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
      bank TEXT, account_number TEXT, currency TEXT NOT NULL DEFAULT 'RSD',
      opening_balance REAL DEFAULT 0, opening_date TEXT, color TEXT DEFAULT '#3b82f6',
      archived INTEGER DEFAULT 0);
    CREATE TABLE categories(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, color TEXT, icon TEXT, grp TEXT, parent_id INTEGER, archived INTEGER DEFAULT 0);
    CREATE TABLE budgets(
      id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER UNIQUE,
      amount REAL NOT NULL, period TEXT DEFAULT 'monthly');
    CREATE TABLE learned(key TEXT PRIMARY KEY, category_id INTEGER, n INTEGER DEFAULT 1);
    CREATE TABLE rules(
      id INTEGER PRIMARY KEY AUTOINCREMENT, match TEXT NOT NULL,
      category_id INTEGER NOT NULL, priority INTEGER DEFAULT 5);
    CREATE TABLE transactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'RSD',
      description TEXT, counterparty TEXT, merchant TEXT, category_id INTEGER,
      ref TEXT, fee REAL DEFAULT 0, fx TEXT, balance REAL,
      source TEXT DEFAULT 'manual', note TEXT, dedupe_key TEXT, import_batch TEXT, created_at TEXT);
    CREATE UNIQUE INDEX idx_tx_dedupe ON transactions(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX idx_tx_date ON transactions(date);
    CREATE INDEX idx_tx_acct ON transactions(account_id);
  `);
  db.run(`INSERT INTO meta(key,value) VALUES('schema_version', ?)`, [String(SCHEMA_VERSION)]);
}

function seed(){
  const catId = {};
  // pass 1: top-level groups (no parent) so their ids exist for subcategories
  for(const [name, kind, color, icon, grp, parent] of SEED_CATEGORIES){
    if(parent) continue;
    db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES(?,?,?,?,?,NULL)`, [name,kind,color,icon,grp||null]);
    catId[name] = lastId();
  }
  // pass 2: subcategories
  for(const [name, kind, color, icon, grp, parent] of SEED_CATEGORIES){
    if(!parent) continue;
    db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES(?,?,?,?,?,?)`, [name,kind,color,icon,grp||null, catId[parent]||null]);
    catId[name] = lastId();
  }
  for(const [match, catName, priority] of SEED_RULES){
    if(catId[catName] == null) continue;
    db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [match, catId[catName], priority]);
  }
  // default cash account ("slamarica")
  db.run(`INSERT INTO accounts(name,type,currency,color) VALUES(?,?,?,?)`,
    ['Keš (slamarica)','cash','RSD','#64748b']);
}

function migrate(){
  const row = get(`SELECT value FROM meta WHERE key='schema_version'`);
  let v = row ? +row.value : 1;
  if(v < 2){
    try { db.run(`ALTER TABLE categories ADD COLUMN grp TEXT`); } catch {}
    try { db.run(`ALTER TABLE categories ADD COLUMN archived INTEGER DEFAULT 0`); } catch {}
    db.run(`CREATE TABLE IF NOT EXISTS budgets(id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER UNIQUE, amount REAL NOT NULL, period TEXT DEFAULT 'monthly')`);
    // backfill default groups by category name
    for(const [name,,,, grp] of SEED_CATEGORIES){
      if(grp) db.run(`UPDATE categories SET grp=? WHERE name=? AND (grp IS NULL OR grp='')`, [grp, name]);
    }
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','2') ON CONFLICT(key) DO UPDATE SET value='2'`);
    v = 2;
  }
  if(v < 3){
    try { db.run(`ALTER TABLE transactions ADD COLUMN import_batch TEXT`); } catch {}
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','3') ON CONFLICT(key) DO UPDATE SET value='3'`);
    v = 3;
  }
  if(v < 4){
    // add any newly-introduced seed categories the vault doesn't have yet (by name).
    // one-time, so categories the user deleted are not resurrected.
    for(const [name, kind, color, icon, grp] of SEED_CATEGORIES){
      if(!get(`SELECT id FROM categories WHERE name=?`, [name]))
        db.run(`INSERT INTO categories(name,kind,color,icon,grp) VALUES(?,?,?,?,?)`, [name,kind,color,icon,grp||null]);
    }
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','4') ON CONFLICT(key) DO UPDATE SET value='4'`);
    v = 4;
  }
  if(v < 5){
    // backfill UniCredit-friendly rules (new match-texts; safe — never existed before)
    const add = [['ODRZAVANJE RACUNA','Bankarske naknade',1],['MOBILNO BANKARSTVO','Bankarske naknade',1],
      ['INFOSTAN','Računi i režije',2],['EPS AD','Računi i režije',2],['ALIEXPRESS','Šoping',2],
      ['TEMU','Šoping',2],['UNICEF','Pokloni i donacije',2],['PL:ACC','Interni prenos',2]];
    for(const [mt, cat, pr] of add){
      if(get(`SELECT id FROM rules WHERE match=?`, [mt])) continue;
      const c = get(`SELECT id FROM categories WHERE name=?`, [cat]); if(!c) continue;
      db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [mt, c.id, pr]);
    }
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','5') ON CONFLICT(key) DO UPDATE SET value='5'`);
    v = 5;
  }
  if(v < 6){
    db.run(`CREATE TABLE IF NOT EXISTS learned(key TEXT PRIMARY KEY, category_id INTEGER, n INTEGER DEFAULT 1)`);
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','6') ON CONFLICT(key) DO UPDATE SET value='6'`);
    v = 6;
  }
  if(v < 7){
    // curate categories: merge redundant ones (reassigning tx/budgets/rules/learned),
    // rename for clarity, drop a niche empty one. Data-safe — nothing is lost.
    const idOf = (name) => { const r = get(`SELECT id FROM categories WHERE name=?`, [name]); return r ? r.id : null; };
    const mergeCat = (srcName, dstName) => {
      const src = idOf(srcName), dst = idOf(dstName);
      if(src==null || dst==null || src===dst) return;
      db.run(`UPDATE transactions SET category_id=? WHERE category_id=?`, [dst, src]);
      db.run(`UPDATE learned SET category_id=? WHERE category_id=?`, [dst, src]);
      db.run(`UPDATE rules SET category_id=? WHERE category_id=?`, [dst, src]);
      const hasSrcB = get(`SELECT id FROM budgets WHERE category_id=?`, [src]);
      const hasDstB = get(`SELECT id FROM budgets WHERE category_id=?`, [dst]);
      if(hasSrcB && !hasDstB) db.run(`UPDATE budgets SET category_id=? WHERE category_id=?`, [dst, src]);
      else if(hasSrcB) db.run(`DELETE FROM budgets WHERE category_id=?`, [src]);
      db.run(`DELETE FROM categories WHERE id=?`, [src]);
    };
    const rename = (oldN, newN, icon) => {
      const id = idOf(oldN); if(id==null) return;
      if(idOf(newN)){ mergeCat(oldN, newN); return; }      // target already exists → merge
      db.run(`UPDATE categories SET name=?, icon=? WHERE id=?`, [newN, icon, id]);
    };
    mergeCat('Putarina i parking', 'Gorivo');
    mergeCat('Prevoz (taksi/gradski)', 'Gorivo');
    mergeCat('Lepota i nega', 'Drogerija i kozmetika');
    mergeCat('Osiguranje', 'Porezi i takse');
    rename('Gorivo', 'Automobil i prevoz', '🚗');
    rename('Drogerija i kozmetika', 'Lična nega', '🧴');
    rename('Porezi i takse', 'Obaveze (porezi/osiguranje)', '🏛️');
    rename('Kuća i domaćinstvo', 'Dom i domaćinstvo', '🏠');
    // drop niche category only if unused
    const pets = idOf('Kućni ljubimci');
    if(pets!=null && get(`SELECT COUNT(*) AS c FROM transactions WHERE category_id=?`, [pets]).c===0
       && !get(`SELECT id FROM budgets WHERE category_id=?`, [pets])){
      db.run(`DELETE FROM rules WHERE category_id=?`, [pets]);
      db.run(`DELETE FROM learned WHERE category_id=?`, [pets]);
      db.run(`DELETE FROM categories WHERE id=?`, [pets]);
    }
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','7') ON CONFLICT(key) DO UPDATE SET value='7'`);
    v = 7;
  }
  if(v < 8){
    // introduce two-level categories: create groups, nest existing categories under
    // them (parent_id), add a few new subcategories. Data-safe (no tx touched).
    try { db.run(`ALTER TABLE categories ADD COLUMN parent_id INTEGER`); } catch {}
    const idOf = (name) => { const r = get(`SELECT id FROM categories WHERE name=?`, [name]); return r ? r.id : null; };
    const ensureCat = (name, kind, color, icon, grp, parentId) => {
      let id = idOf(name);
      if(id == null){ db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES(?,?,?,?,?,?)`, [name,kind,color,icon,grp||null,parentId||null]); id = lastId(); }
      return id;
    };
    const groups = {};
    for(const [n,k,c,i] of [['Hrana','expense','#22c55e','🍽️'],['Vozilo i prevoz','expense','#eab308','🚗'],
      ['Stanovanje','expense','#14b8a6','🏠'],['Zdravlje i nega','expense','#ef4444','💊'],['Kupovina','expense','#f43f5e','🛍️'],
      ['Slobodno vreme','expense','#a21caf','🎬'],['Porodica','expense','#fb7185','👨‍👩‍👧'],['Obaveze i finansije','expense','#94a3b8','🏦'],
      ['Gotovina i transferi','transfer','#64748b','🔁'],['Prihodi','income','#16a34a','💼'],['Ostalo','expense','#6b7280','❓']])
      groups[n] = ensureCat(n,k,c,i,null,null);
    const map = {
      'Namirnice':'Hrana','Restorani i kafići':'Hrana','Automobil i prevoz':'Vozilo i prevoz',
      'Računi i režije':'Stanovanje','Telefon i internet':'Stanovanje','Dom i domaćinstvo':'Stanovanje',
      'Zdravlje i apoteka':'Zdravlje i nega','Lična nega':'Zdravlje i nega','Sport i rekreacija':'Zdravlje i nega',
      'Šoping':'Kupovina','Odeća i obuća':'Kupovina','Pretplate i digitalne usluge':'Slobodno vreme',
      'Zabava':'Slobodno vreme','Putovanja':'Slobodno vreme','Deca':'Porodica','Obrazovanje':'Porodica',
      'Pokloni i donacije':'Porodica','Obaveze (porezi/osiguranje)':'Obaveze i finansije','Bankarske naknade':'Obaveze i finansije',
      'Kredit – kamata':'Obaveze i finansije','Kredit – glavnica':'Obaveze i finansije','Podizanje keša':'Gotovina i transferi',
      'Transfer drugima':'Gotovina i transferi','Interni prenos':'Gotovina i transferi','Menjačnica (devize)':'Gotovina i transferi',
      'Štednja i ulaganja':'Gotovina i transferi','Ostalo / Nekategorisano':'Ostalo','Zarada':'Prihodi','Ostali prilivi':'Prihodi',
    };
    for(const [cat, grp] of Object.entries(map)){
      const cid = idOf(cat), gid = groups[grp];
      if(cid!=null && gid!=null && cid!==gid) db.run(`UPDATE categories SET parent_id=? WHERE id=?`, [gid, cid]);
    }
    ensureCat('Dostava hrane','expense','#fb923c','🛵','wants',groups['Hrana']);
    ensureCat('Gorivo','expense','#eab308','⛽','needs',groups['Vozilo i prevoz']);
    ensureCat('Servis i delovi','expense','#ca8a04','🔧','needs',groups['Vozilo i prevoz']);
    ensureCat('Registracija','expense','#a16207','📋','needs',groups['Vozilo i prevoz']);
    ensureCat('Putarina i parking','expense','#a3a3a3','🅿️','needs',groups['Vozilo i prevoz']);
    ensureCat('Taksi i gradski prevoz','expense','#0ea5e9','🚕','needs',groups['Vozilo i prevoz']);
    ensureCat('Kirija','expense','#0e7490','🔑','needs',groups['Stanovanje']);
    ensureCat('Tehnika','expense','#7c3aed','💻','wants',groups['Kupovina']);
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','8') ON CONFLICT(key) DO UPDATE SET value='8'`);
    v = 8;
  }
  if(v < 9){
    // rules derived from the user's statements (new match-texts → safe to backfill)
    const addRules = [
      ['CATERING','Restorani i kafići',3],['RESTORAN','Restorani i kafići',3],
      ['TYRES','Servis i delovi',3],['GUME','Servis i delovi',2],
      ['VULKANIZER','Servis i delovi',2],['POLOVNI AUTOMOBILI','Servis i delovi',2],
      ['AUTO DELOVI','Servis i delovi',2],['AUTODELOVI','Servis i delovi',2],
      ['MOZZART','Zabava',2],['BIOSKOP','Zabava',2],['CINEPLEXX','Zabava',2],['POZORI','Zabava',2],['SEPHORA','Lična nega',2],['NOTINO','Lična nega',2],
      ['FRIZER','Lična nega',2],['JAVNO KOMUNALNO','Računi i režije',2],['JKP','Računi i režije',3],
      ['NAPLATNA RAMP','Putarina i parking',2]];
    for(const [mt, cat, pr] of addRules){
      if(get(`SELECT id FROM rules WHERE match=?`, [mt])) continue;
      const c = get(`SELECT id FROM categories WHERE name=?`, [cat]); if(!c) continue;
      db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [mt, c.id, pr]);
    }
    // remove unused subcategories (only if empty — no tx, no budget)
    for(const name of ['Dostava hrane','Registracija','Taksi i gradski prevoz','Kirija','Dom i domaćinstvo',
      'Sport i rekreacija','Putovanja','Obrazovanje','Deca','Obaveze (porezi/osiguranje)','Štednja i ulaganja']){
      const r = get(`SELECT id FROM categories WHERE name=?`, [name]); if(!r) continue;
      if(get(`SELECT COUNT(*) AS c FROM transactions WHERE category_id=?`, [r.id]).c > 0) continue;
      if(get(`SELECT id FROM budgets WHERE category_id=?`, [r.id])) continue;
      db.run(`DELETE FROM rules WHERE category_id=?`, [r.id]);
      db.run(`DELETE FROM learned WHERE category_id=?`, [r.id]);
      db.run(`DELETE FROM categories WHERE id=?`, [r.id]);
    }
    setSetting('recat_pending','1');   // app re-runs categorization on uncategorized once
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','9') ON CONFLICT(key) DO UPDATE SET value='9'`);
    v = 9;
  }
  if(v < 10){
    // Wallet ("Novčanik") cash tracking: mirror future ATM withdrawals into a cash
    // account. Enabled for the existing vault (the user opted in); new vaults stay off.
    setSetting('mirror_atm','1');
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','10') ON CONFLICT(key) DO UPDATE SET value='10'`);
    v = 10;
  }
  if(v < 11){
    // bank transfers to companies were filed as "Transfer drugima" (excluded from
    // spending). The app re-runs them through the categorizer once after unlock.
    setSetting('fix_company_transfers','1');
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','11') ON CONFLICT(key) DO UPDATE SET value='11'`);
    v = 11;
  }
  if(v < 12){
    // new categories: pass-through money (neutral), shared costs (net of what the
    // other person pays back), and vehicle purchase (a one-off, not "shopping")
    const idOf = (name) => { const r = get(`SELECT id FROM categories WHERE name=?`, [name]); return r ? r.id : null; };
    for(const [name, kind, color, icon, grp, parent] of SEED_CATEGORIES){
      if(!['Prolazni novac','Zajednički troškovi','Kupovina vozila'].includes(name) || idOf(name)!=null) continue;
      db.run(`INSERT INTO categories(name,kind,color,icon,grp,parent_id) VALUES(?,?,?,?,?,?)`, [name,kind,color,icon,grp||null, idOf(parent)]);
    }
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','12') ON CONFLICT(key) DO UPDATE SET value='12'`);
    v = 12;
  }
  if(v < 13){
    // learned "person → pass-through / currency exchange" memories get bound to the
    // amounts seen (done once in the app after unlock); untracked-cash category
    // goes under the "Ostalo" group like the other leftovers
    setSetting('bind_learned','1');
    const grp = get(`SELECT id FROM categories WHERE name='Ostalo' AND parent_id IS NULL`);
    if(grp) db.run(`UPDATE categories SET parent_id=? WHERE name='Gotovina (keš)' AND parent_id IS NULL`, [grp.id]);
    db.run(`INSERT INTO meta(key,value) VALUES('schema_version','13') ON CONFLICT(key) DO UPDATE SET value='13'`);
    v = 13;
  }
}

// ---------- settings (meta key/value) ----------
export function getSetting(key, def=null){
  const r = get(`SELECT value FROM meta WHERE key=?`, [key]);
  return r ? r.value : def;
}
export function setSetting(key, value){
  db.run(`INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?`,
    [key, String(value), String(value)]);
}

// ---------- query helpers ----------
export function all(sql, params=[]){
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = []; while(stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
export function get(sql, params=[]){ const r = all(sql, params); return r[0] || null; }
export function run(sql, params=[]){ db.run(sql, params); }
export function lastId(){ return db.exec(`SELECT last_insert_rowid() AS id`)[0].values[0][0]; }
export function exportBytes(){ return db.export(); }
// Undo support: an in-memory copy of the whole DB taken right before a destructive
// action; restoring it swaps the live DB back (caller then saves). Never persisted.
export function snapshot(){ return db ? db.export() : null; }
export function restoreSnapshot(bytes){
  if(!bytes || !SQL || !cryptoKey) return false;
  const old = db; db = new SQL.Database(bytes);
  try { old && old.close(); } catch {}
  return true;
}
