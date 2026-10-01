// =============================================================
// supabase.js — Configurazione client Supabase e data-access layer
// =============================================================
// Tutte le altre parti dell'app (auth.js, products.js, scanner.js,
// dashboard.js, app.js) importano da qui: nessuna query Supabase
// viene fatta al di fuori di questo file.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// --- Configurazione progetto ---------------------------------
// Valori del progetto Supabase collegato. La anon/publishable key
// è pubblica per design (protetta dalle policy RLS lato database).
export const SUPABASE_URL = 'https://ffbwazuikbqkikuybcyp.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_kWZPPxUMxf78iuK5yCdlYg_f4J2oXwx';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

// --- CACHE LOCALE PRODOTTI (per consultazione offline) --------------
// Copia "best effort" dell'ultimo stato noto degli articoli, salvata in
// localStorage ogni volta che una lettura va a buon fine. Non sostituisce
// mai una query online riuscita: serve solo come ultima spiaggia quando
// la rete manca (scanner in modalità offline, coda transazioni).
const PRODUCT_CACHE_KEY = 'magazzino-product-cache';

function loadProductCache() {
  try {
    return JSON.parse(localStorage.getItem(PRODUCT_CACHE_KEY) || '{}');
  } catch (err) {
    return {};
  }
}
function saveProductCache(cache) {
  try {
    localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn('Impossibile salvare la cache offline dei prodotti.', err);
  }
}
/** Aggiorna la cache con un elenco di prodotti appena letto dal server */
export function cacheProductsList(list) {
  if (!Array.isArray(list) || !list.length) return;
  const cache = loadProductCache();
  for (const p of list) {
    cache.byId = cache.byId || {};
    cache.byId[p.id] = p;
    if (p.codice_barre) {
      cache.byBarcode = cache.byBarcode || {};
      cache.byBarcode[p.codice_barre] = p.id;
    }
  }
  saveProductCache(cache);
}
/** Cerca un prodotto nella cache locale per barcode, quando la rete non risponde */
export function getCachedProductByBarcode(codiceBarre) {
  const cache = loadProductCache();
  const id = cache.byBarcode?.[codiceBarre];
  return id != null ? cache.byId?.[id] || null : null;
}
/** Cerca prodotti nella cache locale per codice articolo (o barcode),
 *  quando la rete non risponde — fallback offline della ricerca manuale
 *  per codice articolo nello scanner. */
export function searchCachedProducts(term) {
  const q = (term || '').trim().toLowerCase();
  if (!q) return [];
  const cache = loadProductCache();
  const all = Object.values(cache.byId || {});
  return all.filter(
    (p) => (p.codice_articolo || '').toLowerCase().includes(q) || (p.codice_barre || '').toLowerCase().includes(q)
  );
}
/**
 * Aggiorna otticamente la giacenza di un prodotto in cache dopo una
 * transazione messa in coda offline, cosí lo scanner mostra un valore
 * coerente anche prima della sincronizzazione.
 */
// Contatore condiviso: aumenta ogni volta che una giacenza cambia (movimento registrato,
// movimento offline sincronizzato). Il Magazzino lo confronta con l'ultimo valore visto
// per sapere se la lista in memoria va aggiornata (in silenzio) al rientro nella sezione.
let productsVersion = 0;
export function getProductsVersion() {
  return productsVersion;
}
export function bumpProductsVersion() {
  productsVersion += 1;
}

export function adjustCachedProductQuantity(id, delta, locationId = null) {
  const cache = loadProductCache();
  const p = cache.byId?.[id];
  if (!p) return;
  p.quantita_disponibile = (p.quantita_disponibile || 0) + delta;
  // Aggiorna anche lo scaffale interessato (quello scelto, o l'unico se l'articolo ne ha uno solo)
  if (Array.isArray(p.locations)) {
    const loc = locationId ? p.locations.find((l) => l.id === locationId) : p.locations.length === 1 ? p.locations[0] : null;
    if (loc) loc.quantita = Math.max(0, (loc.quantita || 0) + delta);
  }
  saveProductCache(cache);
}

// --- AUTH ------------------------------------------------------
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Recupera il profilo applicativo (con ruolo) dell'utente corrente */
export async function getMyProfile() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;
  if (!userData?.user) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, email')
    .eq('id', userData.user.id)
    .single();
  if (error) throw error;
  return data;
}

// --- PROFILI UTENTE (gestione nomi, vista Impostazioni Admin) -------
export async function listProfiles() {
  const { data, error } = await supabase.from('profiles').select('id, email, full_name, role').order('email');
  if (error) throw error;
  return data;
}

