// =============================================================
// lifespan.js — Vita utile dei ricambi (sezione del Report)
//
// Regole:
// - Ogni prelievo = una sostituzione (qualunque sia la quantità).
// - Si confronta lo stesso ricambio nello stesso posto:
//     cuscinetti      -> articolo + linea + macchinario + punto di utilizzo
//     cinghie/ricambi -> articolo + linea
// - Durata = giorni tra una sostituzione e la successiva. La "vita media"
//   è la media delle durate PRECEDENTI a quella considerata.
// - Se una sostituzione arriva prima della vita media (con un margine di
//   tolleranza), viene segnalata come "anticipata".
// - Servono almeno 3 prelievi dello stesso ricambio nello stesso posto.
// - I prelievi senza linea (registrati prima di questa funzione) non contano.
// =============================================================

import { listPrelieviForLifespan } from './supabase.js';

const TOLERANCE = 0.1; // anticipata = dura almeno il 10% in meno della media (cambia qui la soglia)
const MERGE_HOURS = 1; // prelievi dello stesso ricambio a meno di 1 ora l'uno dall'altro = stessa sostituzione
const DAY_MS = 86400000;
const MAX_ALERTS = 20;
const MAX_GROUPS = 30;

let el = null;
let lastData = null;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Calcola gruppi, medie e sostituzioni anticipate a partire dai prelievi (ordinati dal più vecchio). */
export function computeLifespan(rows) {
  const groups = new Map();
  let skipped = 0;

  rows.forEach((r) => {
    if (!r.linea) {
      skipped += 1;
      return;
    }
    const bearing = r.products?.categoria === 'cuscinetti';
    const macch = norm(r.macchinario);
    const punto = norm(r.punto_utilizzo_specifico);
    if (bearing && (!macch || !punto)) {
      skipped += 1;
      return;
    }
    const key = bearing ? `${r.product_id}|${r.linea}|${macch}|${punto}` : `${r.product_id}|${r.linea}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, codice: r.products?.codice_articolo || '—', bearing, linea: r.linea, macchinario: '', punto: '', events: [] };
      groups.set(key, g);
    }
    if (bearing) {
      g.macchinario = r.macchinario; // vince l'ultima grafia usata
      g.punto = r.punto_utilizzo_specifico;
    }
    const t = new Date(r.data_ora).getTime();
    const last = g.events[g.events.length - 1];
    if (last !== undefined && t - last < MERGE_HOURS * 3600000) return; // stessa sostituzione registrata due volte
    g.events.push(t);
  });

  const alerts = [];
  const summaries = [];
  groups.forEach((g) => {
    if (g.events.length < 2) return;
    const intervals = [];
    for (let i = 1; i < g.events.length; i++) intervals.push((g.events[i] - g.events[i - 1]) / DAY_MS);

    for (let k = 1; k < intervals.length; k++) {
      const prev = intervals.slice(0, k);
      const avg = mean(prev);
      if (intervals[k] < avg * (1 - TOLERANCE)) {
        alerts.push({ g, date: g.events[k + 1], days: intervals[k], avg, basedOn: prev.length, pct: Math.round((1 - intervals[k] / avg) * 100) });
      }
    }
    const lastAlert = alerts.length && alerts[alerts.length - 1].g === g && alerts[alerts.length - 1].date === g.events[g.events.length - 1];
    summaries.push({
      g,
      replacements: g.events.length,
      avg: mean(intervals),
      lastDays: intervals[intervals.length - 1],
      lastDate: g.events[g.events.length - 1],
      anticipated: !!lastAlert,
    });
  });

  alerts.sort((a, b) => b.date - a.date);
  summaries.sort((a, b) => Number(b.anticipated) - Number(a.anticipated) || b.lastDate - a.lastDate);
  return { alerts, summaries, skipped };
}

function fmtDays(d) {
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} ore`;
  const n = Math.round(d);
  return `${n} ${n === 1 ? 'giorno' : 'giorni'}`;
}
const fmtDate = (t) => new Date(t).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });

function placeLabel(g) {
  const parts = [g.linea];
  if (g.bearing) parts.push(g.macchinario, g.punto);
  return parts.filter(Boolean).map(escapeHtml).join(' · ');
}

