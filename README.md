# Magazzino Ricambi Industriali

App mobile-first per la gestione di un magazzino ricambi, con scanner barcode da fotocamera, deposito/prelievo in tempo reale, anagrafica articoli con stampa etichette PDF e reportistica consumi per l'admin.

Backend: **Supabase** (già configurato: tabelle, RLS, funzioni SQL).
Frontend: HTML/CSS/JS vanilla (nessuna build necessaria), Tailwind via CDN.

## Struttura file

```
index.html            Shell dell'app, tutte le viste (login, scanner, magazzino, dashboard, impostazioni)
style.css              Tema chiaro "Scatolificio Sarno", animazioni, transizioni glass, skeleton loading
tailwind.config.js     Palette/font del tema (script esterno, caricato dopo il CDN Tailwind)
manifest.json           Web App Manifest per l'installazione PWA
service-worker.js        Service worker minimo (cache della shell statica, installabilità)
icons/                    Icone PWA in tutte le dimensioni (favicon, 192, 512, maskable, apple-touch-icon)
supabase.js            Client Supabase + tutte le query (auth, prodotti, transazioni, import Excel, profili utente)
auth.js                 Login/logout, gestione sessione e ruolo utente
camera.js                Gestione fotocamera condivisa (scanner deposito/prelievo + assegnazione barcode articolo)
scanner.js                Flusso deposito/prelievo: selezione modalità, lettura barcode, conferma
products.js                Magazzino: 3 categorie, CRUD, import Excel, etichette PDF, undo/redo, generazione barcode
picker.js                   Modale di selezione personalizzato (combobox Linea/Macchina)
users.js                     Gestione nome e cognome degli utenti registrati (vista Impostazioni)
dashboard.js               Reportistica consumi + drill-down storico per articolo (solo Admin)
toast.js                    Notifiche toast
app.js                       Entry point: routing tra viste, transizioni glass, registrazione service worker
```

## Novità di questa sessione

**Campo "Descrizione" rimosso completamente** — era causa di doppioni nell'elenco articoli (mostrava il codice due volte quando la descrizione era vuota). Rimosso da form, ricerca, database e dagli output PDF/report.

**Elenco Magazzino senza doppioni** — ogni riga mostra il **codice articolo in grassetto** in alto, e sotto in piccolo locazione, macchina, punto di utilizzo e linea (solo i campi effettivamente valorizzati).

**Ricerca rapida estesa** — ora cerca anche per punto di utilizzo e macchina, oltre a codice, locazione e barcode.

**Linea e Macchina: combobox personalizzate** — sostituiti lo `<select>` nativo e il `<datalist>` (che su alcuni telefoni apriva la tastiera senza mostrare l'elenco) con un modale di selezione disegnato ad hoc: tocchi il campo, si apre un elenco a scorrimento con ricerca in tempo reale, nessun placeholder fuorviante. La combobox "Macchina" propone solo i valori già registrati ma permette comunque di digitarne uno nuovo (comparirà un'opzione "Aggiungi ..."); "Linea" mostra solo le tre opzioni fisse L1/L2/L1-L2.

**Barcode per le Cinghie** — dato che le cinghie non hanno un codice a barre fisico stampato come i cuscinetti, è stato aggiunto un pulsante dedicato "Genera" (icona +) che crea un codice deterministico (prefisso di categoria + codice articolo, es. `CIN-B123`): è stabile per sempre, rigenerarlo per lo stesso articolo produce sempre lo stesso valore.

**Etichetta PDF rifatta da zero**:
- Contiene ora **solo il barcode e il numero sotto** (nessun testo aggiuntivo).
- Corretto il bug che tagliava il codice a barre fuori pagina: jsPDF, senza l'orientamento esplicito, interpretava male un formato personalizzato più largo che alto. Ora l'immagine viene anche scalata mantenendo le proporzioni reali del barcode generato, centrata nell'etichetta, senza mai deformarsi o uscire dal bordo.
- Il pulsante "Stampa etichetta PDF" (testuale) è stato sostituito da un **pulsante piccolo con sola icona** (stampante).

**Login e topbar**: rimossa la visualizzazione dell'email sotto "Magazzino" nella barra in alto dopo il login; il testo è ora "Magazzino Scatolificio".

**Gestione utenti (Impostazioni, solo Admin)** — nuova sezione che elenca tutti gli utenti registrati con email e ruolo, e permette di impostare Nome e Cognome per ciascuno: da questo momento lo storico transazioni e i report mostrano il nome invece dell'email (richiede che un admin compili il nome per ogni utente la prima volta).

**Consumi per articolo → drill-down** — nella dashboard, toccando un articolo nella lista "Consumi per articolo" si apre un modale con lo storico completo dei suoi movimenti, filtrabile con le tab Tutti / Depositi / Prelievi.

