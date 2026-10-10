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
  done: [],
  tableMissing: false,
  loaded: false,
  loading: false,
  filterLinea: '',        // '' = tutte
  filterMacchina: '',
  rapidi: [],
  rapidiLoaded: false,
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
  state.loaded = false;
  state.rapidi = [];
  state.rapidiLoaded = false;
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
    const res = await listInterventi();
    state.tableMissing = res.tableMissing;
    state.open = res.open;
    state.done = res.done;
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
  return [...state.open, ...state.done].filter((r) => {
    const h = hay(r);
    return words.every((w) => h.includes(w));
  });
}

/** Apre il foglio di un intervento (dai risultati della ricerca in testata) */
export function openInterventoDetail(row) {
  return openDetail(row);
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
      filtered ? 'Nessun intervento con questi filtri' : state.tab === 'open' ? 'Nessun intervento da fare' : 'Nessun intervento effettuato',
      filtered ? 'Cambia o togli i filtri di linea e macchina.' : state.tab === 'open' ? 'Tocca + per annotarne uno durante la sosta.' : ''
    );
    window.lucide?.createIcons();
    return;
  }

  rows.forEach((r, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'int-card list-item-in card-plate rounded-xl p-3.5 flex items-start gap-3 press-spring';
    card.style.setProperty('--i', staggerIndex(i));
    const when = r.stato === 'effettuato' ? `Fatto ${fmtDateTime(r.esito_at)}${r.esito_by_name ? ` · ${r.esito_by_name}` : ''}` : `${fmtDateTime(r.created_at)}${r.created_by_name ? ` · ${r.created_by_name}` : ''}`;
    card.innerHTML = `
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 flex-wrap mb-1.5">
          <span class="ui-label font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-400 text-white">${escapeHtml(lineaLabel(r.linea))}</span>
          <span class="ui-label font-display font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${STATO_CHIP[r.stato]}">${STATI[r.stato]}</span>
        </div>
        <p class="font-display font-semibold text-base uppercase tracking-wide text-graphite-100 truncate">${escapeHtml(r.macchina)}</p>
        <p class="text-sm text-graphite-200 leading-snug mt-0.5 line-clamp-2">${escapeHtml(r.descrizione)}</p>
        ${r.note_esito ? `<p class="text-xs text-graphite-500 mt-1 line-clamp-1">Esito: ${escapeHtml(r.note_esito)}</p>` : ''}
        <p class="ui-note text-graphite-500 mt-1.5">${escapeHtml(when)}</p>
      </div>
      <img class="int-thumb hidden" alt="" data-thumb>`;
    card.addEventListener('click', () => openDetail(r));
    els.list.appendChild(card);
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
    const cards = els.list.querySelectorAll('.int-card');
    rows.forEach((r, i) => {
      const p = pathOf(r);
      const img = cards[i]?.querySelector('[data-thumb]');
      if (p && urls[p] && img) {
        img.src = urls[p];
        img.classList.remove('hidden');
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
    // Veloce: scelta la linea, si apre subito la macchina (se non già scelta)
    if (changed && !draft.macchina) pickNewMacchina();
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

  $('int-detail-photo').addEventListener('click', () => detail?.promemoriaUrl && showFullPhoto(detail.promemoriaUrl));
  els.detSave.addEventListener('click', saveDetail);
  $('int-detail-delete').addEventListener('click', removeDetail);
}
let wirePhotoDetail = null;

async function openDetail(row) {
  detail = { row, stato: row.stato, foto: null, fotoUrl: '', rimuovi: false, promemoriaUrl: '' };
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
}

async function saveDetail() {
  if (!detail) return;
  const { row } = detail;
  const note = els.detNote.value.trim();
  const unchanged = detail.stato === row.stato && note === (row.note_esito || '') && !detail.foto && !detail.rimuovi;
  if (unchanged) {
    closeOverlay(els.detModal);
    return;
  }
  setButtonBusy(els.detSave, true, 'Salvataggio…');
  try {
    const updated = await updateEsito(row, { stato: detail.stato, note, foto: detail.foto, rimuoviFoto: detail.rimuovi, authorName: authorName() });
    state.open = state.open.filter((r) => r.id !== updated.id);
    state.done = state.done.filter((r) => r.id !== updated.id);
    if (updated.stato === 'effettuato') {
      state.done.unshift(updated);
      state.done.sort((a, b) => new Date(b.esito_at) - new Date(a.esito_at));
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
    closeOverlay(els.detModal);
    renderList();
    toastSuccess('Intervento eliminato.', 2500);
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError('Eliminazione non riuscita.');
  }
}

// ---------------------------------------------------------------
// FOTO A TUTTO SCHERMO
// ---------------------------------------------------------------
function initPhotoViewer() {
  els.photoModal = $('int-photo-modal');
  const close = () => closeOverlay(els.photoModal);
  $('int-photo-close').addEventListener('click', close);
  els.photoModal.addEventListener('click', close);
}
function showFullPhoto(url) {
  $('int-photo-full').src = url;
  openOverlay(els.photoModal);
}

// ---------------------------------------------------------------
// PDF DELLA GIORNATA
// ---------------------------------------------------------------
async function onExportPdf() {
  feedback.tap();
  const range = await pickDateRange({ from: new Date(), to: new Date() });
  if (!range) return;
  const btn = $('int-pdf-btn');
  btn.disabled = true;
  try {
    toastInfo('Preparo il PDF…', 2000);
    const result = await exportGiornoPdf(range.from, range.to, { authorName: authorName() });
    if (result === 'empty') {
      feedback.cancelAction();
      toastWarning('Nessun intervento effettuato nel periodo scelto.');
    } else if (result === true) {
      feedback.confirmAction();
      toastSuccess('PDF pronto.', 2500);
    }
  } catch (err) {
    console.error(err);
    feedback.errorAction();
    toastError(err?.message || 'Impossibile creare il PDF.');
  } finally {
    btn.disabled = false;
  }
}
