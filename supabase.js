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

export function adjustCachedProductQuantity(id, delta) {
  const cache = loadProductCache();
  const p = cache.byId?.[id];
  if (!p) return;
  p.quantita_disponibile = (p.quantita_disponibile || 0) + delta;
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
export async function listProducts({ search = '', onlyLowStock = false, categoria = null } = {}) {
  let query = supabase.from('products').select('*').order('codice_articolo', { ascending: true });

  if (categoria) query = query.eq('categoria', categoria);
  if (search) {
    query = query.or(
      `codice_articolo.ilike.%${search}%,codice_barre.ilike.%${search}%,locazione.ilike.%${search}%,punto_utilizzo_standard.ilike.%${search}%,macchina.ilike.%${search}%`
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  cacheProductsList(data);
  if (onlyLowStock) return data.filter((p) => p.quantita_disponibile < p.scorta_minima);
  return data;
}

export async function getProductByBarcode(codiceBarre) {
  const { data, error } = await supabase.rpc('get_product_by_barcode', {
    p_codice_barre: codiceBarre,
  });
  if (error) throw error;
  const product = data?.[0] ?? null;
  if (product) cacheProductsList([product]);
  return product;
}

export async function getProductById(id) {
  const { data, error } = await supabase.from('products').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function createProduct(product) {
  const { data, error } = await supabase.from('products').insert(product).select().single();
  if (error) throw error;
  return data;
}

export async function updateProduct(id, patch) {
  const { data, error } = await supabase.from('products').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
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

/**
 * Carica (o sostituisce) il manuale PDF di una macchina per una specifica
 * linea (o generale, se `linea` è vuota/omessa): rimuove prima l'eventuale
 * file/riga precedente della stessa coppia macchina+linea, poi carica il
 * nuovo file nello Storage e registra la riga in `machine_manuals`. Solo
 * admin (RLS + policy Storage).
 * @param {string} machineId
 * @param {string} linea es. 'L1', 'L2', 'L1-L2', oppure '' per "generale"
 * @param {File} file
 */
export async function uploadMachineManual(machineId, linea, file) {
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
  const { error: uploadErr } = await supabase.storage.from(MANUALS_BUCKET).upload(storagePath, file, {
    contentType: 'application/pdf',
    upsert: false,
  });
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
export async function uploadOperatorManual(machineId, file) {
  if (!file) throw new Error('Nessun file selezionato.');
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Il manuale deve essere un file PDF.');
  }
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${machineId}/${Date.now()}_${safeName}`;
  const { error: uploadErr } = await supabase.storage.from(OPERATOR_MANUALS_BUCKET).upload(storagePath, file, {
    contentType: 'application/pdf',
    upsert: false,
  });
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
    .select('id, machine_id, operator_manual_id, label, icon_storage_path, page_start, page_end, sort_order')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (isMissingSectionsTable(error)) return { sections: [], tableMissing: true };
    throw error;
  }
  return { sections: data || [], tableMissing: false };
}

/** Carica l'icona di un pulsante nel bucket pubblico e restituisce il suo storage_path. Solo admin. */
export async function uploadSectionIcon(file) {
  if (!file) return null;
  const safeName = file.name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${Date.now()}_${safeName}`;
  const { error } = await supabase.storage.from(SECTION_ICONS_BUCKET).upload(storagePath, file, { upsert: false });
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
export async function createManualSection({ machineId, operatorManualId, label, iconStoragePath, pageStart, pageEnd, sortOrder }) {
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
 * Aggiorna un pulsante/sezione esistente (stessa schermata usata per crearlo). Solo admin.
 * Se `newIconStoragePath` è presente (l'admin ha scelto una nuova icona), sostituisce anche
 * il file precedente (`previousIconStoragePath`), eliminandolo dallo storage.
 */
export async function updateManualSection(sectionId, { operatorManualId, label, pageStart, pageEnd, newIconStoragePath, previousIconStoragePath }) {
  const patch = {
    operator_manual_id: operatorManualId,
    label,
    page_start: pageStart,
    page_end: pageEnd,
  };
  if (newIconStoragePath !== undefined) patch.icon_storage_path = newIconStoragePath;

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


// --- TRANSAZIONI (deposito/prelievo) ------------------------------
/**
 * Esegue in modo atomico deposito o prelievo tramite la funzione SQL
 * process_transaction (SECURITY DEFINER): aggiorna la giacenza e
 * registra il log in una singola transazione DB.
 */
export async function processTransaction({ productId, tipo, quantita, puntoUtilizzo, note }) {
  const { data, error } = await supabase.rpc('process_transaction', {
    p_product_id: productId,
    p_tipo: tipo,
    p_quantita: quantita,
    p_punto_utilizzo: puntoUtilizzo || null,
    p_note: note || null,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function listTransactions({ from, to, productId, limit = 200 } = {}) {
  let query = supabase
    .from('transactions')
    .select('id, tipo, quantita, data_ora, punto_utilizzo_specifico, product_id, user_id, products(codice_articolo), profiles(full_name)')
    .order('data_ora', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('data_ora', from);
  if (to) query = query.lte('data_ora', to);
  if (productId) query = query.eq('product_id', productId);

  const { data, error } = await query;
  if (error) throw error;
  return data;
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