**Transizioni "glass" tra le sezioni** — passando da una vista all'altra tramite il menu in basso, il contenuto sfuma con un leggero effetto sfocato (blur + fade), e il tab attivo nella barra inferiore ha un effetto vetro smerigliato (sfondo semi-trasparente con `backdrop-filter: blur`) che appare/scompare con un'animazione morbida.

**Undo/Redo, tema chiaro col blu del logo, icone PWA, riquadro scanner più compatto** — vedi le sezioni dedicate più sotto (introdotte nella sessione precedente, ancora tutte attive).

Nessun bundler richiesto: tutti i moduli sono `<script type="module">` con import ES nativi; le librerie esterne (Supabase JS, JsBarcode, jsPDF, html5-qrcode, SheetJS/xlsx) sono caricate da CDN.

## PWA: installazione con icona dedicata

L'app è una Progressive Web App installabile da Chrome (desktop e Android) e da Safari (iOS, tramite "Aggiungi a Home"):

- **`manifest.json`** definisce nome, colori del tema e tutte le icone (16, 32, 192, 512, più le varianti 192/512 **maskable** con margine di sicurezza per le mascherature circolari/arrotondate di Android).
- **`icons/`** contiene tutte le dimensioni generate dal logo (scatola con cuscinetti, cinghie e ricambi su sfondo blu). Il blu di sfondo del logo (`#13223f`/`#2f4f92`) è anche il colore del tema (`theme-color`) e dell'accento principale dell'interfaccia.
- **`service-worker.js`** mette in cache solo l'involucro statico dell'app (HTML/CSS/JS/icone), necessario perché Chrome consideri l'app installabile. Le chiamate a Supabase e alle CDN esterne passano sempre dalla rete, senza essere intercettate.

Per installarla: apri il sito da Chrome su Android → menu (⋮) → "Installa app" (o la icona di installazione nella barra indirizzi su desktop). L'icona apparirà come qualunque altra app, con il logo dedicato.

> Nota tecnica: alcuni store di icone dei browser mantengono in cache la vecchia icona per un po' — se dopo l'installazione vedi ancora l'icona generica, disinstalla e reinstalla la PWA, oppure svuota la cache del sito.

> Nota sugli aggiornamenti: il service worker mette in cache la shell dell'app con il nome `magazzino-shell-v1`. Ai prossimi aggiornamenti sostanziali del frontend, incrementa quel nome (es. `v2`) in cima a `service-worker.js`, altrimenti gli utenti che hanno già installato l'app potrebbero continuare a vedere file vecchi dalla cache per un po'.

## Tema chiaro e colore del brand

Il tema è stato convertito da scuro ad **chiaro**, e il colore di accento (bottoni, tab attive, focus, badge) è passato dall'arancione al **blu dello sfondo del logo** (`#2f4f92`, con sfumature più chiare/scure per hover e badge). Le uniche eccezioni volute sono i colori semantici invariati: verde per "deposito"/successo, rosso per errori/eliminazioni/sotto-scorta.

> Nota: per semplicità, il badge di avviso "sotto scorta minima" e la modalità "Prelievo" dello scanner ora usano lo stesso blu del brand invece di un arancione distintivo. Se preferisci che gli avvisi di sotto-scorta restino in una tonalità diversa (es. giallo/arancione) per distinguerli a colpo d'occhio dal blu dei pulsanti, fammelo sapere e aggiungo un colore "warning" separato.

## Undo / Redo sul Magazzino

