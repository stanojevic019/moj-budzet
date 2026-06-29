// Encrypted SQLite storage (sql.js in-memory DB, persisted as one encrypted blob
// in IndexedDB). The whole DB is decrypted into memory on unlock and re-encrypted
// on every save. Fine for personal-scale data (thousands of rows).

import { deriveKey, randomBytes, encryptBytes, decryptBytes, makeVerifier, checkVerifier, DEFAULT_ITERATIONS } from './crypto.js';
import { SEED_CATEGORIES, SEED_RULES } from './categorize.js';

const IDB_NAME = 'my-budget';
const STORE = 'vault';
const SCHEMA_VERSION = 8;
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

export async function save(){
  if(!db || !cryptoKey) return;
  const bytes = db.export();
  await idbSet('db', await encryptBytes(cryptoKey, bytes));
}

export async function changePassphrase(newPass){
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
