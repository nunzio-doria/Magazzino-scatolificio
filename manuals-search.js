// =============================================================
// manuals-search.js — Visualizzatore manuali: ricerca per parola chiave
// nel testo del PDF, barra risultati e evidenziazione delle occorrenze.
// Codice spostato qui pari pari da manuals.js: stessa logica, stesso
// comportamento, solo riorganizzato in un file più piccolo.
// =============================================================

import { toastError } from './toast.js';
import { els, state, scrollToPage, renderAllRenderedPages } from './manuals.js';

const SEARCH_BATCH = 16; // pagine analizzate in parallelo per blocco durante la ricerca del codice

export function updateResultsBar() {
  const hasResults = state.matches.length > 0;
  els.resultsBar?.classList.toggle('hidden', !hasResults);
  if (!hasResults) return;
  if (els.resultsLabel) {
    els.resultsLabel.textContent = `"${state.searchTerm}" — pagina ${state.matchIndex + 1} di ${state.matches.length}`;
  }
}

export async function stepResult(direction) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length;
  // Feedback immediato al tocco: senza questo, se la pagina di destinazione non è
  // ancora renderizzata, sembra che il pulsante non abbia risposto al tocco.
  setResultsNavBusy(true);
  await scrollToPage(state.matches[state.matchIndex]);
  setResultsNavBusy(false);
  updateResultsBar();
}

function setResultsNavBusy(busy) {
  [els.prevResultBtn, els.nextResultBtn].forEach((btn) => {
    btn?.toggleAttribute('disabled', busy);
    btn?.classList.toggle('opacity-40', busy);
  });
  if (busy && els.resultsLabel) els.resultsLabel.textContent = 'Caricamento…';
}

function yieldToBrowser() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function setSearchBusy(busy) {
  els.searchInput?.toggleAttribute('disabled', busy);
  const submitBtn = els.searchForm?.querySelector('button[type="submit"]');
  submitBtn?.toggleAttribute('disabled', busy);
  submitBtn?.classList.toggle('opacity-50', busy);
  els.prevResultBtn?.toggleAttribute('disabled', busy);
  els.nextResultBtn?.toggleAttribute('disabled', busy);
  if (busy) {
    els.resultsBar?.classList.remove('hidden');
    if (els.resultsLabel) els.resultsLabel.textContent = 'Ricerca in corso…';
  }
}

/**
 * Cerca `term` in TUTTO il manuale (indipendentemente da quali pagine sono attualmente
 * caricate) ed evidenzia/scorre alla prima pagina trovata. Su manuali da centinaia di
 * pagine, elaborare tutto in un solo colpo bloccava l'interfaccia: qui si procede a
 * blocchi paralleli, lasciando "respirare" il browser tra un blocco e l'altro, e con un
 * indicatore "Ricerca in corso…" così si vede chiaramente che sta lavorando.
 */
