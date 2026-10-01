// =============================================================
// products-shared.js — Stato, costanti e utility condivise tra i moduli
// di Magazzino (products.js, products-list.js, products-data.js,
// products-detail.js). Nessuna logica qui dentro: solo ciò che più file
// devono poter leggere (e in alcuni casi scrivere) in comune.
//
// `els` e `state` sono oggetti: un file può sempre scriverne una proprietà
// (`state.currentCategory = 'x'`) anche se li ha solo importati — è la
// riassegnazione della variabile stessa (`state = {...}`) a non essere
// permessa tra moduli. Per questo le variabili condivise tra file sono
// proprietà di questo unico oggetto invece di normali `let` sparse.
// =============================================================

import { getProductLocations } from './supabase.js';

export const els = {};

export const state = {
  currentCategory: 'cuscinetti',
  currentList: [], // ultimo elenco caricato dal database (products-data.js), letto da products-list.js
  lineaFilterValue: '',
  macchinaFilterValue: '',
};

export const CATEGORY_LABELS = {
  cuscinetti: 'Cuscinetti',
  cinghie: 'Cinghie',
  pezzi_ricambio: 'Ricambi tecnici',
};

export const LINEA_OPTIONS = ['L1', 'L2', 'L1-L2'];

// Il selettore Scaffalatura/Macchina e il riordino per macchina hanno senso solo dove
// l'articolo è davvero legato a una macchina specifica: cinghie e pezzi di ricambio. I
// cuscinetti sono stock generico: mostrano sempre e solo la scaffalatura, senza selettore.
export const MACHINE_VIEW_CATEGORIES = ['cinghie', 'pezzi_ricambio'];

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Scaffali di un articolo come testo breve: "SA001" se è su uno scaffale solo,
 * "SA001 (3) · SB002 (5)" se è su più scaffali (tra parentesi la quantità di ciascuno).
 */
export function shelfLabel(p) {
  const locs = getProductLocations(p).filter((l) => l.locazione);
  if (locs.length > 1) return locs.map((l) => `${l.locazione} (${l.quantita})`).join(' · ');
  return locs[0]?.locazione || '';
}

/** true se l'articolo è presente su più di uno scaffale */
export function hasMultipleShelves(p) {
  return getProductLocations(p).length > 1;
}