export async function updateProfileName(id, fullName) {
  const { data, error } = await supabase.from('profiles').update({ full_name: fullName }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// --- PRODUCTS ----------------------------------------------------
// Ogni articolo può stare su più scaffali, ciascuno con la sua quantità (tabella
// `product_locations`). products.quantita_disponibile è sempre il TOTALE e
// products.locazione un riepilogo testuale degli scaffali: entrambi li aggiorna il
// database da solo. Nel codice, ogni articolo letto porta `locations`:
// [{ id, locazione, quantita }], ordinate per scaffale (senza scaffale in fondo).
const PRODUCT_SELECT = '*, product_locations(id, locazione, quantita)';

const shelfCompare = (a, b) =>
  (a.locazione == null) - (b.locazione == null) ||
  String(a.locazione || '').localeCompare(String(b.locazione || ''), 'it', { numeric: true, sensitivity: 'base' });

/** Scaffali di un articolo: sempre un array, anche per articoli letti dalla cache di prima della gestione multi-scaffale */
export function getProductLocations(p) {
  if (Array.isArray(p?.locations)) return p.locations;
  const locazione = (p?.locazione || '').trim() || null;
  return [{ id: null, locazione, quantita: p?.quantita_disponibile || 0 }];
}

/** Trasforma una riga letta dal database (con product_locations incorporate) nell'articolo usato dall'app */
function normalizeProduct(row) {
  if (!row) return row;
  const { product_locations: embedded, ...p } = row;
  const raw = Array.isArray(embedded) ? embedded : Array.isArray(p.locations) ? p.locations : null;
  p.locations = raw
    ? raw.map((l) => ({ id: l.id ?? null, locazione: l.locazione || null, quantita: l.quantita || 0 })).sort(shelfCompare)
    : getProductLocations(p);
  return p;
}

export async function listProducts({ search = '', onlyLowStock = false, categoria = null } = {}) {
  let query = supabase.from('products').select(PRODUCT_SELECT).order('codice_articolo', { ascending: true });

  if (categoria) query = query.eq('categoria', categoria);
  if (search) {
    // `locazione` è il riepilogo testuale degli scaffali: cercare "SB002" trova anche gli articoli che ci stanno insieme ad altri scaffali
    query = query.or(
      `codice_articolo.ilike.%${search}%,codice_barre.ilike.%${search}%,locazione.ilike.%${search}%,punto_utilizzo_standard.ilike.%${search}%,macchina.ilike.%${search}%`
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  const list = data.map(normalizeProduct);
  cacheProductsList(list);
  // La scorta minima vale sul totale di tutti gli scaffali (quantita_disponibile è il totale)
  if (onlyLowStock) return list.filter((p) => p.quantita_disponibile < p.scorta_minima);
  return list;
}

export async function getProductByBarcode(codiceBarre) {
  const { data, error } = await supabase.rpc('get_product_by_barcode', {
    p_codice_barre: codiceBarre,
  });
  if (error) throw error;
  const row = data?.[0] ?? null;
  if (!row) return null;
  const { data: locs, error: locErr } = await supabase
    .from('product_locations')
    .select('id, locazione, quantita')
    .eq('product_id', row.id);
  if (locErr) throw locErr;
  const product = normalizeProduct({ ...row, product_locations: locs });
  cacheProductsList([product]);
  return product;
}

export async function getProductById(id) {
  const { data, error } = await supabase.from('products').select(PRODUCT_SELECT).eq('id', id).single();
  if (error) throw error;
  return normalizeProduct(data);
}

/**
 * Sostituisce gli scaffali di un articolo con l'elenco dato (solo admin, in modo atomico):
 * quelli presenti si aggiornano, i nuovi si aggiungono, quelli non più in elenco si tolgono.
 * @param {string} productId
 * @param {{locazione: string|null, quantita: number}[]} locations
 */
export async function setProductLocations(productId, locations) {
  const rows = (locations || []).map((l) => ({
    locazione: (l.locazione || '').trim() || null,
    quantita: Math.max(0, parseInt(l.quantita, 10) || 0),
  }));
  const { error } = await supabase.rpc('set_product_locations', { p_product_id: productId, p_rows: rows });
  if (error) throw error;
}

// Giacenza totale e riepilogo scaffali di `products` li gestisce il database a partire dagli
// scaffali: i campi `locazione` / `quantita_disponibile` non si scrivono più direttamente.
function withoutStockColumns(row) {
  const { locazione, quantita_disponibile, locations, product_locations, ...rest } = row || {};
  return { rest, locazione, quantita_disponibile };
}

/**
 * Crea un articolo. `locations` = scaffali con quantità; se manca, si usano (per compatibilità)
 * gli eventuali `locazione` / `quantita_disponibile` presenti nell'articolo.
 */
export async function createProduct(product, locations = null) {
  const { rest, locazione, quantita_disponibile } = withoutStockColumns(product);
  const locs =
    locations ?? (locazione || quantita_disponibile ? [{ locazione: locazione || null, quantita: quantita_disponibile || 0 }] : []);
  const { data, error } = await supabase.from('products').insert(rest).select('id').single();
  if (error) throw error;
  try {
    await setProductLocations(data.id, locs);
  } catch (err) {
    // Articolo senza i suoi scaffali = dati incompleti: lo si toglie e si segnala l'errore
    await supabase.from('products').delete().eq('id', data.id);
    throw err;
  }
  return getProductById(data.id);
}

export async function updateProduct(id, patch, locations = null) {
  const { rest } = withoutStockColumns(patch);
  if (Object.keys(rest).length) {
    const { error } = await supabase.from('products').update(rest).eq('id', id).select('id').single();
    if (error) throw error;
  }
  if (locations) await setProductLocations(id, locations);
  return getProductById(id);
}

export async function deleteProduct(id) {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Importa/aggiorna in massa gli articoli di una categoria (upsert su
 * categoria + codice_articolo) tramite la funzione SQL bulk_upsert_products.
 * @param {'cuscinetti'|'cinghie'|'pezzi_ricambio'} categoria
 * @param {object[]} rows righe già mappate ai campi della tabella products
 */
export async function bulkUpsertProducts(categoria, rows) {
  const { data, error } = await supabase.rpc('bulk_upsert_products', {
    p_categoria: categoria,
    p_rows: rows,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

// --- MACCHINE --------------------------------------------------
// Le macchine si registrano nella tabella `machines` (vedi sql/create_machines_table.sql).
// products.macchina resta un testo libero: le macchine "storiche" usate solo dagli articoli
// continuano a comparire negli elenchi anche se non sono (ancora) nella tabella.

/** Toglie spazi doppi e ai bordi dal nome di una macchina */
export function normalizeMachineName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

/** True se l'errore indica che la tabella `machines` non esiste (ancora) sul database */
function isMissingMachinesTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || /machines/.test(msg) && /schema cache|does not exist/i.test(msg);
}

/** Elenco delle macchine (tabella `machines` + valori già usati dagli articoli), per la tendina del form articolo e i filtri */
export async function listDistinctMacchine() {
  const byKey = new Map(); // chiave minuscola -> nome (vince la forma scritta nella tabella)
  const registered = await supabase.from('machines').select('nome');
  if (!registered.error) {
    registered.data.forEach((r) => {
      const n = normalizeMachineName(r.nome);
      if (n) byKey.set(n.toLowerCase(), n);
    });
  } else if (!isMissingMachinesTable(registered.error)) {
    throw registered.error;
  }
  const { data, error } = await supabase.from('products').select('macchina').not('macchina', 'is', null);
  if (error) throw error;
  data.forEach((r) => {
    const n = normalizeMachineName(r.macchina);
    if (n && !byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n);
  });
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, 'it'));
}

/**
 * Macchine con il numero di articoli associati, per la gestione in Impostazioni.
 * @returns {Promise<{machines: {id: string|null, nome: string, articoli: number}[], tableMissing: boolean}>}
 */
export async function listMachinesWithCounts() {
  const [registered, products] = await Promise.all([
    supabase.from('machines').select('id, nome'),
    supabase.from('products').select('macchina').not('macchina', 'is', null),
  ]);
  if (products.error) throw products.error;
  const tableMissing = !!registered.error && isMissingMachinesTable(registered.error);
  if (registered.error && !tableMissing) throw registered.error;

  const byKey = new Map();
  const add = (raw, countIt, id = null) => {
    const nome = normalizeMachineName(raw);
    if (!nome) return;
    const key = nome.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { id, nome, articoli: 0 });
    if (id && !byKey.get(key).id) byKey.get(key).id = id;
    if (countIt) byKey.get(key).articoli += 1;
  };
  (registered.data || []).forEach((r) => add(r.nome, false, r.id));
  products.data.forEach((r) => add(r.macchina, true));
  const machines = Array.from(byKey.values()).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  return { machines, tableMissing };
}

/** Aggiunge una macchina alla tabella (solo admin: lo garantisce anche il database con la RLS) */
export async function createMachine(nome) {
  const clean = normalizeMachineName(nome);
  if (!clean) throw new Error('Scrivi il nome della macchina.');
  if (clean.length > 60) throw new Error('Il nome è troppo lungo (massimo 60 caratteri).');
  const { data, error } = await supabase.from('machines').insert({ nome: clean }).select('id, nome').single();
  if (error) {
    if (error.code === '23505') throw new Error(`La macchina "${clean}" è già presente.`);
    if (error.code === '42501') throw new Error('Solo un amministratore può aggiungere macchine.');
    if (isMissingMachinesTable(error)) {
      throw new Error('La tabella delle macchine non è ancora stata creata sul database (vedi sql/create_machines_table.sql).');
    }
    throw error;
  }
  return data;
}

/**
 * Rimuove una macchina: la toglie dalla tabella e svuota il campo "macchina" degli articoli che la usavano
 * (confronto senza maiuscole/spazi), altrimenti continuerebbe a comparire negli elenchi.
 * @param {{ id: string|null, nome: string }} machine
 * @returns {Promise<{ articoliSvuotati: number }>}
 */
export async function deleteMachine({ id, nome }) {
  const key = normalizeMachineName(nome).toLowerCase();

  // 1) dalla tabella. Con la RLS un utente non admin non riceve un errore ma 0 righe: si controlla.
  if (id) {
    const { data, error } = await supabase.from('machines').delete().eq('id', id).select('id');
    if (error) {
      if (isMissingMachinesTable(error)) throw new Error('La tabella delle macchine non esiste ancora sul database.');
      throw error;
    }
    if (!data || data.length === 0) throw new Error('Non è stato possibile rimuovere la macchina (solo un amministratore può farlo).');
  }

  // 2) dagli articoli che la usavano
  const { data: rows, error: readErr } = await supabase.from('products').select('id, macchina').not('macchina', 'is', null);
  if (readErr) throw readErr;
  const ids = rows.filter((r) => normalizeMachineName(r.macchina).toLowerCase() === key).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await supabase.from('products').update({ macchina: null }).in('id', ids.slice(i, i + 100));
    if (error) throw error;
  }
  return { articoliSvuotati: ids.length };
}

// --- SCAFFALI --------------------------------------------------
// Stessa logica delle macchine (tabella `shelves`): il nome dello scaffale degli articoli resta
// testo libero (tabella `product_locations`, una riga per articolo e scaffale), gli scaffali
// "storici" usati solo dagli articoli continuano a comparire negli elenchi anche se non sono
// (ancora) nella tabella `shelves`.

/** True se l'errore indica che la tabella `shelves` non esiste (ancora) sul database */
function isMissingShelvesTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || (/shelves/.test(msg) && /schema cache|does not exist/i.test(msg));
}

/** Elenco degli scaffali (tabella `shelves` + valori già usati dagli articoli), per la tendina del form articolo */
export async function listDistinctLocazioni() {
  const byKey = new Map(); // chiave minuscola -> nome (vince la forma scritta nella tabella)
  const registered = await supabase.from('shelves').select('nome');
  if (!registered.error) {
    registered.data.forEach((r) => {
      const n = normalizeMachineName(r.nome);
      if (n) byKey.set(n.toLowerCase(), n);
    });
  } else if (!isMissingShelvesTable(registered.error)) {
    throw registered.error;
  }
  const { data, error } = await supabase.from('product_locations').select('locazione').not('locazione', 'is', null);
  if (error) throw error;
  data.forEach((r) => {
    const n = normalizeMachineName(r.locazione);
    if (n && !byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n);
  });
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' }));
}

/**
 * Scaffali con il numero di articoli associati, per la gestione in Impostazioni.
 * @returns {Promise<{shelves: {id: string|null, nome: string, articoli: number}[], tableMissing: boolean}>}
 */
export async function listShelvesWithCounts() {
  const [registered, products] = await Promise.all([
    supabase.from('shelves').select('id, nome'),
    supabase.from('product_locations').select('locazione').not('locazione', 'is', null),
  ]);
  if (products.error) throw products.error;
  const tableMissing = !!registered.error && isMissingShelvesTable(registered.error);
  if (registered.error && !tableMissing) throw registered.error;

  const byKey = new Map();
  const add = (raw, countIt, id = null) => {
    const nome = normalizeMachineName(raw);
    if (!nome) return;
    const key = nome.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { id, nome, articoli: 0 });
    if (id && !byKey.get(key).id) byKey.get(key).id = id;
    if (countIt) byKey.get(key).articoli += 1;
  };
  (registered.data || []).forEach((r) => add(r.nome, false, r.id));
  products.data.forEach((r) => add(r.locazione, true));
  const shelves = Array.from(byKey.values()).sort((a, b) => a.nome.localeCompare(b.nome, 'it', { numeric: true, sensitivity: 'base' }));
  return { shelves, tableMissing };
}

export async function createShelf(nome) {
  const clean = normalizeMachineName(nome);
  if (!clean) throw new Error('Scrivi il nome dello scaffale.');
  if (clean.length > 60) throw new Error('Il nome è troppo lungo (massimo 60 caratteri).');
  const { data, error } = await supabase.from('shelves').insert({ nome: clean }).select('id, nome').single();
  if (error) {
    if (error.code === '23505') throw new Error(`Lo scaffale "${clean}" è già presente.`);
    if (error.code === '42501') throw new Error('Solo un amministratore può aggiungere scaffali.');
    if (isMissingShelvesTable(error)) {
      throw new Error('La tabella degli scaffali non è ancora stata creata sul database (vedi sql/create_shelves_table.sql).');
    }
    throw error;
  }
  return data;
}

/**
 * Rimuove uno scaffale: lo toglie dalla tabella e lo toglie dagli articoli che lo usavano
 * (confronto senza maiuscole/spazi), che restano con la loro quantità ma senza scaffale.
 * @param {{ id: string|null, nome: string }} shelf
 * @returns {Promise<{ articoliSvuotati: number }>}
 */
export async function deleteShelf({ id, nome }) {
  if (id) {
    const { data, error } = await supabase.from('shelves').delete().eq('id', id).select('id');
    if (error) {
      if (isMissingShelvesTable(error)) throw new Error('La tabella degli scaffali non esiste ancora sul database.');
      throw error;
    }
    if (!data || data.length === 0) throw new Error('Non è stato possibile rimuovere lo scaffale (solo un amministratore può farlo).');
  }

  // Gli articoli che stavano su questo scaffale restano con la loro quantità, ma senza scaffale
  // (se avevano già una riga "senza scaffale" le quantità si sommano). Lo fa il database, in blocco.
  const { data: articoli, error } = await supabase.rpc('remove_shelf_assignments', { p_nome: nome });
  if (error) throw error;
  return { articoliSvuotati: Number(articoli) || 0 };
}

// --- MANUALI RICAMBI (PDF allegati alle macchine) -----------------
// Un manuale per ogni coppia macchina+linea (tabella `machine_manuals`,
// vincolo UNIQUE su machine_id+linea): un nuovo upload sulla stessa coppia
// sostituisce il precedente. linea = '' significa "generale" (vale per
// tutte le linee di quella macchina, usato come ripiego se non esiste un
// manuale specifico per la linea del pezzo). Il file vero e proprio vive
// nel bucket privato `manuali-macchine` dello Storage; l'apertura in app
// passa sempre da un URL firmato a tempo (mai pubblico).
const MANUALS_BUCKET = 'manuali-macchine';

/** True se l'errore indica che la tabella `machine_manuals` non esiste (ancora) sul database */
function isMissingManualsTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || (/machine_manuals/.test(msg) && /schema cache|does not exist/i.test(msg));
}

