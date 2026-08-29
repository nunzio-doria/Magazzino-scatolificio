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
    .select('id, full_name, role')
    .eq('id', userData.user.id)
    .single();
  if (error) throw error;
  return { ...data, email: userData.user.email };
}

// --- PRODUCTS ----------------------------------------------------
export async function listProducts({ search = '', onlyLowStock = false, categoria = null } = {}) {
  let query = supabase.from('products').select('*').order('codice_articolo', { ascending: true });

  if (categoria) query = query.eq('categoria', categoria);
  if (search) {
    query = query.or(
      `codice_articolo.ilike.%${search}%,descrizione.ilike.%${search}%,codice_barre.ilike.%${search}%,locazione.ilike.%${search}%`
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  if (onlyLowStock) return data.filter((p) => p.quantita_disponibile < p.scorta_minima);
  return data;
}

export async function getProductByBarcode(codiceBarre) {
  const { data, error } = await supabase.rpc('get_product_by_barcode', {
    p_codice_barre: codiceBarre,
  });
  if (error) throw error;
  return data?.[0] ?? null;
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
    .select('id, tipo, quantita, data_ora, punto_utilizzo_specifico, product_id, user_id, products(codice_articolo, descrizione), profiles(full_name)')
    .order('data_ora', { ascending: false })
    .limit(limit);

  if (from) query = query.gte('data_ora', from);
  if (to) query = query.lte('data_ora', to);
  if (productId) query = query.eq('product_id', productId);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** Aggregazione consumi (prelievi) per articolo, lato client su dataset filtrato */
export async function getConsumptionStats({ from, to } = {}) {
  const rows = await listTransactions({ from, to, limit: 2000 });
  const prelievi = rows.filter((r) => r.tipo === 'prelievo');
  const byProduct = new Map();
  for (const r of prelievi) {
    const key = r.product_id;
    const cur = byProduct.get(key) || {
      codice_articolo: r.products?.codice_articolo || '—',
      descrizione: r.products?.descrizione || '—',
      totale: 0,
    };
    cur.totale += r.quantita;
    byProduct.set(key, cur);
  }
  return Array.from(byProduct.values()).sort((a, b) => b.totale - a.totale);
}
