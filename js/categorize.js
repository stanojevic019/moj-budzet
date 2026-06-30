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

// [name, kind, color, icon, grp(needs|wants|null), parentName(null=top-level group)]
// Two levels: top-level GROUPS (parent null) each with leaf SUBCATEGORIES.
export const SEED_CATEGORIES = [
  // ===== GROUPS =====
  ['Hrana','expense','#22c55e','🍽️',null,null],
  ['Vozilo i prevoz','expense','#eab308','🚗',null,null],
  ['Stanovanje','expense','#14b8a6','🏠',null,null],
  ['Zdravlje i nega','expense','#ef4444','💊',null,null],
  ['Kupovina','expense','#f43f5e','🛍️',null,null],
  ['Slobodno vreme','expense','#a21caf','🎬',null,null],
  ['Porodica','expense','#fb7185','👨‍👩‍👧',null,null],
  ['Obaveze i finansije','expense','#94a3b8','🏦',null,null],
  ['Gotovina i transferi','transfer','#64748b','🔁',null,null],
  ['Prihodi','income','#16a34a','💼',null,null],
  ['Ostalo','expense','#6b7280','❓',null,null],
  // ===== SUBCATEGORIES =====
  // Hrana
  ['Namirnice','expense','#22c55e','🛒','needs','Hrana'],
  ['Restorani i kafići','expense','#f97316','🍽️','wants','Hrana'],
  // Vozilo i prevoz
  ['Gorivo','expense','#eab308','⛽','needs','Vozilo i prevoz'],
  ['Servis i delovi','expense','#ca8a04','🔧','needs','Vozilo i prevoz'],
  ['Putarina i parking','expense','#a3a3a3','🅿️','needs','Vozilo i prevoz'],
  // Stanovanje
  ['Računi i režije','expense','#14b8a6','🧾','needs','Stanovanje'],
  ['Telefon i internet','expense','#0ea5e9','📱','needs','Stanovanje'],
  // Zdravlje i nega
  ['Zdravlje i apoteka','expense','#ef4444','💊','needs','Zdravlje i nega'],
  ['Lična nega','expense','#db2777','🧴','wants','Zdravlje i nega'],
  // Kupovina
  ['Šoping','expense','#f43f5e','🛍️','wants','Kupovina'],
  ['Odeća i obuća','expense','#e11d48','👕','wants','Kupovina'],
  ['Tehnika','expense','#7c3aed','💻','wants','Kupovina'],
  // Slobodno vreme
  ['Zabava','expense','#a21caf','🎬','wants','Slobodno vreme'],
  ['Pretplate i digitalne usluge','expense','#8b5cf6','📺','wants','Slobodno vreme'],
  // Porodica
  ['Pokloni i donacije','expense','#fb7185','🎁',null,'Porodica'],
  // Obaveze i finansije
  ['Kredit – kamata','expense','#b91c1c','💳','needs','Obaveze i finansije'],
  ['Kredit – glavnica','expense','#7f1d1d','💳',null,'Obaveze i finansije'],
  ['Bankarske naknade','expense','#94a3b8','🏦','needs','Obaveze i finansije'],
  // Gotovina i transferi
  ['Podizanje keša','expense','#64748b','🏧',null,'Gotovina i transferi'],
  ['Transfer drugima','transfer','#f59e0b','↗️',null,'Gotovina i transferi'],
  ['Interni prenos','transfer','#3b82f6','🔁',null,'Gotovina i transferi'],
  ['Menjačnica (devize)','transfer','#0d9488','💱',null,'Gotovina i transferi'],
  // Prihodi
  ['Zarada','income','#16a34a','💼',null,'Prihodi'],
  ['Ostali prilivi','income','#10b981','⬇️',null,'Prihodi'],
  // Ostalo
  ['Ostalo / Nekategorisano','expense','#6b7280','❓',null,'Ostalo'],
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
  ['DM FILIJALA','Lična nega',2],
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
  // UniCredit "LISTA TRANSAKCIJA" wording (no diacritics)
  ['ODRZAVANJE RACUNA','Bankarske naknade',1],
  ['MOBILNO BANKARSTVO','Bankarske naknade',1],
  ['INFOSTAN','Računi i režije',2],
  ['EPS AD','Računi i režije',2],
  ['ALIEXPRESS','Šoping',2],
  ['TEMU','Šoping',2],
  ['UNICEF','Pokloni i donacije',2],
  ['PL:ACC','Interni prenos',2],
  // — derived from the user's statements (recurring merchants) —
  ['CARSKI POH','Restorani i kafići',2],
  ['YUMMY MOMO','Restorani i kafići',2],
  ['VIP CATERING','Restorani i kafići',2],
  ['IDOLBAR','Restorani i kafići',2],
  ['MASNICA','Restorani i kafići',2],
  ['CATERING','Restorani i kafići',3],
  ['RESTORAN','Restorani i kafići',3],
  ['GRMEC','Restorani i kafići',3],
  ['PLANET TYRES','Servis i delovi',2],
  ['TYRES','Servis i delovi',3],
  ['GUME','Servis i delovi',2],
  ['VULKANIZER','Servis i delovi',2],
  ['MOTO - BIKE','Servis i delovi',2],
  ['MOTO-BIKE','Servis i delovi',2],
  ['POLOVNI AUTOMOBILI','Servis i delovi',2],
  ['AUTO DELOVI','Servis i delovi',2],
  ['AUTODELOVI','Servis i delovi',2],
  ['TICKET VISION','Zabava',2],
  ['METROPOLIS MUSIC','Zabava',2],
  ['MOZZART','Zabava',2],
  ['BIOSKOP','Zabava',2],
  ['CINEPLEXX','Zabava',2],
  ['POZORI','Zabava',2],
  ['SEPHORA','Lična nega',2],
  ['NOTINO','Lična nega',2],
  ['FRIZER','Lična nega',2],
  ['JAVNO KOMUNALNO','Računi i režije',2],
  ['JKP','Računi i režije',3],
  ['200-2206180101','Računi i režije',2],
  ['190-99870','Računi i režije',2],
  ['NAPLATNA RAMP','Putarina i parking',2],
  ['DOMACA TRGOVINA','Šoping',3],
  ['WATCHES','Šoping',2],
  // transfers (the specific transfer descriptions are defined at priority 1 above)
  ['PRENOS','Transfer drugima',4],
  ['UPLATA','Ostali prilivi',5],
];