/**
 * Elenco di tutti i manuali caricati (una riga per ogni coppia macchina+linea),
 * per sapere a colpo d'occhio quali sono già presenti (Impostazioni e scheda
 * articolo in Ricambi tecnici).
 * @returns {Promise<{ manuals: Array<{id:string, machine_id:string, linea:string, file_name:string, storage_path:string, created_at:string, machines:{nome:string}}>, tableMissing: boolean }>}
 */
export async function listMachineManuals() {
  const { data, error } = await supabase
    .from('machine_manuals')
    .select('id, machine_id, linea, file_name, storage_path, file_size, created_at, machines(nome)');
  if (error) {
    if (isMissingManualsTable(error)) return { manuals: [], tableMissing: true };
    throw error;
  }
  return { manuals: (data || []).map((r) => ({ ...r, bucket: MANUALS_BUCKET })), tableMissing: false };
}

// --- UPLOAD CON AVANZAMENTO ------------------------------------------------
// supabase-js non espone l'avanzamento dell'upload (usa fetch): qui si invia lo
// stesso file con XMLHttpRequest verso l'endpoint Storage, così si può
// riportare la percentuale. Stessa autenticazione e stesse policy RLS.
async function uploadWithProgress(bucket, storagePath, file, { contentType, onProgress } = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || SUPABASE_ANON_KEY;
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`;
  const form = new FormData();
  form.append('cacheControl', '3600');
  form.append('', contentType && file.type !== contentType ? new Blob([file], { type: contentType }) : file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      let message = `Caricamento non riuscito (errore ${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText);
        message = body.message || body.error || message;
      } catch (err) {
        /* risposta non JSON: resta il messaggio generico */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('Connessione assente o interrotta durante il caricamento.'));
    xhr.onabort = () => reject(new Error('Caricamento annullato.'));
    xhr.send(form);
  });
}

