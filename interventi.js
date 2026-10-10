// =============================================================
// interventi.js — Blocco Note Interventi (soste di manutenzione)
// Vista "Interventi" (User e Admin): elenco Da fare / Effettuati con filtri per linea e
// macchina, nuovo intervento in tre passi obbligatori (Linea → Macchina → Intervento, con
// scelte rapide per la combinazione), foto opzionale, aggiornamento dell'esito e PDF
// giornaliero. Feedback sonoro e aptico su ogni passo (vedi feedback.js).
// =============================================================

import { authState, isAdmin } from './auth.js';
import { listDistinctMacchine } from './supabase.js';
import {
  LINEE, STATI, lineaLabel, rapidoMatches,
  listInterventi, createIntervento, updateEsito, deleteIntervento, signedUrls, listRapidi,
  listEffettuatiRange, listEffettuatiDays, dayKey, keyToDate, listOperatori, operatoriDi, formatOperatore, sortOperatori,
} from './interventi-data.js';
import { openPicker } from './picker.js';
import { toastSuccess, toastError, toastWarning, toastInfo } from './toast.js';
import { confirmDialog } from './ui-modal.js';
import { exportGiornoPdf } from './interventi-pdf.js';
import { pickDateRange } from './date-range-modal.js';
import { openOverlay, closeOverlay, enableSheetDrag, setButtonBusy, syncSegIndicator, staggerIndex, emptyStateHtml } from './ui-utils.js';
import { escapeHtml } from './products-shared.js';
import feedback from './feedback.js';

const $ = (id) => document.getElementById(id);
const els = {};

const state = {
  tab: 'open',            // 'open' | 'done'
  open: [],
  done: [],               // effettuati del giorno scelto (scheda Effettuati)
  doneRecent: [],         // ultimi effettuati di qualunque giorno: servono solo alla ricerca in testata
  doneDays: new Set(),    // giorni (AAAA-MM-GG) con almeno un intervento effettuato: pallini blu del calendario
  doneDay: '',            // giorno mostrato nella scheda Effettuati
  machineOrder: [],       // macchine nell'ordine scelto dall'admin: raggruppamento dell'elenco
  tableMissing: false,
  loaded: false,
  loading: false,
  filterLinea: '',        // '' = tutte
  filterMacchina: '',
  rapidi: [],
  rapidiLoaded: false,
  operatori: [],          // persone che eseguono gli interventi (elenco gestito dall'admin)
  operatoriLoaded: false,
};

// Bozza del nuovo intervento: resta in memoria se si chiude il foglio, così non si perde
// quanto già scritto (si azzera col salvataggio o col pulsante "Azzera").
const draft = { linea: '', macchina: '', desc: '', foto: null, fotoUrl: '' };
let detail = null; // intervento aperto nel foglio dell'esito: { row, stato, foto, fotoUrl, rimuovi }

const STATO_CHIP = {
  da_effettuare: 'bg-[#eaedf4] text-amber-300',
  sospeso: 'bg-orange-100 text-orange-800',
  effettuato: 'bg-emerald-100 text-emerald-800',
};

const authorName = () => authState.profile?.full_name || authState.profile?.email || '';

// ---------------------------------------------------------------
// FOTO: compressione lato telefono (max 1600 px, JPEG) prima del caricamento
// ---------------------------------------------------------------
async function compressImage(file, maxSide = 1600, quality = 0.8) {
  let source;
  let w;
  let h;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = source.width;
    h = source.height;
  } catch (err) {
    // Browser senza createImageBitmap con opzioni: si ripiega su <img> (l'orientamento EXIF è già gestito dal browser)
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const obj = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(obj);
        resolve(img);
      };
      img.onerror = () => reject(new Error('Impossibile leggere la foto.'));
      img.src = obj;
    });
    w = source.naturalWidth;
    h = source.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('Impossibile elaborare la foto.');
  return blob;
}

/** Collega Scatta/Galleria/Rimuovi di un blocco foto. `get/set` leggono e scrivono il blob nello stato. */
function wirePhoto(pfx, onChange) {
  const actions = $(`${pfx}-photo-actions`);
  const preview = $(`${pfx}-photo-preview`);
  const img = $(`${pfx}-photo-img`);
  const cam = $(`${pfx}-photo-input-cam`);
  const gal = $(`${pfx}-photo-input-gal`);

  $(`${pfx}-photo-shoot`).addEventListener('click', () => cam.click());
  $(`${pfx}-photo-pick`).addEventListener('click', () => gal.click());
  $(`${pfx}-photo-remove`).addEventListener('click', () => {
    feedback.cancelAction();
    onChange(null, '');
  });
  // La foto già scelta si può ingrandire e zoomare toccandola
  img.classList.add('cursor-zoom-in');
  img.addEventListener('click', () => img.src && openPhotoViewer(img.src));
  const handle = async (input) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const blob = await compressImage(file);
      feedback.photoShutter();
      onChange(blob, URL.createObjectURL(blob));
    } catch (err) {
      feedback.errorAction();
      toastError(err.message || 'Foto non utilizzabile.');
    }
  };
  cam.addEventListener('change', () => handle(cam));
  gal.addEventListener('change', () => handle(gal));

  return {
    show(url) {
      const has = !!url;
      preview.classList.toggle('hidden', !has);
      actions.classList.toggle('hidden', has);
      img.src = has ? url : '';
    },
  };
}

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------
export function initInterventi() {
  els.seg = $('int-seg');
  els.list = $('int-list');
  els.skeleton = $('int-skeleton');
  els.notice = $('int-notice');
  els.fab = $('int-fab'); // fuori dalla vista (vedi index.html)

  // Tab Da fare / Effettuati
  els.seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-int-tab]');
    if (!btn || btn.dataset.intTab === state.tab) return;
    feedback.modeSelect();
    state.tab = btn.dataset.intTab;
    paintTabs();
    renderList();
  });

  // Giorno degli effettuati: freccia indietro/avanti sui soli giorni con interventi, o calendario con i pallini blu
  $('int-date-prev').addEventListener('click', () => stepDay(-1));
  $('int-date-next').addEventListener('click', () => stepDay(1));
  $('int-date-btn').addEventListener('click', async () => {
    feedback.tap();
    const range = await pickDateRange({ from: state.doneDay ? keyToDate(state.doneDay) : new Date(), single: true, marks: state.doneDays, title: 'Giorno degli interventi' });
    if (range) await selectDay(dayKey(range.from));
  });

  // Filtri
  $('int-filter-linea-btn').addEventListener('click', async () => {
    const labels = LINEE.map((l) => l.label);
    const picked = await openPicker({ title: 'Filtra per linea', options: labels, currentValue: lineaLabel(state.filterLinea) });
    if (picked === null) return;
    state.filterLinea = LINEE.find((l) => l.label === picked)?.value || '';
    if (state.filterLinea && state.filterMacchina) {
      const onLine = await listDistinctMacchine({ linea: state.filterLinea }).catch(() => null);
      if (onLine && !onLine.includes(state.filterMacchina)) state.filterMacchina = '';
    }
    feedback.filterChange();
    paintFilters();
    renderList();
  });
  $('int-filter-macchina-btn').addEventListener('click', async () => {
    // Macchine presenti negli interventi (della linea filtrata, se scelta), nell'ordine scelto dall'admin
    const used = new Set([...state.open, ...state.done].filter((r) => !state.filterLinea || r.linea === state.filterLinea).map((r) => r.macchina));
    let ordered = [];
    try {
      ordered = await listDistinctMacchine({ linea: state.filterLinea });
    } catch (err) {
      console.warn('Ordine macchine non disponibile.', err);
    }
    const options = [...ordered.filter((n) => used.has(n)), ...[...used].filter((n) => !ordered.includes(n))];
    const picked = await openPicker({ title: 'Filtra per macchina', options, keepOrder: true, currentValue: state.filterMacchina });
    if (picked === null) return;
    state.filterMacchina = picked;
    feedback.filterChange();
    paintFilters();
    renderList();
  });

  // PDF giornaliero
  $('int-pdf-btn').addEventListener('click', onExportPdf);

  // Nuovo intervento
  els.fab.addEventListener('click', openNew);
  initNewSheet();
  initDetailSheet();
  initPhotoViewer();
  initPdfSheet();
  paintFilters();
}

