// Merchant cleanup + auto-categorization.
// Categories and rules are seeded once into the DB and are fully editable by the user.

// Card terminal id (e.g. "EX9281VGC0129845389") and trailing ISO country numeric code.
const CARD_ID = /\bEX[A-Z0-9]{6,}\b/g;

// Seed categories referenced BY NAME elsewhere (fallbacks + analytics exclude sets).
// These must not be renamed or deleted or the name-keyed logic breaks.
export const PROTECTED_CATEGORY_NAMES = new Set([
  'Ostalo / Nekategorisano','Ostali prilivi','Podizanje keša','Interni prenos',
  'Transfer drugima','Menjačnica (devize)','Kredit – glavnica',
]);

// Sanitize a user-entered category icon: short, no HTML-significant chars.
export function sanitizeIcon(s){
  return String(s||'').replace(/[<>&"'`]/g,'').trim().slice(0,4) || '🏷️';
}

export function cleanMerchant(counterparty, description){
  let s = (counterparty || '').replace(CARD_ID, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // strip a trailing 3-digit ISO country code (688=RS, 840=US, 528=NL, 440=LT, ...)
  s = s.replace(/\s+\d{3}$/, '').trim();
  if(!s) s = (description || '').replace(CARD_ID, ' ').replace(/\s+/g,' ').trim();
  return s;
}

// kind: 'expense' | 'income' | 'transfer'; grp: 'needs' | 'wants' | null (for 50/30/20)
export const SEED_CATEGORIES = [
  ['Namirnice','expense','#22c55e','🛒','needs'],
  ['Restorani i kafići','expense','#f97316','🍽️','wants'],
  ['Gorivo','expense','#eab308','⛽','needs'],
  ['Putarina i parking','expense','#a3a3a3','🅿️','needs'],
  ['Zdravlje i apoteka','expense','#ef4444','💊','needs'],
  ['Drogerija i kozmetika','expense','#ec4899','🧴','needs'],
  ['Pretplate i digitalne usluge','expense','#8b5cf6','📺','wants'],
  ['Telefon i internet','expense','#0ea5e9','📱','needs'],
  ['Računi i režije','expense','#14b8a6','🧾','needs'],
  ['Šoping','expense','#f43f5e','🛍️','wants'],
  ['Putovanja','expense','#06b6d4','✈️','wants'],
  ['Podizanje keša','expense','#64748b','🏧',null],
  ['Bankarske naknade','expense','#94a3b8','🏦','needs'],
  ['Kredit – kamata','expense','#b91c1c','💳','needs'],
  ['Kredit – glavnica','expense','#7f1d1d','💳','needs'],
  ['Transfer drugima','transfer','#f59e0b','↗️',null],
  ['Interni prenos','transfer','#3b82f6','🔁',null],
  ['Ostalo / Nekategorisano','expense','#6b7280','❓',null],
  ['Zarada','income','#16a34a','💼',null],
  ['Ostali prilivi','income','#10b981','⬇️',null],
  ['Menjačnica (devize)','transfer','#0d9488','💱',null],
];

// Rules: [matchText(UPPERCASE substring), categoryName, priority]. Lower priority wins.
// Priority 1 = definitive transaction-TYPE descriptions (transfer/ATM/loan/fee/salary);
// these must outrank merchant-name guesses (2-3) so e.g. a "Bezgotovinski prenos" to a
// company whose name contains a store keyword is classed as a transfer, not shopping.
export const SEED_RULES = [
  // transaction-type descriptions — highest priority
  ['BEZGOTOVINSKI PRENOS','Transfer drugima',1],
  ['TRANSAKCIJE PO NALOGU','Transfer drugima',1],
  ['GOTOVINSKA ISPLATA','Podizanje keša',1],
  ['NAPLATA REDOVNE KAMATE','Kredit – kamata',1],
  ['KAMAT','Kredit – kamata',2],
  ['NAPLATA GLAVNICE','Kredit – glavnica',1],
  ['GLAVNIC','Kredit – glavnica',2],
  ['ISPLATA GOTOVINE NA ATM','Podizanje keša',1],
  ['ATM ','Podizanje keša',3],
  ['NAKNADA ZA ISPLATU','Bankarske naknade',1],
  ['NAKNADA ZA MESEČNO','Bankarske naknade',1],
  ['ODRŽAVANJE RAČUNA','Bankarske naknade',2],
  ['NAKNADA','Bankarske naknade',4],
  ['ZARADA','Zarada',1],
  ['MAINSTREAM','Zarada',1],
  ['PLATA','Zarada',2],
  ['PRODAJA','Menjačnica (devize)',1],
  // subscriptions / digital
  ['NETFLIX','Pretplate i digitalne usluge',2],
  ['GOOGLE','Pretplate i digitalne usluge',2],
  ['SPOTIFY','Pretplate i digitalne usluge',2],
  ['YOUTUBE','Pretplate i digitalne usluge',2],
  ['APPLE.COM','Pretplate i digitalne usluge',2],
  ['ICLOUD','Pretplate i digitalne usluge',2],
  ['MICROSOFT','Pretplate i digitalne usluge',2],
  ['ADOBE','Pretplate i digitalne usluge',2],
  ['OPENAI','Pretplate i digitalne usluge',2],
  ['CHATGPT','Pretplate i digitalne usluge',2],
  ['PICTORY','Pretplate i digitalne usluge',2],
  ['CANVA','Pretplate i digitalne usluge',2],
  ['HBO','Pretplate i digitalne usluge',2],
  ['CARVERTICAL','Pretplate i digitalne usluge',2],
  // telecom / top-up
  ['PRIPAID DOPUN','Telefon i internet',1],
  ['DOPUNA','Telefon i internet',2],
  ['MTS','Telefon i internet',2],
  ['YETTEL','Telefon i internet',2],
  ['TELENOR','Telefon i internet',2],
  ['SBB','Telefon i internet',2],
  ['A1 ','Telefon i internet',2],
  // fuel
  ['OMV','Gorivo',2],
  ['MOL ','Gorivo',2],
  ['NIS A.D','Gorivo',2],
  ['NIS PETROL','Gorivo',2],
  ['EKO SERBIA','Gorivo',2],
  ['GAZPROM','Gorivo',2],
  ['LUKOIL','Gorivo',2],
  ['KNEZ PETROL','Gorivo',2],
  ['DUDA INVEST BS','Gorivo',2],
  ['BS MALA KRSNA','Gorivo',2],
  // groceries
  ['C MARKET','Namirnice',2],
  ['MAXI','Namirnice',2],
  ['TEMPO','Namirnice',2],
  ['IDEA','Namirnice',2],
  ['LIDL','Namirnice',2],
  ['UNIVEREXPORT','Namirnice',2],
  ['MERCATOR','Namirnice',2],
  ['NICEFOODS','Namirnice',2],
  ['PRIMAX FARM','Namirnice',2],
  ['STATOVAC','Namirnice',2],
  ['AROMA','Namirnice',2],
  ['AKSA','Namirnice',2],
  ['DIS ','Namirnice',2],
  ['GRAM','Namirnice',3],
  // pharmacy / health
  ['APOTEKA','Zdravlje i apoteka',2],
  ['BENU','Zdravlje i apoteka',2],
  ['LILLY','Zdravlje i apoteka',3],
  ['DR MAX','Zdravlje i apoteka',2],
  ['ZEGIN','Zdravlje i apoteka',2],
  ['DOM ZDRAVLJA','Zdravlje i apoteka',2],
  ['BOLNICA','Zdravlje i apoteka',2],
  ['STOMATOLOG','Zdravlje i apoteka',2],
  ['CHIP CARD','Zdravlje i apoteka',3],
  // drogerie
  ['DM FILIJALA','Drogerija i kozmetika',2],
  // tolls
  ['JP PUTEVI','Putarina i parking',1],
  ['PUTEVI SRBIJE','Putarina i parking',1],
  ['PARKING','Putarina i parking',2],
  // restaurants / cafes / delivery
  ['WOLT','Restorani i kafići',2],
  ['GLOVO','Restorani i kafići',2],
  ['BURGER','Restorani i kafići',2],
  ['PIVCE','Restorani i kafići',2],
  ['JAMIE','Restorani i kafići',2],
  ['MABOO','Restorani i kafići',2],
  ['THYME','Restorani i kafići',2],
  ['SBX','Restorani i kafići',2],
  ['STARBUCKS','Restorani i kafići',2],
  ['ZMAJ KASA','Restorani i kafići',2],
  ['SMASHER','Restorani i kafići',2],
  ['ORASAC','Restorani i kafići',3],
  ['PEKARA','Restorani i kafići',2],
  ['PIZZ','Restorani i kafići',2],
  ['GRILL','Restorani i kafići',2],
  ['PUB','Restorani i kafići',3],
  // shopping
  ['PANDORA','Šoping',2],
  ['MADAME COCO','Šoping',2],
  ['WOBY HAUS','Šoping',2],
  ['GO TECHNOLOGIES','Šoping',2],
  ['TEHNOMANIJA','Šoping',2],
  ['GIGATRON','Šoping',2],
  ['WINWIN','Šoping',2],
  ['ZARA','Šoping',2],
  ['H&M','Šoping',2],
  ['IKEA','Šoping',2],
  ['JYSK','Šoping',2],
  ['DECATHLON','Šoping',2],
  ['EMMEZETA','Šoping',2],
  ['PAKETOMAT','Šoping',3],
  ['PAYSPOT','Šoping',3],
  ['ALPROS','Šoping',3],
  ['STRADA','Šoping',3],
  // transfers (the specific transfer descriptions are defined at priority 1 above)
  ['PRENOS','Transfer drugima',4],
  ['UPLATA','Ostali prilivi',5],
];

// Apply rules to one transaction-like object. Returns categoryId or null.
// `rules` rows carry the category `kind` (from getRules' join). Matching is
// sign-aware: an income transaction never gets an expense category and vice
// versa (transfer categories apply to both). Reads either merchant_clean
// (insert time) or merchant (DB row, on re-categorization).
export function categorize(tx, rules, isCredit){
  const hay = `${tx.merchant_clean||tx.merchant||''} ${tx.description||''} ${tx.counterparty||''}`.toUpperCase();
  let best = null;
  for(const r of rules){
    if(r.kind === 'income'  && !isCredit) continue;
    if(r.kind === 'expense' &&  isCredit) continue;
    if(hay.includes(r.match)){
      if(best === null || r.priority < best.priority) best = r;
    }
  }
  return best ? best.category_id : null; // caller assigns default if null
}