/**
 * Carica (o sostituisce) il manuale PDF di una macchina per una specifica
 * linea (o generale, se `linea` è vuota/omessa): rimuove prima l'eventuale
 * file/riga precedente della stessa coppia macchina+linea, poi carica il
 * nuovo file nello Storage e registra la riga in `machine_manuals`. Solo
 * admin (RLS + policy Storage).
 * @param {string} machineId
 * @param {string} linea es. 'L1', 'L2', 'L1-L2', oppure '' per "generale"
 * @param {File} file
 * @param {(percent:number)=>void} [onProgress] avanzamento dell'upload, da 0 a 100
 */
export async function uploadMachineManual(machineId, linea, file, onProgress) {
  if (!file) throw new Error('Nessun file selezionato.');
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Il manuale deve essere un file PDF.');
  }
  const lineaValue = linea || '';

  // Rimuove l'eventuale manuale precedente della stessa coppia macchina+linea (vincolo 1:1)
  const { data: existing } = await supabase
    .from('machine_manuals')
    .select('id, storage_path')
    .eq('machine_id', machineId)
    .eq('linea', lineaValue)
    .maybeSingle();
  if (existing) {
    await supabase.storage.from(MANUALS_BUCKET).remove([existing.storage_path]);
    await supabase.from('machine_manuals').delete().eq('id', existing.id);
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${machineId}/${lineaValue || 'generale'}/${Date.now()}_${safeName}`;
  let uploadErr = null;
  try {
    await uploadWithProgress(MANUALS_BUCKET, storagePath, file, { contentType: 'application/pdf', onProgress });
  } catch (err) {
    uploadErr = err;
  }
  if (uploadErr) {
    if (/row-level security|not allowed|permission/i.test(uploadErr.message || '')) {
      throw new Error('Solo un amministratore può caricare i manuali.');
    }
    throw uploadErr;
  }

  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('machine_manuals')
    .insert({
      machine_id: machineId,
      linea: lineaValue,
      file_name: file.name,
      storage_path: storagePath,
      file_size: file.size,
      uploaded_by: userData?.user?.id || null,
    })
    .select()
    .single();
  if (error) {
    // Se la riga non si registra, il file resta orfano: lo si toglie subito dallo Storage.
    await supabase.storage.from(MANUALS_BUCKET).remove([storagePath]);
    if (isMissingManualsTable(error)) {
      throw new Error('La tabella dei manuali non è ancora stata creata sul database.');
    }
    throw error;
  }
  return data;
}

/** Elimina il manuale di una macchina (file + riga). Solo admin. */
export async function deleteMachineManual(manual) {
  const { error: storageErr } = await supabase.storage.from(MANUALS_BUCKET).remove([manual.storage_path]);
  if (storageErr) throw storageErr;
  const { error } = await supabase.from('machine_manuals').delete().eq('id', manual.id);
  if (error) throw error;
}

/**
 * URL firmato temporaneo (1 ora) per aprire/scaricare il PDF dal bucket
 * privato — mai un URL pubblico permanente. `bucket` distingue tra manuali
 * ricambi (manuali-macchine, default) e manuali operatore (manuali-operatore).
 */
export async function getManualSignedUrl(storagePath, bucket = MANUALS_BUCKET) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

// --- MANUALI OPERATORE (PDF allegati alle macchine, PIÙ di uno per macchina) ---
// A differenza di machine_manuals (1 manuale ricambi per coppia macchina+linea),
// qui non c'è alcun vincolo di unicità: un Admin può caricarne quanti vuole per
// macchina (es. uso e manutenzione, sicurezza, avviamento…). Bucket separato,
// stesso livello di privacy (URL firmati, mai pubblico).
const OPERATOR_MANUALS_BUCKET = 'manuali-operatore';

function isMissingOperatorManualsTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || (/machine_operator_manuals/.test(msg) && /schema cache|does not exist/i.test(msg));
}

/**
 * Elenco di tutti i manuali operatore caricati, per popolare la cache condivisa
 * (manuals.js) usata da Impostazioni → Gestione macchine e dalla vista Manuali.
 * @returns {Promise<{ manuals: Array<{id:string, machine_id:string, file_name:string, storage_path:string, created_at:string, bucket:string, machines:{nome:string}}>, tableMissing: boolean }>}
 */
export async function listOperatorManuals() {
  const { data, error } = await supabase
    .from('machine_operator_manuals')
    .select('id, machine_id, file_name, storage_path, file_size, created_at, machines(nome)')
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingOperatorManualsTable(error)) return { manuals: [], tableMissing: true };
    throw error;
  }
  return { manuals: (data || []).map((r) => ({ ...r, bucket: OPERATOR_MANUALS_BUCKET })), tableMissing: false };
}

/** Carica un nuovo manuale operatore per una macchina (si aggiunge agli altri, non li sostituisce). Solo admin. */
export async function uploadOperatorManual(machineId, file, onProgress) {
  if (!file) throw new Error('Nessun file selezionato.');
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Il manuale deve essere un file PDF.');
  }
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${machineId}/${Date.now()}_${safeName}`;
  let uploadErr = null;
  try {
    await uploadWithProgress(OPERATOR_MANUALS_BUCKET, storagePath, file, { contentType: 'application/pdf', onProgress });
  } catch (err) {
    uploadErr = err;
  }
  if (uploadErr) {
    if (/row-level security|not allowed|permission/i.test(uploadErr.message || '')) {
      throw new Error('Solo un amministratore può caricare i manuali.');
    }
    throw uploadErr;
  }

  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('machine_operator_manuals')
    .insert({
      machine_id: machineId,
      file_name: file.name,
      storage_path: storagePath,
      file_size: file.size,
      uploaded_by: userData?.user?.id || null,
    })
    .select()
    .single();
  if (error) {
    await supabase.storage.from(OPERATOR_MANUALS_BUCKET).remove([storagePath]);
    if (isMissingOperatorManualsTable(error)) {
      throw new Error('La tabella dei manuali operatore non è ancora stata creata sul database.');
    }
    throw error;
  }
  return { ...data, bucket: OPERATOR_MANUALS_BUCKET };
}