function alertRow(a) {
  return `
    <div class="border-l-4 border-rose-600 pl-3 py-1.5">
      <p class="text-sm font-medium text-graphite-100 truncate">${escapeHtml(a.g.codice)}</p>
      <p class="text-xs text-graphite-500 mt-0.5">${placeLabel(a.g)}</p>
      <p class="text-xs mt-1"><span class="font-semibold text-rose-700">Sostituito dopo ${fmtDays(a.days)} · media ${fmtDays(a.avg)} (−${a.pct}%)</span>
        <span class="text-graphite-500"> · il ${fmtDate(a.date)}${a.basedOn === 1 ? ' · media su un solo intervallo' : ''}</span></p>
    </div>`;
}

function summaryRow(s) {
  return `
    <div class="py-2 border-b border-graphite-800 last:border-0">
      <div class="flex items-start justify-between gap-2">
        <p class="text-sm font-medium text-graphite-100 truncate min-w-0">${escapeHtml(s.g.codice)}</p>
        ${s.anticipated ? '<span class="shrink-0 ui-label font-semibold uppercase px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-700">Anticipata</span>' : ''}
      </div>
      <p class="text-xs text-graphite-500 mt-0.5">${placeLabel(s.g)}</p>
      <p class="text-xs text-graphite-400 mt-1">Media ${fmtDays(s.avg)} · ultima ${fmtDays(s.lastDays)} · ${s.replacements} sostituzioni</p>
    </div>`;
}

function render(fromIso) {
  if (!el || !lastData) return;
  const { alerts, summaries, skipped } = lastData;
  const fromMs = fromIso ? new Date(fromIso).getTime() : 0;
  const inPeriod = alerts.filter((a) => a.date >= fromMs);

  let html = '';
  if (!summaries.length) {
    html += `<p class="text-sm text-graphite-400">Non ci sono ancora dati sufficienti. Servono almeno 3 prelievi dello stesso ricambio nello stesso posto (stessa linea e, per i cuscinetti, stesso macchinario e punto di utilizzo).</p>`;
  } else if (!inPeriod.length) {
    html += `<div class="flex items-center gap-2 text-sm text-emerald-700 font-medium"><i data-lucide="check-circle-2" class="w-4 h-4"></i>Nessuna sostituzione anticipata nel periodo.</div>`;
  } else {
    html += `<div class="flex items-center gap-2 text-sm text-rose-700 font-semibold mb-2"><i data-lucide="alert-triangle" class="w-4 h-4"></i>${inPeriod.length} ${inPeriod.length === 1 ? 'sostituzione anticipata' : 'sostituzioni anticipate'} nel periodo</div>`;
    html += `<div class="space-y-2">${inPeriod.slice(0, MAX_ALERTS).map(alertRow).join('')}</div>`;
    if (inPeriod.length > MAX_ALERTS) html += `<p class="text-xs text-graphite-500 mt-2">Mostrate le ${MAX_ALERTS} più recenti su ${inPeriod.length}.</p>`;
  }

  if (summaries.length) {
    html += `
      <details class="mt-4 border-t border-graphite-800 pt-3">
        <summary class="cursor-pointer text-sm font-display font-semibold uppercase tracking-wide text-graphite-400">Durata media per ricambio (${summaries.length})</summary>
        <div class="mt-2">${summaries.slice(0, MAX_GROUPS).map(summaryRow).join('')}</div>
        ${summaries.length > MAX_GROUPS ? `<p class="text-xs text-graphite-500 mt-2">Mostrati i primi ${MAX_GROUPS} su ${summaries.length}.</p>` : ''}
      </details>`;
  }
  if (skipped > 0) {
    html += `<p class="text-xs text-graphite-500 mt-3">${skipped} ${skipped === 1 ? 'prelievo' : 'prelievi'} senza linea o senza macchinario/punto (registrati prima di questa funzione) non ${skipped === 1 ? 'è considerato' : 'sono considerati'}.</p>`;
  }
  el.innerHTML = html;
  window.lucide?.createIcons();
}

/** Ricarica tutti i prelievi e ridisegna la sezione; se la rete manca resta l'ultimo calcolo. */
export async function refreshLifespan(fromIso) {
  el = document.getElementById('dash-lifespan');
  if (!el) return;
  try {
    const rows = await listPrelieviForLifespan();
    lastData = computeLifespan(rows);
    render(fromIso);
  } catch (err) {
    console.warn('Vita utile ricambi non disponibile.', err);
    if (lastData) render(fromIso);
    else el.innerHTML = '<p class="text-sm text-graphite-400">Non riesco a calcolare la vita utile in questo momento (controlla la connessione).</p>';
  }
}

export function resetLifespan() {
  lastData = null;
}