export async function runSearch(term, { silent = false } = {}) {
  const clean = (term || '').trim();
  const searchToken = ++state.searchToken;
  if (!state.pdfDoc || !clean) {
    state.searchTerm = '';
    state.matches = [];
    state.matchIndex = -1;
    updateResultsBar();
    await renderAllRenderedPages(); // toglie eventuali evidenziazioni residue
    return;
  }
  state.searchTerm = clean;
  const lower = clean.toLowerCase();
  const matches = [];
  let totalTextChars = 0; // se resta ~0 su tutto il documento, è quasi certamente una scansione senza testo selezionabile

  setSearchBusy(true);
  try {
    for (let start = state.rangeStart; start <= state.rangeEnd; start += SEARCH_BATCH) {
      if (searchToken !== state.searchToken) return; // è partita un'altra ricerca nel frattempo
      const end = Math.min(state.rangeEnd, start + SEARCH_BATCH - 1);
      const batch = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) => start + i).map(async (p) => {
          const page = await state.pdfDoc.getPage(p);
          const content = await page.getTextContent();
          const text = content.items.map((it) => it.str).join(' ').toLowerCase();
          return { p, hasMatch: text.includes(lower), textLen: text.replace(/\s+/g, '').length };
        })
      );
      batch.forEach(({ p, hasMatch, textLen }) => {
        if (hasMatch) matches.push(p);
        totalTextChars += textLen;
      });
      // Avanzamento reale (non un generico "in corso"): compare nello spinner grande se
      // il manuale si sta aprendo ora, o nella barra risultati se si sta cercando a
      // manuale già aperto — a seconda di quale dei due è visibile in questo momento.
      const progress = `Ricerca di "${clean}"… ${end}/${state.rangeEnd}`;
      if (els.loading && !els.loading.classList.contains('hidden') && els.loadingText) {
        els.loadingText.textContent = progress;
      }
      if (els.resultsLabel) els.resultsLabel.textContent = progress;
      await yieldToBrowser(); // niente più freeze: il browser può ridisegnare lo spinner tra un blocco e l'altro
    }
  } finally {
    setSearchBusy(false);
  }
  if (searchToken !== state.searchToken) return;

  state.matches = matches;
  state.matchIndex = matches.length ? 0 : -1;
  updateResultsBar();
  if (matches.length) {
    await scrollToPage(matches[0]);
    await renderAllRenderedPages(); // per far comparire l'evidenziazione anche sulle pagine già a schermo
  } else {
    if (!silent) {
      if (totalTextChars < 20) {
        toastError(`"${clean}" non trovato: questo manuale sembra una scansione senza testo selezionabile, la ricerca non può funzionarci.`);
      } else {
        toastError(`Nessuna pagina contiene "${clean}".`);
      }
    }
    state.searchTerm = ''; // niente evidenziazioni residue di una ricerca senza risultati
    await renderAllRenderedPages();
  }
}

/**
 * Evidenzia con un riquadro stretto (largo quanto il codice, non l'intera riga) ogni
 * occorrenza di `term` nel testo della pagina.
 */
export function drawHighlights(entry, content, viewport, term) {
  const lower = term.toLowerCase();
  let full = '';
  const spans = []; // { start, end, item }
  content.items.forEach((item) => {
    const start = full.length;
    full += `${item.str} `;
    spans.push({ start, end: full.length - 1, item });
  });
  const fullLower = full.toLowerCase();
  let idx = fullLower.indexOf(lower);
  while (idx !== -1) {
    const matchEnd = idx + lower.length;
    spans.forEach(({ start, end, item }) => {
      if (start < matchEnd && end > idx && item.str.trim()) {
        const localStart = Math.max(0, idx - start);
        const localEnd = Math.min(item.str.length, matchEnd - start);
        if (localEnd > localStart) drawHighlightBox(entry, item, viewport, localStart, localEnd);
      }
    });
    idx = fullLower.indexOf(lower, idx + 1);
  }
}

function drawHighlightBox(entry, item, viewport, localStart, localEnd) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib?.Util) return;
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const scaleX = Math.hypot(tx[0], tx[1]) || 1;
  const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
  const totalWidth = Math.max((item.width || 0) * scaleX, 1);
  const charWidthFromItem = totalWidth / Math.max(item.str.length, 1);

  // Tetto di sicurezza indipendente da item.width: in alcuni cataloghi (esportati da
  // software CAD/PDM) il singolo comando di testo del PDF contiene, oltre al codice,
  // un lunghissimo riempimento a spazi per allineare una colonna lontana — e quello
  // spazio fa parte della STESSA larghezza dichiarata dall'elemento, quindi nessuna
  // media per-carattere calcolata su di essa può darci una misura corretta. Qui si
  // stima invece la larghezza di un carattere dalla dimensione del font stesso (un
  // carattere è tipicamente largo circa il 55-65% della sua altezza) e non si supera
  // mai quella stima: elimina i riquadri enormi indipendentemente dalla causa.
  const estimatedCharWidth = fontHeight * 0.62;
  const charWidth = Math.min(charWidthFromItem, estimatedCharWidth * 1.5);

  const x = tx[4] + charWidth * localStart;
  const width = Math.max(charWidth * (localEnd - localStart), 4);
  const top = tx[5] - fontHeight;

  const box = document.createElement('div');
  box.className = 'manual-highlight';
  box.style.left = `${x}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${fontHeight * 1.15}px`;
  entry.highlightEl.appendChild(box);
}