/** Elimina un manuale operatore (file + riga). Solo admin. */
export async function deleteOperatorManual(manual) {
  const { error: storageErr } = await supabase.storage.from(OPERATOR_MANUALS_BUCKET).remove([manual.storage_path]);
  if (storageErr) throw storageErr;
  const { error } = await supabase.from('machine_operator_manuals').delete().eq('id', manual.id);
  if (error) throw error;
}

// --- SEZIONI/PULSANTI DEL MANUALE OPERATORE (indice per intervallo di pagine) ---
// Ogni riga è un pulsante che l'Admin definisce ("Mettifoglio", "Squadratura"…),
// legato a UN manuale operatore preciso e a un intervallo di pagine al suo interno.
// Le icone vivono in un bucket pubblico separato (sono solo grafiche, non documenti).
const SECTION_ICONS_BUCKET = 'manuali-sezioni-icone';

function isMissingSectionsTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || (/machine_manual_sections/.test(msg) && /schema cache|does not exist/i.test(msg));
}

/**
 * Elenco di tutte le sezioni/pulsanti definiti, per popolare la cache condivisa (manuals.js).
 * @returns {Promise<{ sections: Array<{id:string, machine_id:string, operator_manual_id:string, label:string, icon_storage_path:string|null, page_start:number, page_end:number, sort_order:number}>, tableMissing: boolean }>}
 */
