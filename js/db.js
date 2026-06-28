// Encrypted SQLite storage (sql.js in-memory DB, persisted as one encrypted blob
// in IndexedDB). The whole DB is decrypted into memory on unlock and re-encrypted
// on every save. Fine for personal-scale data (thousands of rows).

import { deriveKey, randomBytes, encryptBytes, decryptBytes, makeVerifier, checkVerifier } from './crypto.js';
import { SEED_CATEGORIES, SEED_RULES } from './categorize.js';

const IDB_NAME = 'my-budget';
const STORE = 'vault';
const SCHEMA_VERSION = 1;

let SQL = null;     // sql.js module
let db = null;      // current Database
let cryptoKey = null;

// ---------- tiny IndexedDB key/value ----------
function idb(){
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
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

export async function vaultExists(){
  return !!(await idbGet('verifier'));
}

async function ensureSql(){
  if(SQL) return;
  SQL = await window.initSqlJs({ locateFile: f => 'vendor/' + f });
}

// First-time setup: create vault with a passphrase.
export async function createVault(passphrase){
  await ensureSql();
  const salt = randomBytes(16);
  cryptoKey = await deriveKey(passphrase, salt);
  await idbSet('salt', salt);
  await idbSet('verifier', await makeVerifier(cryptoKey));
  db = new SQL.Database();
  createSchema();
  seed();
  await save();
}

// Unlock existing vault. Returns true on success, false on wrong passphrase.
export async function unlock(passphrase){
  await ensureSql();
  const salt = await idbGet('salt');
  const verifier = await idbGet('verifier');
  if(!salt || !verifier) return false;
  const key = await deriveKey(passphrase, salt);
  if(!await checkVerifier(key, verifier)) return false;
  cryptoKey = key;
  const blob = await idbGet('db');
  db = blob ? new SQL.Database(await decryptBytes(cryptoKey, blob)) : new SQL.Database();
  if(!blob){ createSchema(); seed(); await save(); }
  migrate();
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
  const salt = randomBytes(16);
  cryptoKey = await deriveKey(newPass, salt);
  await idbSet('salt', salt);
  await idbSet('verifier', await makeVerifier(cryptoKey));
  await save();
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
      kind TEXT NOT NULL, color TEXT, icon TEXT);
    CREATE TABLE rules(
      id INTEGER PRIMARY KEY AUTOINCREMENT, match TEXT NOT NULL,
      category_id INTEGER NOT NULL, priority INTEGER DEFAULT 5);
    CREATE TABLE transactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
      date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'RSD',
      description TEXT, counterparty TEXT, merchant TEXT, category_id INTEGER,
      ref TEXT, fee REAL DEFAULT 0, fx TEXT, balance REAL,
      source TEXT DEFAULT 'manual', note TEXT, dedupe_key TEXT, created_at TEXT);
    CREATE UNIQUE INDEX idx_tx_dedupe ON transactions(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX idx_tx_date ON transactions(date);
    CREATE INDEX idx_tx_acct ON transactions(account_id);
  `);
  db.run(`INSERT INTO meta(key,value) VALUES('schema_version', ?)`, [String(SCHEMA_VERSION)]);
}

function seed(){
  const catId = {};
  for(const [name, kind, color, icon] of SEED_CATEGORIES){
    db.run(`INSERT INTO categories(name,kind,color,icon) VALUES(?,?,?,?)`, [name,kind,color,icon]);
    catId[name] = db.exec(`SELECT last_insert_rowid() AS id`)[0].values[0][0];
  }
  for(const [match, catName, priority] of SEED_RULES){
    if(catId[catName] == null) continue;
    db.run(`INSERT INTO rules(match,category_id,priority) VALUES(?,?,?)`, [match, catId[catName], priority]);
  }
  // default cash account ("slamarica")
  db.run(`INSERT INTO accounts(name,type,currency,color) VALUES(?,?,?,?)`,
    ['Keš (slamarica)','cash','RSD','#64748b']);
}

function migrate(){ /* future schema upgrades keyed on meta.schema_version */ }

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
