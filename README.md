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

## Bezbednost

- Lozinka → ključ (PBKDF2, 310k iteracija) → AES-256-GCM šifruje celu bazu.
- Baza (SQLite preko sql.js) čuva se lokalno u IndexedDB, uvek šifrovana.
- Lozinka se nigde ne pamti; ako se zaboravi, podaci se ne mogu povratiti.

## Tehnologije

Vanilla JS · pdf.js (čitanje izvoda) · sql.js (SQLite u browseru) · Chart.js · SheetJS
(izvoz u Excel). Sve biblioteke su lokalne (`vendor/`), bez ijednog poziva ka mreži.

## Podržani izvodi

- **Banca Intesa** — izvod platnog računa (RSD i devizni EUR).
- UniCredit i ostale banke — u pripremi. Ručni unos i ručno dodavanje računa rade za bilo koju banku.