/** Mostra/nasconde il "+" (sta fuori dalla vista): visibile solo nella sezione Interventi */
export function setInterventiFab(on) {
  document.getElementById('int-fab')?.classList.toggle('int-fab--on', !!on);
}

/** Entrando nella vista: primo caricamento, poi aggiornamento silenzioso */
export async function enterInterventi() {
  syncSegIndicator(els.seg);
  await refreshInterventi({ silent: state.loaded });
}

export function resetInterventi() {
  setInterventiFab(false);
  state.open = [];
  state.done = [];
  state.doneRecent = [];
  state.doneDays = new Set();
  state.doneDay = '';
  state.machineOrder = [];
  state.loaded = false;
  state.rapidi = [];
  state.rapidiLoaded = false;
  state.operatori = [];
  state.operatoriLoaded = false;
  state.filterLinea = '';
  state.filterMacchina = '';
  state.tab = 'open';
  draft.linea = draft.macchina = draft.desc = '';
  draft.foto = null;
  draft.fotoUrl = '';
  detail = null;
  els.list && (els.list.innerHTML = '');
  paintTabs();
  paintFilters();
}

export async function refreshInterventi({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!silent) {
    els.skeleton.classList.remove('hidden');
    els.list.classList.add('hidden');
  }
  try {
    const [res, days, order] = await Promise.all([
      listInterventi(),
      listEffettuatiDays().catch(() => null),
      listDistinctMacchine().catch(() => null),
    ]);
    state.tableMissing = res.tableMissing;
    state.open = res.open;
    state.doneRecent = res.done;
    state.doneDays = new Set(days || res.done.map((r) => dayKey(new Date(r.esito_at))));
    if (order) state.machineOrder = order;
    // Scheda Effettuati: un giorno alla volta (oggi se ci sono interventi, altrimenti l'ultimo giorno con interventi)
    if (!state.doneDay) state.doneDay = defaultDay();
    await loadDay();
    state.loaded = true;
    renderList();
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Impossibile caricare gli interventi. Controlla la connessione.');
    if (!state.loaded) renderList();
  } finally {
    state.loading = false;
    els.skeleton.classList.add('hidden');
    els.list.classList.remove('hidden');
  }
}

function defaultDay() {
  const today = dayKey(new Date());
  if (state.doneDays.has(today) || !state.doneDays.size) return today;
  return [...state.doneDays].sort().pop();
}

/** Effettuati del giorno scelto, in ordine di esecuzione */
async function loadDay() {
  if (!state.doneDay) {
    state.done = [];
    return;
  }
  const d = keyToDate(state.doneDay);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  state.done = await listEffettuatiRange(from.toISOString(), to.toISOString());
}

async function selectDay(key) {
  if (!key || key === state.doneDay) return;
  const previous = state.doneDay;
  state.doneDay = key;
  try {
    await loadDay();
  } catch (err) {
    console.error(err);
    state.doneDay = previous;
    feedback.errorAction();
    toastError('Impossibile caricare gli interventi del giorno.');
    return;
  }
  feedback.filterChange();
  renderList();
}

/** Ricalcola i giorni con interventi (dopo aver chiuso, riaperto o eliminato un intervento) */
async function refreshDays() {
  try {
    state.doneDays = new Set(await listEffettuatiDays());
    renderList();
  } catch (err) {
    console.warn('Giorni con interventi non aggiornati.', err);
  }
}