// ---------- on-device learning (merchant memory + Naive Bayes) ----------
const STOP = new Set(['KUPOVINA','CARD','REF','BOOKING','DATE','RSD','EUR','USD','NA','AD','DOO','BEOGRAD','PLAĆANJE','KARTICOM','BANKOMAT','TRANSACTIONCARD','TRANSACTION','INTERNET','SIF','PBO','PBZ','IZ','UPLATA','ISPLATA']);
export function tokenize(text){
  return [...new Set((text||'').toUpperCase().replace(/[^A-ZČĆŽŠĐ0-9 ]/g,' ').split(/\s+/)
    .filter(t => t.length>=3 && !/^\d+$/.test(t) && !STOP.has(t)))].slice(0,40);
}
// stable key for "this exact merchant" memory
export function merchantKey(merchant, description){
  const toks = tokenize(merchant || description).filter(t=>!/^\d/.test(t)).slice(0,3);
  return toks.join(' ');
}
// Multinomial Naive Bayes trained on the user's already-categorized transactions.
export function trainModel(samples){
  const classCount={}, classKind={}, tokAll={}, vocab=new Set(); let total=0;
  for(const s of samples){
    const cid=s.category_id;
    classCount[cid]=(classCount[cid]||0)+1; classKind[cid]=s.kind; total++;
    const tc = tokAll[cid] || (tokAll[cid]={_n:0});
    for(const t of tokenize(s.text)){ tc[t]=(tc[t]||0)+1; tc._n++; vocab.add(t); }
  }
  return { classCount, classKind, tokAll, V:vocab.size, total };
}
export function predict(text, model, isCredit){
  if(!model || model.total < 25) return null;          // need enough history
  const toks = tokenize(text); if(!toks.length) return null;
  const logps = [];
  for(const cid in model.classCount){
    const kind = model.classKind[cid];
    if(kind==='income' && !isCredit) continue;
    if(kind==='expense' && isCredit) continue;
    const tc = model.tokAll[cid] || {_n:0};
    let lp = Math.log(model.classCount[cid]/model.total);
    for(const t of toks) lp += Math.log(((tc[t]||0)+1)/(tc._n + model.V));
    logps.push({ cid:+cid, lp });
  }
  if(!logps.length) return null;
  const max = Math.max(...logps.map(x=>x.lp));
  let denom=0; for(const x of logps) denom += Math.exp(x.lp-max);
  logps.sort((a,b)=>b.lp-a.lp);
  const top = logps[0]; const prob = Math.exp(top.lp-max)/denom;
  return prob >= 0.7 ? { category_id: top.cid, prob } : null;   // only confident guesses
}

// Apply rules + learning to one transaction-like object. Returns categoryId or null.
// ctx = { learned: {key->catId}, model } (optional). Priority: learned → rules → ML.
// `rules` rows carry the category `kind` (from getRules' join). Matching is
// sign-aware: an income transaction never gets an expense category and vice
// versa (transfer categories apply to both). Reads either merchant_clean
// (insert time) or merchant (DB row, on re-categorization).
export function categorize(tx, rules, isCredit, ctx){
  const merch = tx.merchant_clean || tx.merchant || '';
  // 1) learned exact merchant (taught by the user) — strongest
  if(ctx && ctx.learned){
    const k = merchantKey(merch, tx.description);
    if(k && ctx.learned[k] != null) return ctx.learned[k];
  }
  // 2) explicit keyword rules
  const hay = `${merch} ${tx.description||''} ${tx.counterparty||''}`.toUpperCase();
  let best = null;
  for(const r of rules){
    if(r.kind === 'income'  && !isCredit) continue;
    if(r.kind === 'expense' &&  isCredit) continue;
    if(hay.includes(r.match)){
      if(best === null || r.priority < best.priority) best = r;
    }
  }
  if(best) return best.category_id;
  // 3) on-device ML prediction (only when confident)
  if(ctx && ctx.model){
    const p = predict(`${merch} ${tx.description||''}`, ctx.model, isCredit);
    if(p) return p.category_id;
  }
  return null; // caller assigns default if null
}