export async function listManualSections() {
  const { data, error } = await supabase
    .from('machine_manual_sections')
    .select('id, machine_id, operator_manual_id, label, icon_storage_path, page_start, page_end, sort_order, group_id')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingSectionsTable(error)) return { sections: [], tableMissing: true };
    throw error;
  }
  return { sections: data || [], tableMissing: false };
}

/** Carica l'icona di un pulsante nel bucket pubblico e restituisce il suo storage_path. Solo admin. */
export async function uploadSectionIcon(file, onProgress) {
  if (!file) return null;
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${Date.now()}_${safeName}`;
  let error = null;
  try {
    await uploadWithProgress(SECTION_ICONS_BUCKET, storagePath, file, { onProgress });
  } catch (err) {
    error = err;
  }
  if (error) {
    if (/row-level security|not allowed|permission/i.test(error.message || '')) {
      throw new Error('Solo un amministratore può caricare le icone.');
    }
    throw error;
  }
  return storagePath;
}

/** URL pubblico (permanente, il bucket delle icone non è privato) di un'icona. */
export function getSectionIconUrl(storagePath) {
  if (!storagePath) return null;
  const { data } = supabase.storage.from(SECTION_ICONS_BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

/** Crea un nuovo pulsante/sezione per un manuale operatore. Solo admin. */
export async function createManualSection({ machineId, operatorManualId, label, iconStoragePath, pageStart, pageEnd, sortOrder, groupId }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('machine_manual_sections')
    .insert({
      machine_id: machineId,
      operator_manual_id: operatorManualId,
      label,
      icon_storage_path: iconStoragePath || null,
      page_start: pageStart,
      page_end: pageEnd,
      sort_order: sortOrder ?? 0,
      group_id: groupId || null,
      created_by: userData?.user?.id || null,
    })
    .select()
    .single();
  if (error) {
    if (isMissingSectionsTable(error)) {
      throw new Error('La tabella delle sezioni non è ancora stata creata sul database.');
    }
    throw error;
  }
  return data;
}

/** Elimina un pulsante/sezione (e la sua icona, se presente). Solo admin. */
export async function deleteManualSection(section) {
  if (section.icon_storage_path) {
    await supabase.storage.from(SECTION_ICONS_BUCKET).remove([section.icon_storage_path]);
  }
  const { error } = await supabase.from('machine_manual_sections').delete().eq('id', section.id);
  if (error) throw error;
}

/**
 * Salva in blocco il nuovo ordine dei pulsanti di una macchina dopo un riordino via
 * trascinamento: `orderedIds` è l'elenco degli id nel nuovo ordine, a cui viene
 * assegnato sort_order 0,1,2... in sequenza. Le policy RLS in scrittura sono solo
 * admin, quindi un operatore che provasse comunque la chiamata la vedrebbe rifiutata.
 */
export async function updateManualSectionsOrder(orderedIds) {
  const results = await Promise.all(
    orderedIds.map((id, index) => supabase.from('machine_manual_sections').update({ sort_order: index }).eq('id', id))
  );
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error;
}

/**
 * Aggiorna un pulsante/sezione esistente (stessa schermata usata per crearlo). Solo admin.
 * Se `newIconStoragePath` è presente (l'admin ha scelto una nuova icona), sostituisce anche
 * il file precedente (`previousIconStoragePath`), eliminandolo dallo storage.
 */
export async function updateManualSection(sectionId, { operatorManualId, label, pageStart, pageEnd, newIconStoragePath, previousIconStoragePath, groupId }) {
  const patch = {
    operator_manual_id: operatorManualId,
    label,
    page_start: pageStart,
    page_end: pageEnd,
  };
  if (newIconStoragePath !== undefined) patch.icon_storage_path = newIconStoragePath;
  if (groupId !== undefined) patch.group_id = groupId || null; // undefined = invariato, null/'' = nessun gruppo

  const { data, error } = await supabase.from('machine_manual_sections').update(patch).eq('id', sectionId).select().single();
  if (error) {
    if (isMissingSectionsTable(error)) throw new Error('La tabella delle sezioni non è ancora stata creata sul database.');
    throw error;
  }
  if (newIconStoragePath !== undefined && previousIconStoragePath && previousIconStoragePath !== newIconStoragePath) {
    await supabase.storage.from(SECTION_ICONS_BUCKET).remove([previousIconStoragePath]);
  }
  return data;
}


// --- GRUPPI DI PIASTRELLE (macrogruppi mostrati come tab nella vista Manuali) ---

/** Elenco di tutti i gruppi di tutte le macchine, per la cache condivisa (manuals-data.js). Se la tabella manca, restituisce un elenco vuoto. */
export async function listManualGroups() {
  const { data, error } = await supabase
    .from('machine_manual_groups')
    .select('id, machine_id, name, sort_order')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return { groups: [], tableMissing: true };
    throw error;
  }
  return { groups: data || [], tableMissing: false };
}

/** Crea un gruppo per una macchina. Solo admin. */
export async function createManualGroup({ machineId, name, sortOrder }) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('machine_manual_groups')
    .insert({ machine_id: machineId, name, sort_order: sortOrder ?? 0, created_by: userData?.user?.id || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Rinomina un gruppo. Solo admin. */
export async function updateManualGroup(groupId, { name }) {
  const { data, error } = await supabase.from('machine_manual_groups').update({ name }).eq('id', groupId).select().single();
  if (error) throw error;
  return data;
}

/** Elimina un gruppo: le sue piastrelle non vengono toccate, restano senza gruppo (campo group_id azzerato dal database). Solo admin. */
export async function deleteManualGroup(groupId) {
  const { error } = await supabase.from('machine_manual_groups').delete().eq('id', groupId);
  if (error) throw error;
}

/** Salva l'ordine dei gruppi di una macchina: sort_order 0,1,2... nell'ordine degli id ricevuti. Solo admin. */
export async function updateManualGroupsOrder(orderedIds) {
  const results = await Promise.all(
    orderedIds.map((id, index) => supabase.from('machine_manual_groups').update({ sort_order: index }).eq('id', id))
  );
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error;
}


// --- TRANSAZIONI (deposito/prelievo) ------------------------------
/**
 * Esegue in modo atomico deposito o prelievo tramite la funzione SQL
 * process_transaction (SECURITY DEFINER): aggiorna la giacenza e
 * registra il log in una singola transazione DB.
 */
export async function processTransaction({ productId, tipo, quantita, puntoUtilizzo, note, linea, macchinario, locationId }) {
  const params = {
    p_product_id: productId,
    p_tipo: tipo,
    p_quantita: quantita,
    p_punto_utilizzo: puntoUtilizzo || null,
    p_note: note || null,
  };
  // Linea e macchinario si inviano solo se presenti (prelievi): i depositi restano identici a prima.
  if (linea) params.p_linea = linea;
  if (macchinario) params.p_macchinario = macchinario;
  // Scaffale del movimento: obbligatorio per gli articoli su più scaffali, ininfluente se ne hanno uno solo
  if (locationId) params.p_location_id = locationId;
  const { data, error } = await supabase.rpc('process_transaction', params);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function listTransactions({ from, to, productId, limit = 200 } = {}) {
  let query = supabase
    .from('transactions')
    .select('id, tipo, quantita, data_ora, punto_utilizzo_specifico, linea, macchinario, locazione, product_id, user_id, products(codice_articolo), profiles(full_name)')
    .order('data_ora', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('data_ora', from);
  if (to) query = query.lte('data_ora', to);
  if (productId) query = query.eq('product_id', productId);

  const { data, error } = await query;
  if (error) throw error;
  return withAdminNames(data);
}

// Un operatore può leggere i movimenti degli admin ma non i loro profili (RLS su profiles):
// l'incorporamento profiles(full_name) torna vuoto per quelle righe. I nomi degli admin
// (solo id e nome) arrivano da una funzione dedicata, letta una volta sola per sessione.
let adminNamesCache = null;
async function getAdminNames() {
  if (adminNamesCache) return adminNamesCache;
  try {
    const { data, error } = await supabase.rpc('admin_display_names');
    if (error) throw error;
    adminNamesCache = new Map((data || []).map((r) => [r.id, r.full_name]));
    return adminNamesCache;
  } catch (err) {
    console.warn('Nomi degli admin non disponibili.', err);
    return new Map(); // non si memorizza il fallimento: alla prossima lettura si riprova
  }
}

async function withAdminNames(rows) {
  if (!rows?.some((r) => r.user_id && !r.profiles)) return rows; // admin: i nomi ci sono già, nessuna chiamata extra
  const names = await getAdminNames();
  return rows.map((r) => (!r.profiles && names.has(r.user_id) ? { ...r, profiles: { full_name: names.get(r.user_id) } } : r));
}

/**
 * Tutti i prelievi (senza limite di periodo) per calcolare la vita utile dei ricambi.
 * Legge a pagine da 1000 righe, dal più vecchio al più recente.
 */
export async function listPrelieviForLifespan() {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, quantita, data_ora, punto_utilizzo_specifico, linea, macchinario, product_id, products(codice_articolo, categoria)')
      .eq('tipo', 'prelievo')
      .order('data_ora', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/**
 * Elimina permanentemente TUTTI i movimenti (depositi/prelievi) di TUTTI
 * gli articoli, senza eccezioni. Non tocca la giacenza attuale sui
 * products: rimuove solo il log storico. Azione riservata a Impostazioni
 * (solo admin) — irreversibile, va confermata esplicitamente dal chiamante.
 */
export async function deleteAllTransactions() {
  // "not is null" sull'id (chiave primaria, mai nulla) equivale a "tutte le
  // righe": il client Supabase richiede comunque un filtro esplicito, non
  // accetta un .delete() completamente senza condizioni.
  const { error } = await supabase.from('transactions').delete().not('id', 'is', null);
  if (error) throw error;
}

/** Elimina uno o più movimenti specifici dallo storico (per la Gestione cronologia in Impostazioni). Non tocca la giacenza. */
export async function deleteTransactions(ids) {
  if (!ids?.length) return;
  const { error } = await supabase.from('transactions').delete().in('id', ids);
  if (error) throw error;
}

/** Aggregazione consumi (prelievi) per articolo, lato client su dataset filtrato */
export async function getConsumptionStats({ from, to } = {}) {
  const rows = await listTransactions({ from, to, limit: 2000 });
  const prelievi = rows.filter((r) => r.tipo === 'prelievo');
  const byProduct = new Map();
  for (const r of prelievi) {
    const key = r.product_id;
    const cur = byProduct.get(key) || {
      product_id: key,
      codice_articolo: r.products?.codice_articolo || '—',
      totale: 0,
    };
    cur.totale += r.quantita;
    byProduct.set(key, cur);
  }
  return Array.from(byProduct.values()).sort((a, b) => b.totale - a.totale);
}