Nella vista Magazzino, accanto al pulsante "+ Nuovo", ci sono due pulsanti **↶ Annulla** e **↷ Ripeti** (visibili solo per l'Admin). Coprono le tre operazioni sugli articoli:

- **Creazione** di un nuovo articolo → annullare lo elimina di nuovo.
- **Modifica** di un articolo esistente → annullare ripristina tutti i campi al valore precedente.
- **Eliminazione** di un articolo → annullare lo ricrea con lo stesso ID e tutti i dati originali.

La cronologia è tenuta in memoria (si azzera ricaricando la pagina) e tiene fino a 20 operazioni; una nuova modifica dopo un "Annulla" cancella le operazioni "Ripeti" pendenti, come nei normali editor. L'import massivo da Excel **non** è coperto da undo/redo (agisce su molte righe contemporaneamente): in caso di import errato, va corretto manualmente o ricaricando un file corretto.

## Fotocamera: riquadro di scansione più compatto

Il riquadro di scansione (sia nello scanner deposito/prelievo sia nell'acquisizione barcode dal form articolo) è stato ridotto e reso meno allungato in larghezza, per un'inquadratura più mirata sul codice a barre.



## Il Magazzino: 3 categorie

La vista "Magazzino" è divisa in tre tab e mostra la lista/ricerca degli articoli. L'**import da Excel è stato spostato in Impostazioni** (icona ingranaggio in alto a destra, al posto del vecchio tasto Esci — il logout ora si trova dentro Impostazioni insieme all'import).

- **Cuscinetti** — import Excel su 3 colonne (A→C): `Codice`, `Locazione`, `Quantità`. La scorta minima non è ancora definita, quindi viene impostata automaticamente a **5** per ogni articolo importato. Per assegnare il barcode a un cuscinetto (quello già stampato sulla scatola, senza generarne uno nuovo), apri l'articolo e premi l'icona di scansione accanto al campo "Codice a barre": si apre la fotocamera, inquadri il codice e viene inserito automaticamente nel campo.
- **Cinghie** — import Excel su 7 colonne (A→G): `Codice`, `Locazione`, `Quantità`, `Linea`, `Macchina`, `Punto di utilizzo`, `Scorta minima`. Nella vista Magazzino, quando questa categoria è attiva, compare un **filtro Linea** (Tutte / L1 / L2 / L1-L2): selezionando L1 vedi anche gli articoli L1-L2 (e viceversa per L2), perché quegli articoli servono entrambe le linee; selezionando "Solo L1-L2" vedi solo quelli esclusivi di entrambe.
- **Pezzi di ricambio** — in sospeso: l'inventario non è stato ancora popolato, quindi l'import Excel non è configurato per questa categoria (i formati non sono stati definiti). Restano comunque disponibili la creazione manuale dell'articolo e tutte le altre funzionalità (barcode, deposito/prelievo, report). Quando sarà pronto l'elenco/formato del file, si potrà aggiungere l'import allo stesso modo delle altre due categorie.

**Formato dei file Excel**: la prima riga può contenere le intestazioni (vengono riconosciute automaticamente e saltate se la prima cella contiene "codice") oppure i dati possono partire direttamente dalla riga 1 — le colonne vengono lette per **posizione** (A, B, C…), non per nome. Il codice articolo è univoco all'interno della stessa categoria: ricaricando un file con codici già presenti, gli articoli vengono **aggiornati** (locazione, quantità, scorta minima, linea/macchina, punto di utilizzo) invece che duplicati.

L'import è disponibile solo per l'Admin, dalla vista **Impostazioni** → tab della categoria → "Carica da Excel".

### Nuovo articolo: Linea e Macchina

Nel form articolo (categoria Cinghie):
- **Linea** è un menu a tendina fisso con solo tre valori possibili: `L1`, `L2`, `L1-L2`.
- **Macchina** è una combobox (campo di testo con suggerimenti): propone solo i valori di macchina già presenti tra gli articoli registrati, senza duplicati, ma resta possibile digitarne uno nuovo se serve censire una macchina non ancora vista.

## Database Supabase (già configurato)

Progetto: `ffbwazuikbqkikuybcyp` (regione eu-central-1).

Sono state applicate le seguenti migrazioni:

1. **`profiles`** — estende `auth.users` con un ruolo (`admin` / `user`). Un trigger su `auth.users` crea automaticamente il profilo (ruolo `user` di default) ad ogni nuova registrazione.
2. **`products`** — anagrafica articoli: codice, descrizione (opzionale), **categoria** (`cuscinetti`/`cinghie`/`pezzi_ricambio`), locazione, giacenza, scorta minima, barcode, e i campi `linea`/`macchina` (usati principalmente dalle cinghie). Il codice articolo è univoco per categoria (stesso codice può teoricamente esistere in categorie diverse).
3. **`transactions`** — log immutabile di ogni deposito/prelievo (prodotto, utente, tipo, quantità, data/ora, punto di utilizzo specifico).
4. **RLS**: tutti gli utenti autenticati leggono l'anagrafica articoli; solo gli admin possono creare/modificare/eliminare articoli e importare da Excel; lo storico transazioni è visibile per intero solo agli admin (gli operatori vedono solo le proprie transazioni); l'inserimento diretto in `transactions` è bloccato — passa solo dalla funzione RPC.
5. **Funzione `process_transaction`** — aggiorna la giacenza e registra la transazione in un'unica operazione atomica (con lock di riga), impedendo giacenze negative e race condition su richieste concorrenti. Ritorna anche un flag `sotto_scorta` usato per il toast di avviso.
6. **Funzione `bulk_upsert_products`** — riceve la categoria e un array di righe (dal file Excel) e fa upsert su `(categoria, codice_articolo)`: inserisce i nuovi articoli e aggiorna quelli già presenti. Solo un admin può eseguirla.

### Creare il primo utente Admin

1. In Supabase → **Authentication → Users**, crea un utente (email + password), oppure fallo registrare dall'app se hai abilitato la sign-up.
2. Il trigger crea automaticamente una riga in `profiles` con ruolo `user`. Promuovilo ad admin da **SQL Editor**:

```sql
update public.profiles set role = 'admin' where id = (
  select id from auth.users where email = 'nome@azienda.it'
);
```

Da quel momento l'utente vedrà anche le viste **Magazzino (gestione/import)** e **Report**.

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