const dayLabel = (key) => {
  const d = keyToDate(key);
  const today = new Date();
  const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const rel = key === dayKey(today) ? 'Oggi' : key === dayKey(yest) ? 'Ieri' : d.toLocaleDateString('it-IT', { weekday: 'short' }).replace(/^./, (c) => c.toUpperCase());
  return `${rel} · ${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
};

function paintDateRow() {
  const row = $('int-date-row');
  row.classList.toggle('hidden', state.tab !== 'done');
  if (state.tab !== 'done') return;
  $('int-date-label').textContent = state.doneDay ? dayLabel(state.doneDay) : 'Scegli il giorno';
  const days = [...state.doneDays].sort();
  $('int-date-prev').disabled = !days.some((k) => k < state.doneDay);
  $('int-date-next').disabled = !days.some((k) => k > state.doneDay);
}

async function stepDay(delta) {
  const days = [...state.doneDays].sort();
  const target = delta < 0 ? [...days].reverse().find((k) => k < state.doneDay) : days.find((k) => k > state.doneDay);
  if (target) await selectDay(target);
}

async function ensureRapidi(force = false) {
  if (state.rapidiLoaded && !force) return;
  try {
    const res = await listRapidi();
    state.rapidi = res.rapidi;
    state.rapidiLoaded = true;
  } catch (err) {
    console.warn('Interventi rapidi non disponibili.', err);
  }
}
/** Ricerca per la barra in testata: testo libero su descrizione, macchina, linea, esito e nomi. Cerca in tutti gli interventi (da fare ed effettuati), ignorando i filtri. */
export async function searchInterventi(term) {
  if (!state.loaded) {
    await refreshInterventi({ silent: true });
    // Se un caricamento era già in corso (entrata nella vista) si attende che finisca
    for (let i = 0; i < 30 && state.loading; i += 1) await new Promise((r) => setTimeout(r, 100));
  }
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hay = (r) =>
    [r.descrizione, r.macchina, lineaLabel(r.linea), r.linea, r.note_esito, r.created_by_name, r.esito_by_name, STATI[r.stato]]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  return [...state.open, ...state.doneRecent].filter((r) => {
    const h = hay(r);
    return words.every((w) => h.includes(w));
  });
}

/** Apre il foglio di un intervento (dai risultati della ricerca in testata) */
export function openInterventoDetail(row) {
  return openDetail(row);
}

async function ensureOperatori() {
  if (state.operatoriLoaded) return;
  try {
    state.operatori = sortOperatori((await listOperatori()).operatori.map((o) => o.nome));
    state.operatoriLoaded = true;
  } catch (err) {
    console.warn('Operatori non disponibili.', err);
  }
}
/** Chiamata dalle Impostazioni quando cambia l'elenco degli operatori */
export function invalidateOperatori() {
  state.operatoriLoaded = false;
}

/** Chiamata dalle Impostazioni quando cambiano gli interventi rapidi */
export function invalidateRapidi() {
  state.rapidiLoaded = false;
}

// ---------------------------------------------------------------
// ELENCO
// ---------------------------------------------------------------
function paintTabs() {
  els.seg.querySelectorAll('[data-int-tab]').forEach((b) => b.classList.toggle('category-tab-active', b.dataset.intTab === state.tab));
  syncSegIndicator(els.seg);
  paintDateRow();
}

function paintFilters() {
  const lv = $('int-filter-linea-value');
  lv.textContent = state.filterLinea ? lineaLabel(state.filterLinea) : 'Tutte le linee';
  lv.classList.toggle('text-graphite-400', !state.filterLinea);
  lv.classList.toggle('text-graphite-100', !!state.filterLinea);
  const mv = $('int-filter-macchina-value');
  mv.textContent = state.filterMacchina || 'Tutte le macchine';
  mv.classList.toggle('text-graphite-400', !state.filterMacchina);
  mv.classList.toggle('text-graphite-100', !!state.filterMacchina);
}

function applyFilters(rows) {
  return rows.filter((r) => (!state.filterLinea || r.linea === state.filterLinea) && (!state.filterMacchina || r.macchina === state.filterMacchina));
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `oggi ${hm}` : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

function renderList() {
  els.notice.classList.toggle('hidden', !state.tableMissing);
  // Il pulsante PDF è bianco e toccabile solo se esiste almeno un intervento effettuato
  const pdfBtn = $('int-pdf-btn');
  pdfBtn.disabled = !state.doneDays.size;
  pdfBtn.title = state.doneDays.size ? 'Esporta PDF degli interventi effettuati' : 'Nessun intervento effettuato da esportare';
  paintDateRow();
  const openCount = applyFilters(state.open).length;
  const doneCount = applyFilters(state.done).length;
  $('int-count-open').textContent = openCount ? `(${openCount})` : '';
  $('int-count-done').textContent = doneCount ? `(${doneCount})` : '';

  const rows = applyFilters(state.tab === 'open' ? state.open : state.done);
  els.list.innerHTML = '';
  if (!rows.length) {
    const filtered = state.filterLinea || state.filterMacchina;
    els.list.innerHTML = emptyStateHtml(
      state.tab === 'open' ? 'clipboard-check' : 'clipboard-list',
      filtered ? 'Nessun intervento con questi filtri' : state.tab === 'open' ? 'Nessun intervento da fare' : 'Nessun intervento effettuato in questo giorno',
      filtered ? 'Cambia o togli i filtri di linea e macchina.' : state.tab === 'open' ? 'Tocca + per annotarne uno durante la sosta.' : 'Scegli un giorno con il pallino blu nel calendario.'
    );
    window.lucide?.createIcons();
    return;
  }

  // Ordine: prima per linea, poi per macchina (ordine scelto dall'admin). Una scheda per macchina
  // con dentro tutti i suoi interventi, così l'elenco resta ordinato e si legge a colpo d'occhio.
  const orderIdx = new Map(state.machineOrder.map((n, i) => [n.toLowerCase(), i]));
  const idxOf = (m) => (orderIdx.has(m.toLowerCase()) ? orderIdx.get(m.toLowerCase()) : 9999);
  const byLinea = new Map();
  rows.forEach((r) => {
    if (!byLinea.has(r.linea)) byLinea.set(r.linea, new Map());
    const machines = byLinea.get(r.linea);
    if (!machines.has(r.macchina)) machines.set(r.macchina, []);
    machines.get(r.macchina).push(r);
  });
  const lineaIdx = (v) => (LINEE.findIndex((l) => l.value === v) + 1 || 99);
  const timeSort = (a, b) => (state.tab === 'done' ? new Date(a.esito_at) - new Date(b.esito_at) : new Date(b.created_at) - new Date(a.created_at));

  let i = 0;
  [...byLinea.keys()].sort((a, b) => lineaIdx(a) - lineaIdx(b)).forEach((linea) => {
    const machines = byLinea.get(linea);
    const total = [...machines.values()].reduce((n, list) => n + list.length, 0);
    const section = document.createElement('section');
    section.className = 'space-y-2.5';
    section.innerHTML = `
      <div class="flex items-center justify-between rounded-lg bg-amber-400 text-white px-3.5 py-2">
        <h3 class="font-display font-bold text-base uppercase tracking-wider">${escapeHtml(lineaLabel(linea))}</h3>
        <span class="font-mono text-sm font-semibold">${total}</span>
      </div>`;
    [...machines.keys()].sort((a, b) => idxOf(a) - idxOf(b) || a.localeCompare(b, 'it')).forEach((name) => {
      const items = machines.get(name).sort(timeSort);
      const card = document.createElement('div');
      card.className = 'list-item-in card-plate rounded-xl overflow-hidden';
      card.style.setProperty('--i', staggerIndex(i++));
      card.innerHTML = `
        <div class="flex items-center justify-between gap-2 px-3.5 py-2 bg-graphite-800/70">
          <h4 class="min-w-0 truncate font-display font-bold text-sm uppercase tracking-wider text-graphite-100">${escapeHtml(name)}</h4>
          <span class="shrink-0 ui-note font-mono text-graphite-500">${items.length}</span>
        </div>`;
      items.forEach((r) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.dataset.id = r.id;
        row.className = 'int-row w-full text-left px-3.5 py-3 flex items-start gap-3 border-t border-graphite-700/70';
        const ops = operatoriDi(r);
        const who = r.stato === 'effettuato' ? (ops.length ? ops.map(formatOperatore).join(', ') : r.esito_by_name) : r.created_by_name;
        const when = r.stato === 'effettuato' ? `Fatto ${fmtDateTime(r.esito_at)}${who ? ` · ${who}` : ''}` : `${fmtDateTime(r.created_at)}${who ? ` · ${who}` : ''}`;
        row.innerHTML = `
          <div class="min-w-0 flex-1">
            ${r.stato === 'sospeso' ? `<span class="inline-block ui-label font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full mb-1 ${STATO_CHIP.sospeso}">${STATI.sospeso}</span>` : ''}
            <p class="text-sm font-medium text-graphite-100 leading-snug line-clamp-3">${escapeHtml(r.descrizione)}</p>
            ${r.note_esito ? `<p class="text-xs text-graphite-500 mt-1 line-clamp-1">Esito: ${escapeHtml(r.note_esito)}</p>` : ''}
            <p class="ui-note text-graphite-500 mt-1">${escapeHtml(when)}</p>
          </div>
          <img class="int-thumb hidden" alt="" data-thumb>`;
        row.addEventListener('click', () => openDetail(r));
        card.appendChild(row);
      });
      section.appendChild(card);
    });
    els.list.appendChild(section);
  });
  window.lucide?.createIcons();
  loadThumbs(rows);
}

/** Miniature caricate dopo il disegno dell'elenco (URL firmati in un'unica richiesta) */
async function loadThumbs(rows) {
  const pathOf = (r) => (r.stato === 'effettuato' && r.foto_esito_path) || r.foto_promemoria_path || r.foto_esito_path;
  const paths = rows.map(pathOf).filter(Boolean);
  if (!paths.length) return;
  try {
    const urls = await signedUrls(paths);
    rows.forEach((r) => {
      const p = pathOf(r);
      const img = els.list.querySelector(`[data-id="${r.id}"] [data-thumb]`);
      if (p && urls[p] && img) {
        img.src = urls[p];
        img.classList.remove('hidden');
        img.classList.add('cursor-zoom-in');
        // Toccando la miniatura si ingrandisce la foto (senza aprire l'intervento)
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openPhotoViewer(urls[p]);
        });
      }
    });
  } catch (err) {
    console.warn('Miniature non disponibili.', err);
  }
}

// ---------------------------------------------------------------
// NUOVO INTERVENTO — Linea → Macchina → Intervento
// ---------------------------------------------------------------
function initNewSheet() {
  els.newModal = $('int-new-modal');
  els.newSeg = $('int-new-linea-seg');
  els.newMacchinaBtn = $('int-new-macchina-btn');
  els.newMacchinaValue = $('int-new-macchina-value');
  els.newDesc = $('int-new-desc');
  els.newChips = $('int-new-chips');
  els.newSave = $('int-new-save');
  els.newReset = $('int-new-reset');

  const close = () => closeOverlay(els.newModal);
  $('int-new-close').addEventListener('click', close);
  els.newModal.addEventListener('click', (e) => e.target === els.newModal && close());
  enableSheetDrag(els.newModal.querySelector('.modal-panel'), close);

  // 1 · Linea (controllo blu a scorrimento)
  els.newSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-linea]');
    if (!btn) return;
    const changed = draft.linea !== btn.dataset.linea;
    draft.linea = btn.dataset.linea;
    feedback.modeSelect();
    if (changed && draft.macchina) {
      // La macchina già scelta deve esistere anche sulla nuova linea, altrimenti si riparte da qui
      const onLine = await listDistinctMacchine({ linea: draft.linea }).catch(() => null);
      if (onLine && !onLine.includes(draft.macchina)) draft.macchina = '';
    }
    paintNew();
    // La macchina si sceglie a mano, toccando il campo: non si apre più da sola
  });

  // 2 · Macchina
  els.newMacchinaBtn.addEventListener('click', pickNewMacchina);

  // 3 · Descrizione
  els.newDesc.addEventListener('input', () => {
    draft.desc = els.newDesc.value;
    paintNew({ keepText: true });
  });

  wirePhotoNew = wirePhoto('int-new', (blob, url) => {
    if (draft.fotoUrl) URL.revokeObjectURL(draft.fotoUrl);
    draft.foto = blob;
    draft.fotoUrl = url;
    paintNew();
  });

  els.newReset.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Azzerare la bozza?', message: 'Linea, macchina, testo e foto già inseriti verranno cancellati.', confirmLabel: 'Azzera', danger: true });
    if (!ok) return;
    clearDraft();
    paintNew();
  });

  els.newSave.addEventListener('click', saveNew);
}
let wirePhotoNew = null;

function clearDraft() {
  if (draft.fotoUrl) URL.revokeObjectURL(draft.fotoUrl);
  draft.linea = draft.macchina = draft.desc = '';
  draft.foto = null;
  draft.fotoUrl = '';
}

async function openNew() {
  feedback.tap();
  paintNew();
  openOverlay(els.newModal);
  ensureRapidi(); // in background: le scelte rapide servono al terzo passo
}

async function pickNewMacchina() {
  if (!draft.linea) return;
  let options = [];
  try {
    // Solo le macchine presenti sulla linea scelta
    options = await listDistinctMacchine({ linea: draft.linea });
  } catch (err) {
    feedback.errorAction();
    toastError('Impossibile caricare l\'elenco delle macchine.');
    return;
  }
  const picked = await openPicker({ title: `Macchina · ${lineaLabel(draft.linea)}`, options, keepOrder: true, currentValue: draft.macchina });
  if (!picked) return;
  const changed = picked !== draft.macchina;
  draft.macchina = picked;
  feedback.stepDone();
  await ensureRapidi();
  paintNew();
  // Nessuna scelta rapida per questa combinazione: si va dritti alla scrittura
  if (changed && !draft.desc && !rapidiFor(draft.linea, draft.macchina).length) els.newDesc.focus();
}

const rapidiFor = (linea, macchina) => state.rapidi.filter((r) => rapidoMatches(r, linea, macchina));

function paintNew({ keepText = false } = {}) {
  // Linea
  els.newSeg.querySelectorAll('[data-linea]').forEach((b) => b.classList.toggle('category-tab-active', b.dataset.linea === draft.linea));
  syncSegIndicator(els.newSeg);

  // Passi
  $('int-step-macchina').dataset.locked = String(!draft.linea);
  const hasMacc = !!draft.linea && !!draft.macchina;
  $('int-step-desc').dataset.locked = String(!hasMacc);
  $('int-step-photo').dataset.locked = String(!hasMacc);

  els.newMacchinaValue.textContent = draft.macchina || 'Seleziona…';
  els.newMacchinaValue.classList.toggle('text-graphite-400', !draft.macchina);
  els.newMacchinaValue.classList.toggle('text-graphite-100', !!draft.macchina);

  // Scelte rapide filtrate per linea + macchina
  const chips = hasMacc ? rapidiFor(draft.linea, draft.macchina) : [];
  els.newChips.classList.toggle('hidden', !chips.length);
  if (!keepText) {
    els.newChips.innerHTML = '';
    chips.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'int-chip press-spring';
      b.textContent = c.titolo; // testo, mai HTML
      b.addEventListener('click', () => {
        draft.desc = c.titolo;
        els.newDesc.value = c.titolo;
        feedback.presetPick();
        paintNew({ keepText: true });
      });
      els.newChips.appendChild(b);
    });
    if (document.activeElement !== els.newDesc) els.newDesc.value = draft.desc;
  }
  els.newChips.querySelectorAll('.int-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === draft.desc.trim())));

  wirePhotoNew?.show(draft.fotoUrl);

  const valid = hasMacc && draft.desc.trim().length > 0;
  els.newSave.disabled = !valid;
  const dirty = !!(draft.linea || draft.macchina || draft.desc || draft.foto);
  els.newReset.classList.toggle('hidden', !dirty);
}

async function saveNew() {
  if (!draft.linea || !draft.macchina || !draft.desc.trim()) {
    feedback.errorAction();
    toastWarning('Servono linea, macchina e descrizione.');
    return;
  }
  setButtonBusy(els.newSave, true, 'Salvataggio…');
  try {
    const row = await createIntervento({
      linea: draft.linea,
      macchina: draft.macchina,
      descrizione: draft.desc.trim(),
      foto: draft.foto,
      authorName: authorName(),
    });
    state.open.unshift(row);
    clearDraft();
    feedback.noteSaved();
    toastSuccess('Intervento annotato.', 2500);
    closeOverlay(els.newModal);
    state.tab = 'open';
    paintTabs();
    renderList();
  } catch (err) {
    // Il modulo resta aperto con i dati: niente da riscrivere
    console.error(err);
    feedback.errorAction();
    toastError(err?.message?.includes('fetch') ? 'Connessione assente: l\'intervento NON è stato salvato. Riprova.' : 'Salvataggio non riuscito. Riprova.', 6000);
  } finally {
    setButtonBusy(els.newSave, false);
  }
}

// ---------------------------------------------------------------
// DETTAGLIO + ESITO
// ---------------------------------------------------------------
function initDetailSheet() {
  els.detModal = $('int-detail-modal');
  els.detSeg = $('int-esito-seg');
  els.detNote = $('int-esito-note');
  els.detSave = $('int-detail-save');

  const close = () => closeOverlay(els.detModal);
  $('int-detail-close').addEventListener('click', close);
  els.detModal.addEventListener('click', (e) => e.target === els.detModal && close());
  enableSheetDrag(els.detModal.querySelector('.modal-panel'), close);

  els.detSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stato]');
    if (!btn || !detail) return;
    detail.stato = btn.dataset.stato;
    feedback.modeSelect();
    paintDetail();
  });

  wirePhotoDetail = wirePhoto('int-esito', (blob, url) => {
    if (!detail) return;
    if (detail.fotoUrl?.startsWith('blob:')) URL.revokeObjectURL(detail.fotoUrl);
    detail.foto = blob;
    detail.fotoUrl = url;
    detail.rimuovi = !blob; // tolta la foto: va rimossa anche dal database
    paintDetail();
  });

  $('int-detail-photo').addEventListener('click', () => detail?.promemoriaUrl && openPhotoViewer(detail.promemoriaUrl));
  // Tendina degli operatori: si apre e si chiude dal campo
  $('int-operatore-btn').addEventListener('click', () => {
    if (!detail) return;
    detail.opOpen = !detail.opOpen;
    feedback.tap();
    paintOperatore();
  });
  els.detSave.addEventListener('click', saveDetail);
  $('int-detail-delete').addEventListener('click', removeDetail);
}
let wirePhotoDetail = null;

async function openDetail(row) {
  detail = { row, stato: row.stato, operatori: operatoriDi(row), opOpen: false, foto: null, fotoUrl: '', rimuovi: false, promemoriaUrl: '' };
  ensureOperatori().then(() => detail?.row === row && paintDetail());
  els.detNote.value = row.note_esito || '';
  $('int-detail-title').textContent = row.macchina;
  $('int-detail-linea').textContent = lineaLabel(row.linea);
  $('int-detail-desc').textContent = row.descrizione;
  $('int-detail-meta').textContent = `Annotato ${fmtDateTime(row.created_at)}${row.created_by_name ? ` da ${row.created_by_name}` : ''}`;
  $('int-detail-photo').classList.add('hidden');
  // L'eliminazione è di chi l'ha creato o dell'Admin (stessa regola del database)
  $('int-detail-delete').classList.toggle('hidden', !(isAdmin() || row.created_by === authState.profile?.id));
  paintDetail();
  openOverlay(els.detModal);

  // Foto (promemoria ed esito) con URL firmati
  const paths = [row.foto_promemoria_path, row.foto_esito_path].filter(Boolean);
  if (paths.length) {
    try {
      const urls = await signedUrls(paths);
      if (detail?.row !== row) return;
      if (row.foto_promemoria_path && urls[row.foto_promemoria_path]) {
        detail.promemoriaUrl = urls[row.foto_promemoria_path];
        $('int-detail-photo-img').src = detail.promemoriaUrl;
        $('int-detail-photo').classList.remove('hidden');
      }
      if (row.foto_esito_path && urls[row.foto_esito_path]) {
        detail.fotoUrl = urls[row.foto_esito_path];
        paintDetail();
      }
    } catch (err) {
      console.warn('Foto non disponibili.', err);
    }
  }
}

function paintDetail() {
  if (!detail) return;
  els.detSeg.querySelectorAll('[data-stato]').forEach((b) => b.classList.toggle('category-tab-active', b.dataset.stato === detail.stato));
  requestAnimationFrame(() => syncSegIndicator(els.detSeg));
  syncSegIndicator(els.detSeg);
  const chip = $('int-detail-stato');
  chip.textContent = STATI[detail.row.stato];
  chip.className = `ui-label font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${STATO_CHIP[detail.row.stato]}`;
  wirePhotoDetail?.show(detail.fotoUrl);
  paintOperatore();
}

/** Tendina "Operatori": compare solo con esito "Effettuato" (con "Da effettuare" o "Da completare" non si vede) e permette di sceglierne più d'uno. I nomi non finiscono nel PDF. */
function paintOperatore() {
  const show = detail.stato === 'effettuato';
  $('int-operatore-step').classList.toggle('hidden', !show);
  if (!show) {
    detail.opOpen = false;
    return;
  }
  const names = [...state.operatori];
  detail.operatori.forEach((n) => {
    if (!names.includes(n)) names.push(n); // operatore tolto dall'elenco ma già registrato su questo intervento
  });
  const sortedNames = sortOperatori(names); // alfabetico per cognome
  names.length = 0;
  names.push(...sortedNames);
  const open = !!detail.opOpen && names.length > 0;

  const value = $('int-operatore-value');
  value.textContent = detail.operatori.length ? sortOperatori(detail.operatori).map(formatOperatore).join(', ') : 'Seleziona operatori…';
  value.classList.toggle('text-graphite-400', !detail.operatori.length);
  value.classList.toggle('text-graphite-100', !!detail.operatori.length);
  $('int-operatore-btn').setAttribute('aria-expanded', String(open));
  $('int-operatore-chevron').style.transform = open ? 'rotate(180deg)' : '';

  const list = $('int-operatore-list');
  list.classList.toggle('hidden', !open);
  list.innerHTML = '';
  names.forEach((n, idx) => {
    if (idx > 0) {
      const d = document.createElement('div');
      d.setAttribute('role', 'separator');
      d.className = 'h-px bg-graphite-700/70 mx-3.5';
      list.appendChild(d);
    }
    const on = detail.operatori.includes(n);
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(on));
    row.className = 'w-full flex items-center gap-3 px-3.5 min-h-[48px] text-left text-sm text-graphite-100';
    row.innerHTML = `<span class="int-check"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="opacity:${on ? 1 : 0}"><path d="m5 12 5 5 9-10"/></svg></span><span class="min-w-0 truncate" data-name></span>`;
    row.querySelector('[data-name]').textContent = formatOperatore(n); // es. "N. VORRARO" (testo, mai HTML)
    row.addEventListener('click', () => {
      // Selezione multipla: la tendina resta aperta, ogni tocco aggiunge o toglie quel nome
      detail.operatori = on ? detail.operatori.filter((x) => x !== n) : [...detail.operatori, n];
      feedback.presetPick();
      paintOperatore();
    });
    list.appendChild(row);
  });
  $('int-operatore-empty').classList.toggle('hidden', names.length > 0 || !detail.opOpen);
}

async function saveDetail() {
  if (!detail) return;
  const { row } = detail;
  const note = els.detNote.value.trim();
  const unchanged = detail.stato === row.stato && note === (row.note_esito || '') && !detail.foto && !detail.rimuovi && (detail.stato !== 'effettuato' || [...detail.operatori].sort().join('|') === [...operatoriDi(row)].sort().join('|'));
  if (unchanged) {
    closeOverlay(els.detModal);
    return;
  }
  setButtonBusy(els.detSave, true, 'Salvataggio…');
  try {
    const updated = await updateEsito(row, { stato: detail.stato, note, operatori: detail.operatori, foto: detail.foto, rimuoviFoto: detail.rimuovi, authorName: authorName() });
    state.open = state.open.filter((r) => r.id !== updated.id);
    state.done = state.done.filter((r) => r.id !== updated.id);
    state.doneRecent = state.doneRecent.filter((r) => r.id !== updated.id);
    if (updated.stato === 'effettuato') {
      state.doneRecent.unshift(updated);
      state.doneRecent.sort((a, b) => new Date(b.esito_at) - new Date(a.esito_at));
      const k = dayKey(new Date(updated.esito_at));
      state.doneDays.add(k);
      // Se è stato eseguito nel giorno mostrato compare subito lì
      if (k === state.doneDay) state.done.push(updated);
      feedback.interventoDone();
      toastSuccess('Intervento effettuato.', 2500);
    } else {
      state.open.push(updated);
      state.open.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      feedback.interventoReopen();
      toastSuccess(updated.stato === 'sospeso' ? 'Segnato da completare.' : 'Rimesso da effettuare.', 2500);
    }
    closeOverlay(els.detModal);
    renderList();
    refreshDays(); // un giorno senza più interventi perde il pallino blu
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Aggiornamento non riuscito. Riprova.', 6000);
  } finally {
    setButtonBusy(els.detSave, false);
  }
}

async function removeDetail() {
  if (!detail) return;
  const { row } = detail;
  const ok = await confirmDialog({ title: 'Eliminare l\'intervento?', message: `"${row.descrizione}" su ${row.macchina} verrà cancellato con le sue foto.`, confirmLabel: 'Elimina', danger: true });
  if (!ok) return;
  try {
    await deleteIntervento(row);
    state.open = state.open.filter((r) => r.id !== row.id);
    state.done = state.done.filter((r) => r.id !== row.id);
    state.doneRecent = state.doneRecent.filter((r) => r.id !== row.id);
    closeOverlay(els.detModal);
    renderList();
    refreshDays();
    toastSuccess('Intervento eliminato.', 2500);
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Eliminazione non riuscita.');
  }
}

// ---------------------------------------------------------------
// FOTO A TUTTO SCHERMO, con zoom: pizzico con due dita, doppio tocco, rotella, trascinamento
// ---------------------------------------------------------------
const zoom = { scale: 1, x: 0, y: 0, pointers: new Map(), pinch: null, pan: null, tap: null, lastTap: 0 };
const ZOOM_MAX = 6;

function initPhotoViewer() {
  els.photoModal = $('int-photo-modal');
  els.photoStage = $('int-photo-stage');
  els.photoImg = $('int-photo-full');
  $('int-photo-close').addEventListener('click', () => closeOverlay(els.photoModal));

  const stage = els.photoStage;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    zoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    zoom.tap = zoom.pointers.size === 1 ? { t: Date.now(), x: e.clientX, y: e.clientY, moved: false } : null;
    startGesture();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!zoom.pointers.has(e.pointerId)) return;
    zoom.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (zoom.tap && Math.hypot(e.clientX - zoom.tap.x, e.clientY - zoom.tap.y) > 8) zoom.tap.moved = true;
    if (zoom.pointers.size >= 2 && zoom.pinch) {
      const [a, b] = [...zoom.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = Math.min(ZOOM_MAX, Math.max(1, (zoom.pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / zoom.pinch.dist));
      const c = stageCenter();
      // il punto dell'immagine sotto le dita resta sotto le dita
      zoom.x = mid.x - c.x - ((zoom.pinch.mid.x - c.x - zoom.pinch.x) / zoom.pinch.scale) * scale;
      zoom.y = mid.y - c.y - ((zoom.pinch.mid.y - c.y - zoom.pinch.y) / zoom.pinch.scale) * scale;
      zoom.scale = scale;
      applyZoom();
    } else if (zoom.pointers.size === 1 && zoom.pan && zoom.scale > 1) {
      zoom.x = zoom.pan.x + (e.clientX - zoom.pan.px);
      zoom.y = zoom.pan.y + (e.clientY - zoom.pan.py);
      applyZoom();
    }
  });
  const end = (e) => {
    if (!zoom.pointers.has(e.pointerId)) return;
    const wasSingle = zoom.pointers.size === 1;
    zoom.pointers.delete(e.pointerId);
    if (wasSingle && zoom.tap && !zoom.tap.moved && Date.now() - zoom.tap.t < 300) {
      const now = Date.now();
      if (now - zoom.lastTap < 320) {
        zoom.lastTap = 0;
        toggleZoomAt(e.clientX, e.clientY); // doppio tocco: ingrandisce / torna intero
      } else {
        zoom.lastTap = now;
      }
    }
    zoom.tap = null;
    if (zoom.scale < 1.02) {
      zoom.scale = 1;
      zoom.x = zoom.y = 0;
      applyZoom(true);
    }
    startGesture(); // con un dito rimasto si riparte dal trascinamento
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.min(ZOOM_MAX, Math.max(1, zoom.scale * Math.exp(-e.deltaY * 0.0018))));
    },
    { passive: false }
  );
}

const stageCenter = () => {
  const r = els.photoStage.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Fissa il punto di partenza di pizzico o trascinamento con i dita attuali */
function startGesture() {
  const pts = [...zoom.pointers.values()];
  zoom.pinch = null;
  zoom.pan = null;
  if (pts.length >= 2) {
    const [a, b] = pts;
    zoom.pinch = { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scale: zoom.scale, x: zoom.x, y: zoom.y };
  } else if (pts.length === 1) {
    zoom.pan = { x: zoom.x, y: zoom.y, px: pts[0].x, py: pts[0].y };
  }
}

/** Porta lo zoom a `scale` tenendo fermo il punto (cx, cy) dello schermo */
function zoomAt(cx, cy, scale, animated = false) {
  const c = stageCenter();
  const k = scale / zoom.scale;
  zoom.x = cx - c.x - (cx - c.x - zoom.x) * k;
  zoom.y = cy - c.y - (cy - c.y - zoom.y) * k;
  zoom.scale = scale;
  if (scale <= 1.02) {
    zoom.scale = 1;
    zoom.x = zoom.y = 0;
  }
  applyZoom(animated);
}

function toggleZoomAt(cx, cy) {
  zoomAt(cx, cy, zoom.scale > 1.05 ? 1 : 2.6, true);
}

/** Applica lo zoom tenendo l'immagine dentro lo schermo (niente bordi vuoti quando è ingrandita) */
function applyZoom(animated = false) {
  const img = els.photoImg;
  const stage = els.photoStage.getBoundingClientRect();
  const maxX = Math.max(0, (img.offsetWidth * zoom.scale - stage.width) / 2);
  const maxY = Math.max(0, (img.offsetHeight * zoom.scale - stage.height) / 2);
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x));
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y));
  img.style.transition = animated ? 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
  img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

/** Apre la foto a tutto schermo, sempre intera all'inizio */
function openPhotoViewer(url) {
  zoom.scale = 1;
  zoom.x = zoom.y = 0;
  zoom.pointers.clear();
  zoom.lastTap = 0;
  els.photoImg.style.transition = 'none';
  els.photoImg.style.transform = '';
  els.photoImg.src = url;
  openOverlay(els.photoModal);
}

// ---------------------------------------------------------------
// PDF DEGLI INTERVENTI EFFETTUATI: scelta del giorno e degli interventi da inserire
// ---------------------------------------------------------------
const pdf = { from: null, to: null, rows: [], selected: new Set(), busy: false };

const fmtDay = (d) => d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const periodLabel = () => (pdf.from.toDateString() === pdf.to.toDateString() ? fmtDay(pdf.from) : `${fmtDay(pdf.from)} - ${fmtDay(pdf.to)}`);

function initPdfSheet() {
  els.pdfModal = $('int-pdf-modal');
  const close = () => closeOverlay(els.pdfModal);
  $('int-pdf-close').addEventListener('click', close);
  els.pdfModal.addEventListener('click', (e) => e.target === els.pdfModal && close());
  enableSheetDrag(els.pdfModal.querySelector('.modal-panel'), close);
  $('int-pdf-change').addEventListener('click', async () => {
    const range = await pickDateRange({ from: pdf.from, to: pdf.to, marks: state.doneDays });
    if (range) await loadPdfRange(range);
  });
  $('int-pdf-all').addEventListener('click', () => {
    const all = pdf.selected.size !== pdf.rows.length;
    pdf.selected = new Set(all ? pdf.rows.map((r) => r.id) : []);
    feedback.modeSelect();
    paintPdfSheet();
  });
  $('int-pdf-go').addEventListener('click', generatePdf);
}

async function onExportPdf() {
  feedback.tap();
  const range = await pickDateRange({ from: state.doneDay ? keyToDate(state.doneDay) : new Date(), to: state.doneDay ? keyToDate(state.doneDay) : new Date(), marks: state.doneDays });
  if (!range) return;
  await loadPdfRange(range, { open: true });
}

/** Legge gli interventi effettuati nel periodo e apre l'elenco da cui scegliere */
async function loadPdfRange(range, { open = false } = {}) {
  const btn = $('int-pdf-btn');
  btn.disabled = true;
  try {
    const rows = await listEffettuatiRange(range.from.toISOString(), range.to.toISOString());
    if (!rows.length) {
      feedback.cancelAction();
      toastWarning('Nessun intervento effettuato nel periodo scelto.');
      return;
    }
    // Stesso ordine del PDF: per macchina (ordine dell'admin), poi per linea e ora di esecuzione
    rows.sort(machineRowSort);
    pdf.from = range.from;
    pdf.to = range.to;
    pdf.rows = rows;
    pdf.selected = new Set(rows.map((r) => r.id)); // di partenza sono tutti selezionati
    paintPdfSheet();
    if (open) openOverlay(els.pdfModal);
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Impossibile leggere gli interventi. Controlla la connessione.');
  } finally {
    btn.disabled = !state.done.length;
  }
}

/** Ordine di elenco e PDF: linea, poi macchina (come scelto dall'admin), poi ora di esecuzione */
function machineRowSort(a, b) {
  const orderIdx = new Map(state.machineOrder.map((n, i) => [n.toLowerCase(), i]));
  const idxOf = (m) => (orderIdx.has(m.toLowerCase()) ? orderIdx.get(m.toLowerCase()) : 9999);
  const lineaIdx = (v) => (LINEE.findIndex((l) => l.value === v) + 1 || 99);
  return lineaIdx(a.linea) - lineaIdx(b.linea) || idxOf(a.macchina) - idxOf(b.macchina) || a.macchina.localeCompare(b.macchina, 'it') || new Date(a.esito_at) - new Date(b.esito_at);
}

function paintPdfSheet() {
  $('int-pdf-period').textContent = periodLabel();
  const total = pdf.rows.length;
  const n = pdf.selected.size;
  $('int-pdf-count').textContent = `${n} di ${total} selezionati`;
  $('int-pdf-all').textContent = n === total ? 'Deseleziona tutti' : 'Seleziona tutti';
  const go = $('int-pdf-go');
  go.disabled = n === 0 || pdf.busy;
  $('int-pdf-go-label').textContent = n === 0 ? 'Scegli almeno un intervento' : `Genera PDF (${n})`;

  const list = $('int-pdf-list');
  list.innerHTML = '';
  let lastLinea = null;
  let lastMachine = null;
  pdf.rows.forEach((r) => {
    if (r.linea !== lastLinea) {
      lastLinea = r.linea;
      lastMachine = null;
      const h = document.createElement('p');
      h.className = 'font-display font-bold text-sm uppercase tracking-wider text-white bg-amber-400 rounded-lg px-3 py-1.5 mt-1.5';
      h.textContent = lineaLabel(r.linea);
      list.appendChild(h);
    }
    if (r.macchina !== lastMachine) {
      lastMachine = r.macchina;
      const h = document.createElement('p');
      h.className = 'font-display font-bold text-xs uppercase tracking-wider text-graphite-400 pt-1';
      h.textContent = r.macchina; // testo, mai HTML
      list.appendChild(h);
    }
    const on = pdf.selected.has(r.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(on));
    row.className = 'int-card card-plate rounded-xl p-3 flex items-start gap-3 press-spring';
    row.innerHTML = `
      <span class="int-check mt-0.5"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="opacity:${on ? 1 : 0}"><path d="m5 12 5 5 9-10"/></svg></span>
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-medium text-graphite-100 leading-snug line-clamp-2">${escapeHtml(r.descrizione)}</span>
      </span>`;
    row.addEventListener('click', () => {
      if (pdf.selected.has(r.id)) pdf.selected.delete(r.id);
      else pdf.selected.add(r.id);
      feedback.presetPick();
      paintPdfSheet();
    });
    list.appendChild(row);
  });
}

async function generatePdf() {
  const chosen = pdf.rows.filter((r) => pdf.selected.has(r.id));
  if (!chosen.length || pdf.busy) return;
  pdf.busy = true;
  const go = $('int-pdf-go');
  setButtonBusy(go, true, 'Preparo il PDF…');
  try {
    const result = await exportGiornoPdf(pdf.from, pdf.to, { rows: chosen });
    if (result === true) {
      feedback.confirmAction();
      toastSuccess('PDF pronto.', 2500);
      closeOverlay(els.pdfModal);
    }
    // 'cancelled': l'invio è stato annullato, la scelta resta aperta per riprovare
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err?.message || 'Impossibile creare il PDF.');
  } finally {
    pdf.busy = false;
    setButtonBusy(go, false);
    paintPdfSheet();
  }
}
