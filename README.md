# Magazzino Ricambi Industriali

App mobile-first per la gestione di un magazzino ricambi, con scanner barcode da fotocamera, deposito/prelievo in tempo reale, anagrafica articoli con stampa etichette PDF e reportistica consumi per l'admin.

Backend: **Supabase** (già configurato: tabelle, RLS, funzioni SQL).
Frontend: HTML/CSS/JS vanilla (nessuna build necessaria), Tailwind via CDN.

## Struttura file

```
index.html            Shell dell'app, tutte le viste (login, scanner, articoli, dashboard)
style.css              Tema "placard industriale", animazioni, skeleton loading
tailwind.config.js     Palette/font del tema (script esterno, caricato dopo il CDN Tailwind)
supabase.js            Client Supabase + tutte le query (auth, prodotti, transazioni)
auth.js                 Login/logout, gestione sessione e ruolo utente
scanner.js               Scansione barcode da fotocamera, flusso deposito/prelievo
products.js               Anagrafica articoli: CRUD, barcode, stampa etichette PDF
dashboard.js               Reportistica consumi (solo Admin)
toast.js                    Notifiche toast
app.js                       Entry point: routing tra viste in base al ruolo
```

Nessun bundler richiesto: tutti i moduli sono `<script type="module">` con import ES nativi; le librerie esterne (Supabase JS, JsBarcode, jsPDF, html5-qrcode) sono caricate da CDN.

## Database Supabase (già configurato)

Progetto: `ffbwazuikbqkikuybcyp` (regione eu-central-1).

Sono state applicate le seguenti migrazioni:

1. **`profiles`** — estende `auth.users` con un ruolo (`admin` / `user`). Un trigger su `auth.users` crea automaticamente il profilo (ruolo `user` di default) ad ogni nuova registrazione.
2. **`products`** — anagrafica articoli (codice, descrizione, punto di utilizzo standard, locazione, giacenza, scorta minima, barcode).
3. **`transactions`** — log immutabile di ogni deposito/prelievo (prodotto, utente, tipo, quantità, data/ora, punto di utilizzo specifico).
4. **RLS**: tutti gli utenti autenticati leggono l'anagrafica articoli; solo gli admin possono creare/modificare/eliminare articoli; lo storico transazioni è visibile per intero solo agli admin (gli operatori vedono solo le proprie transazioni); l'inserimento diretto in `transactions` è bloccato — passa solo dalla funzione RPC.
5. **Funzione `process_transaction`** — aggiorna la giacenza e registra la transazione in un'unica operazione atomica (con lock di riga), impedendo giacenze negative e race condition su richieste concorrenti. Ritorna anche un flag `sotto_scorta` usato per il toast di avviso.

### Creare il primo utente Admin

1. In Supabase → **Authentication → Users**, crea un utente (email + password), oppure fallo registrare dall'app se hai abilitato la sign-up.
2. Il trigger crea automaticamente una riga in `profiles` con ruolo `user`. Promuovilo ad admin da **SQL Editor**:

```sql
update public.profiles set role = 'admin' where id = (
  select id from auth.users where email = 'nome@azienda.it'
);
```

Da quel momento l'utente vedrà anche le viste **Articoli (gestione)** e **Report**.

> Nota: questa app non include una pagina di registrazione self-service — gli account vanno creati da Supabase Auth (dashboard o API admin), coerentemente con un magazzino ad accesso controllato.

## Deploy su Cloudflare Pages via GitHub

1. **Crea il repository GitHub** e carica tutti i file di questa cartella nella root del repo (nessuna sottocartella `src`/`dist`):

   ```bash
   git init
   git add .
   git commit -m "Prima versione app magazzino"
   git branch -M main
   git remote add origin https://github.com/<tuo-utente>/<tuo-repo>.git
   git push -u origin main
   ```

2. **Collega Cloudflare Pages al repo**:
   - Cloudflare Dashboard → *Workers & Pages* → *Create* → *Pages* → *Connect to Git*.
   - Seleziona il repository appena creato.
   - Configurazione build:
     - **Framework preset**: `None`
     - **Build command**: *(lascia vuoto)*
     - **Build output directory**: `/`
   - Deploy.

3. Ad ogni `git push` su `main`, Cloudflare Pages ridistribuisce automaticamente la nuova versione.

4. **Camera e HTTPS**: lo scanner richiede l'accesso alla fotocamera, disponibile solo su origini sicure. Cloudflare Pages serve tutto in HTTPS di default, quindi funziona subito sul dominio `*.pages.dev` o su un dominio custom collegato.

5. **Chiave Supabase**: `supabase.js` contiene già l'URL del progetto e la chiave `anon`/pubblica (sicura da esporre pubblicamente: l'accesso ai dati è comunque filtrato dalle policy RLS lato database). Non serve alcuna variabile d'ambiente per il deploy statico.

## Sviluppo locale

Basta un server statico qualsiasi (serve solo per gli import ES module, che non funzionano da `file://`):

```bash
npx serve .
# oppure
python3 -m http.server 8080
```

Poi apri `http://localhost:8080` (per testare la fotocamera da smartphone in rete locale, alcuni browser richiedono comunque HTTPS: usa `npx serve . --ssl` o un tunnel come `ngrok`/`cloudflared`).
