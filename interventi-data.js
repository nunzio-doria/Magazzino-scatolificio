// =============================================================
// interventi-data.js — Dati del Blocco Note Interventi (soste di manutenzione)
// Tabelle: manutenzioni_soste (interventi), interventi_rapidi (preimpostati per
// linea+macchina). Foto nel bucket privato `interventi-foto` (URL firmati).
// Le query stanno qui, in un file a parte, per non toccare il grande supabase.js.
// =============================================================

import { supabase } from './supabase.js';

export const FOTO_BUCKET = 'interventi-foto';
export const LINEE = [
  { value: 'L1', label: 'Linea 1' },
  { value: 'L2', label: 'Linea 2' },
];
export const STATI = {
  da_effettuare: 'Da effettuare',
  sospeso: 'Da completare',
  effettuato: 'Effettuato',
};

export const lineaLabel = (v) => LINEE.find((l) => l.value === v)?.label || v || '';

/** Un intervento rapido vale per la stessa linea e la stessa macchina (senza distinzione di maiuscole) */
export function rapidoMatches(rapido, linea, macchina) {
  if (!linea || !macchina) return false;
  return rapido.linea === linea && (rapido.macchina || '').toLowerCase() === macchina.toLowerCase();
}

function isMissingTable(error) {
  const msg = `${error?.message || ''} ${error?.details || ''}`;
  return error?.code === 'PGRST205' || error?.code === '42P01' || /schema cache|does not exist/i.test(msg);
}

const COLS =
  'id, linea, macchina, descrizione, stato, foto_promemoria_path, note_esito, foto_esito_path, created_by, created_by_name, created_at, esito_by, esito_by_name, esito_at';

/** Interventi aperti (da effettuare + da completare) e ultimi effettuati */
export async function listInterventi() {
  const [open, done] = await Promise.all([
    supabase.from('manutenzioni_soste').select(COLS).in('stato', ['da_effettuare', 'sospeso']).order('created_at', { ascending: false }).limit(500),
    supabase.from('manutenzioni_soste').select(COLS).eq('stato', 'effettuato').order('esito_at', { ascending: false }).limit(300),
  ]);
  const error = open.error || done.error;
  if (error) {
    if (isMissingTable(error)) return { tableMissing: true, open: [], done: [] };
    throw error;
  }
  return { tableMissing: false, open: open.data, done: done.data };
}

/** Interventi effettuati in un intervallo (giornata) — per il PDF */
export async function listEffettuatiRange(fromIso, toIso) {
  const { data, error } = await supabase
    .from('manutenzioni_soste')
    .select(COLS)
    .eq('stato', 'effettuato')
    .gte('esito_at', fromIso)
    .lte('esito_at', toIso)
    .order('esito_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function uploadFoto(blob) {
  const { data: u } = await supabase.auth.getUser();
  const uid = u?.user?.id || 'anon';
  const path = `${uid}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(FOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' });
  if (error) throw error;
  return path;
}

async function removeFoto(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  try {
    await supabase.storage.from(FOTO_BUCKET).remove(list);
  } catch (err) {
    console.warn('Impossibile rimuovere la foto.', err);
  }
}

/** Nuovo intervento (stato iniziale: da effettuare). `foto` = Blob JPEG o null */
export async function createIntervento({ linea, macchina, descrizione, foto = null, authorName = '' }) {
  let path = null;
  if (foto) path = await uploadFoto(foto);
  const { data, error } = await supabase
    .from('manutenzioni_soste')
    .insert({ linea, macchina, descrizione, foto_promemoria_path: path, created_by_name: authorName || null })
    .select(COLS)
    .single();
  if (error) {
    await removeFoto([path]);
    throw error;
  }
  return data;
}

/**
 * Aggiorna l'esito. `foto`: Blob nuovo | null (nessun cambio); `rimuoviFoto`: true per toglierla.
 */
export async function updateEsito(row, { stato, note, foto = null, rimuoviFoto = false, authorName = '' }) {
  let fotoPath = row.foto_esito_path || null;
  let newPath = null;
  if (foto) {
    newPath = await uploadFoto(foto);
    fotoPath = newPath;
  } else if (rimuoviFoto) {
    fotoPath = null;
  }
  const patch = {
    stato,
    note_esito: note || null,
    foto_esito_path: fotoPath,
    esito_by_name: stato === 'da_effettuare' ? null : authorName || null,
    esito_at: stato === 'da_effettuare' ? null : stato === row.stato && row.esito_at ? row.esito_at : new Date().toISOString(),
  };
  if (stato === 'da_effettuare') patch.esito_by = null;
  else {
    const { data: u } = await supabase.auth.getUser();
    patch.esito_by = u?.user?.id || null;
  }
  const { data, error } = await supabase.from('manutenzioni_soste').update(patch).eq('id', row.id).select(COLS).single();
  if (error) {
    await removeFoto([newPath]);
    throw error;
  }
  if ((foto || rimuoviFoto) && row.foto_esito_path && row.foto_esito_path !== fotoPath) await removeFoto([row.foto_esito_path]);
  return data;
}

export async function deleteIntervento(row) {
  const { error } = await supabase.from('manutenzioni_soste').delete().eq('id', row.id);
  if (error) throw error;
  await removeFoto([row.foto_promemoria_path, row.foto_esito_path]);
}

// ---- URL firmati delle foto (1 ora), con cache in memoria ----
const urlCache = new Map(); // path -> { url, exp }
export async function signedUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(Boolean))].filter((p) => !(urlCache.get(p)?.exp > now));
  if (need.length) {
    const { data, error } = await supabase.storage.from(FOTO_BUCKET).createSignedUrls(need, 3600);
    if (error) throw error;
    data.forEach((r) => {
      if (r.signedUrl) urlCache.set(r.path, { url: r.signedUrl, exp: now + 55 * 60 * 1000 });
    });
  }
  const out = {};
  paths.filter(Boolean).forEach((p) => {
    out[p] = urlCache.get(p)?.url || '';
  });
  return out;
}

// ---- Interventi rapidi ----
export async function listRapidi() {
  const { data, error } = await supabase.from('interventi_rapidi').select('id, linea, macchina, titolo').order('titolo', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return { tableMissing: true, rapidi: [] };
    throw error;
  }
  return { tableMissing: false, rapidi: data };
}

export async function createRapido({ linea, macchina, titolo }) {
  const { data, error } = await supabase.from('interventi_rapidi').insert({ linea, macchina, titolo }).select('id, linea, macchina, titolo').single();
  if (error) {
    if (error.code === '23505') throw new Error('Questo intervento rapido esiste già per la stessa linea e macchina.');
    throw error;
  }
  return data;
}

export async function deleteRapido(id) {
  const { error } = await supabase.from('interventi_rapidi').delete().eq('id', id);
  if (error) throw error;
}

const pad2 = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const keyToDate = (k) => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));

/** Giorni (AAAA-MM-GG, ora locale) in cui è stato effettuato almeno un intervento: servono ai pallini blu del calendario */
export async function listEffettuatiDays() {
  const { data, error } = await supabase
    .from('manutenzioni_soste')
    .select('esito_at')
    .eq('stato', 'effettuato')
    .not('esito_at', 'is', null)
    .order('esito_at', { ascending: false })
    .limit(5000);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return [...new Set(data.map((r) => dayKey(new Date(r.esito_at))))];
}
