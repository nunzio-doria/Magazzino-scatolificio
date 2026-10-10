// =============================================================
// punti-utilizzo.js — Punto di utilizzo dei cuscinetti: suggerimenti e confronto tollerante
// Il punto si scrive a mano: per riconoscere lo stesso posto scritto in modi diversi
// (maiuscole, accenti, punteggiatura, spazi) si usa una forma "normalizzata". Nel Prelievo,
// per lo stesso cuscinetto sulla stessa linea e macchina, si propongono i punti già usati.
// =============================================================

import { supabase } from './supabase.js';

/**
 * Forma di confronto: minuscolo, senza accenti né punteggiatura, spazi singoli.
 * "Lato Motore", "lato  motore" e "Lato-motore." risultano lo stesso punto.
 */
export function normPunto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Punti in cui il cuscinetto è già stato montato su quella linea e macchina.
 * Le grafie equivalenti si fondono: si mostra quella usata più spesso (a parità, la più recente).
 * @returns {Promise<{punto:string, volte:number, ultimo:number}[]>} dal più usato al meno usato
 */
export async function listPuntiSuggeriti({ productId, linea, macchinario }) {
  if (!productId || !linea || !macchinario) return [];
  const { data, error } = await supabase.rpc('punti_utilizzo_cuscinetto', {
    p_product_id: productId,
    p_linea: linea,
    p_macchinario: macchinario,
  });
  if (error) throw error;

  const groups = new Map(); // forma normalizzata -> { varianti, volte, ultimo }
  (data || []).forEach((r) => {
    const key = normPunto(r.punto);
    if (!key) return;
    const when = new Date(r.ultimo).getTime();
    const g = groups.get(key) || { variants: [], volte: 0, ultimo: 0 };
    g.variants.push({ punto: r.punto, volte: Number(r.volte), when });
    g.volte += Number(r.volte);
    g.ultimo = Math.max(g.ultimo, when);
    groups.set(key, g);
  });
  return [...groups.values()]
    .map((g) => {
      const best = [...g.variants].sort((a, b) => b.volte - a.volte || b.when - a.when)[0];
      return { punto: best.punto, volte: g.volte, ultimo: g.ultimo };
    })
    .sort((a, b) => b.volte - a.volte || b.ultimo - a.ultimo);
}
