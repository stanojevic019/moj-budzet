# 💰 Moj Budžet

Privatna PWA aplikacija za praćenje ličnih finansija. Uvoz PDF izvoda, ručni unos
troškova i priliva, mesečni grafikoni i trendovi.

**Svi podaci su šifrovani (AES-256-GCM) i ostaju samo na uređaju.** Aplikacija nema
vezu sa internetom ni sa bankama — ništa se ne šalje na server. Ovaj repozitorijum
sadrži isključivo kôd aplikacije; nikakvi lični/finansijski podaci nisu ovde.

## Korišćenje na telefonu

1. Otvori objavljeni link (GitHub Pages) u browseru na telefonu.
2. Meni browsera → **„Dodaj na početni ekran"** (Add to Home Screen).
3. Pokreni je kao aplikaciju, postavi lozinku, pa **Uvoz** za PDF izvode.

Aplikacija radi i offline nakon prvog otvaranja.

## Mogućnosti

- **Uvoz PDF izvoda** (Banca Intesa, RSD i EUR) + ručni unos; više računa i keš.
- **Budžeti** — mesečni limiti po kategoriji, napredak i upozorenja na prekoračenje.
- **Analiza kao ekonomista** — pravilo 50/30/20 (potrebe/želje/štednja), projekcija
  potrošnje do kraja meseca, trend neto vrednosti, najveće promene po kategorijama,
  stopa štednje, rezerva u mesecima, pretplate.
- **Filtriranje i izolacija troškova** — po mesecu, računu, kategoriji, opsegu datuma
  i iznosa, tipu (prihod/rashod), pretraga; drill-down po kategoriji sa sopstvenim trendom.
- **Prilagođavanje** — kategorije (ime/boja/grupa/brisanje), pravila auto-kategorizacije,
  akcenat boja.
- **Izvoz** u Excel/CSV.

## Bezbednost

- Lozinka → ključ (PBKDF2, 600k iteracija) → AES-256-GCM šifruje celu bazu.
- Baza (SQLite preko sql.js) čuva se lokalno u IndexedDB, uvek šifrovana.
- **Automatsko zaključavanje** pri neaktivnosti i **režim skrivanja iznosa** (privatnost).
- Lozinka se nigde ne pamti; ako se zaboravi, podaci se ne mogu povratiti.

## Auto-update

Aplikacija proverava nove verzije i ponudi „Osveži" kad je nova verzija spremna.

## Tehnologije

Vanilla JS · pdf.js (čitanje izvoda) · sql.js (SQLite u browseru) · Chart.js · SheetJS
(izvoz u Excel). Sve biblioteke su lokalne (`vendor/`), bez ijednog poziva ka mreži.

## Podržani izvodi

- **Banca Intesa** — izvod platnog računa (RSD i devizni EUR).
- UniCredit i ostale banke — u pripremi. Ručni unos i ručno dodavanje računa rade za bilo koju banku.
