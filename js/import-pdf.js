// Browser PDF text extraction via pdf.js, feeding the validated column-aware parser.
import * as pdfjs from '../vendor/pdf.min.mjs';
import { parseIntesaPages } from './parse-intesa.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).toString();

export async function extractPages(file){
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, useSystemFonts:true, isEvalSupported:false }).promise;
  const pages = [];
  for(let p=1; p<=doc.numPages; p++){
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({ items: tc.items.filter(i=>i.str).map(i=>({
      str:i.str, x:i.transform[4], y:i.transform[5], w:i.width||0 })) });
  }
  return pages;
}

// Independent balance reconciliation: opening + credits - debits == last balance.
function reconcile(parsed){
  const t = parsed.transactions;
  if(parsed.opening == null || !t.length) return { ok:null };
  const cred = t.filter(x=>x.signed>0).reduce((s,x)=>s+x.signed,0);
  const deb  = t.filter(x=>x.signed<0).reduce((s,x)=>s-x.signed,0);
  const calc = parsed.opening + cred - deb;
  const real = t[t.length-1].balance;
  return { ok: real!=null && Math.abs(calc-real) < 0.05, calc, real };
}

// Returns { ok, bank, parsed, recon, error }
export async function parseFile(file){
  let pages;
  try {
    pages = await extractPages(file);
  } catch(e){
    return { ok:false, error:'Fajl nije čitljiv PDF (možda je šifrovan ili oštećen).', fatal:true };
  }
  // The parser is specific (date columns + RSD amounts + "Početno stanje"); decide by its result.
  const parsed = parseIntesaPages(pages);
  if(parsed.transactions.length){
    return { ok:true, bank:'Banca Intesa', parsed, recon: reconcile(parsed) };
  }
  const flat = pages.flatMap(p=>p.items.map(i=>i.str)).join(' ');
  if(/IZVOD PLATNOG/i.test(flat) || /bancaintesa/i.test(flat))
    return { ok:false, error:'Prepoznat Intesa izvod, ali nije pronađena nijedna transakcija.' };
  return { ok:false, error:'Format izvoda nije prepoznat (za sada je podržana Banca Intesa).' };
}
