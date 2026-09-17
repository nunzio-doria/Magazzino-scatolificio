# Sicurezza — stato e azioni eseguite

Questo file riprende i punti dell'analisi di sicurezza precedente e riporta,
per ciascuno, cosa è stato verificato/corretto e cosa resta da fare a mano
(impostazioni che vivono solo nella Dashboard Supabase, non nel codice).

**Punto 5 (cancellazione storico) escluso volutamente da questo giro di
correzioni**, su richiesta esplicita: `deleteAllTransactions()` in
`supabase.js` e il pulsante "Zona pericolosa" in Impostazioni sono rimasti
invariati.

## 1. Controllo ruoli — audit RLS reale (fatto)

È stato interrogato direttamente il progetto Supabase collegato
(`ffbwazuikbqkikuybcyp`) invece di limitarsi a leggere il codice client.
Risultato: **le RLS erano già corrette**, non solo lato UI:

- `products`: INSERT/UPDATE/DELETE richiedono `current_user_role() = 'admin'` — un operatore che chiama l'API direttamente da DevTools riceve comunque un errore di permessi dal database.
- `transactions`: DELETE riservato agli admin (blinda `deleteAllTransactions()` anche se qualcuno bypassa l'UI); INSERT non è consentito ai client direttamente — passa solo dalla RPC `process_transaction`.
- `profiles`: INSERT riservato agli admin; SELECT/UPDATE solo sul proprio profilo o da admin.
- Le RPC `SECURITY DEFINER` (`bulk_upsert_products`, `process_transaction`) validano il ruolo/l'utente **anche internamente**, non si affidano solo alle RLS.

Unica correzione applicata: la funzione `current_user_role()` era
richiamabile anche da utenti **non autenticati** (ruolo `anon`) — segnalato
dal Security Advisor di Supabase. Revocata l'esecuzione:

```sql
revoke execute on function public.current_user_role() from anon;
```

Le altre RPC risultano già correttamente limitate al ruolo `authenticated`.

## 2. Logout automatico per inattività (fatto)

Aggiunto in `auth.js`: dopo **10 minuti** senza interazione (tocco, tasto,
scroll), l'utente viene disconnesso automaticamente, con un avviso 60s
prima. Il timer riparte ad ogni interazione ed è collegato anche al
`visibilitychange` (schermo bloccato/app in background e poi ripresa).
Per cambiare la soglia, modifica `IDLE_TIMEOUT_MS` in cima al file.

Non è stato aggiunto un blocco con PIN rapido per il cambio operatore
(cambierebbe il flusso di login): se serve, è un secondo intervento a
parte.

## 3. Header di sicurezza HTTP (fatto)

L'app è pubblicata su **Cloudflare Pages** (non Netlify), quindi il file
giusto è `_headers` nella root del progetto — non `netlify.toml`, che
Cloudflare Pages ignora. Aggiunto `_headers` con CSP,
`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`. Cloudflare Pages lo legge in
automatico ad ogni deploy, senza bisogno di configurazione aggiuntiva nel
progetto — basta che il file sia nella cartella pubblicata (qui la root,
dato che non c'è un passo di build). Note sulla CSP:

- `style-src` include `'unsafe-inline'` perché il Play CDN di Tailwind
  inietta un `<style>` a runtime — è un limite del Play CDN, non del sito.
  Passare a una build Tailwind reale permetterebbe di toglierlo.
- `connect-src` include solo il progetto Supabase collegato (nessun
  websocket: l'app non usa Realtime).
- `frame-ancestors 'none'` blocca l'embedding in iframe di terzi.

## 4. Dipendenze CDN (fatto in parte)

- **Lucide**: da `@latest` a versione fissa (`1.11.0`).
- **Tailwind**: da CDN non versionato a versione fissa (`3.4.17`, via
  `https://cdn.tailwindcss.com/[email protected]`).
- JsBarcode, jsPDF, html5-qrcode, xlsx erano già pinnati a versione fissa.

**SRI (Subresource Integrity) non è stato aggiunto**: un hash sbagliato
bloccherebbe silenziosamente lo script in produzione — un rischio peggiore
del problema che dovrebbe risolvere — e generarlo in modo affidabile
richiede accesso diretto ai byte serviti dal CDN, che non è disponibile da
qui. Per aggiungerlo (consigliato, una tantum, dopo ogni cambio di
versione di una libreria):

```bash
curl -s <url-dello-script> | openssl dgst -sha384 -binary | openssl base64 -A
```

Il risultato va incollato come `integrity="sha384-<hash>"` (più
`crossorigin="anonymous"`) sul relativo tag `<script>` in `index.html`. In
alternativa, jsdelivr e cdnjs mostrano l'hash SRI pronto nella pagina di
ogni pacchetto.

**Passare a una build Tailwind reale non è stato fatto**: è un cambio
architetturale (richiede Node, `tailwindcss` CLI/PostCSS, una fase di
build prima del deploy) diverso dal resto del progetto, che oggi è
volutamente "senza build". Fattibile come intervento a parte se utile.

## 5. Cancellazione storico — **escluso** da questo giro (vedi sopra)

## 6. Validazione dati lato database (già presente, verificato)

Controllato lo schema reale: `quantita_disponibile >= 0`,
`scorta_minima >= 0`, `quantita > 0` sono già `CHECK` a livello di
database (non solo nel form), oltre a `UNIQUE` su `codice_barre`, enum
Postgres per `categoria`/`tipo`/`role`, e foreign key su tutti i
riferimenti. Chi chiama l'API bypassando il form riceve comunque un
errore dal database sui valori fuori regola.

## Cache locale non cifrata (punto 7 — non modificato)

Non toccato in questo giro: richiederebbe decidere un compromesso tra
sicurezza e la modalità offline dello scanner (che si appoggia proprio a
questa cache). Segnalato solo come nota per una eventuale sessione
dedicata.

## 8. MFA / policy password / rate-limiting login (azione manuale richiesta)

Queste sono impostazioni di Supabase Auth, non modificabili da qui via
SQL/migration:

- **Password compromesse (leaked password protection)**: risultava
  disabilitata (Security Advisor). Da attivare in Dashboard → Authentication
  → Policies → Password Security.
- **MFA per gli admin**: da attivare in Dashboard → Authentication →
  Providers/MFA, poi far enrollare agli admin un fattore TOTP dal loro
  account. Se vuoi, posso aggiungere all'app una schermata in Impostazioni
  per l'enrollment TOTP (lato client, via `supabase.auth.mfa`) — è un
  intervento separato, non incluso qui perché cambia il flusso di login.
- **Rate-limiting sui tentativi falliti**: gestito automaticamente da
  Supabase Auth; verificabile/configurabile in Dashboard → Authentication
  → Rate Limits.

## 9. Log in console (non modificato)

Rischio basso, lasciato invariato in questo giro.
