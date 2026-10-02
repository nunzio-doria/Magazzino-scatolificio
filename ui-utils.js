import feedback from './feedback.js';
import { pushLayer, releaseLayer } from './nav-history.js';
// =============================================================
// ui-utils.js — Utility di interfaccia condivise tra le viste:
// contatori numerici animati e anelli di progresso (KPI dashboard).
// =============================================================

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

let scrollLockCount = 0;
let savedScrollY = 0;

/**
 * Blocca lo scroll della pagina sotto una modale aperta (product-modal,
 * field-picker-modal, article-history-modal, dialog di conferma...). Usa un
 * contatore cosí due modali aperte in sequenza (es. picker sopra il form
 * articolo) non sbloccano lo sfondo chiudendone solo una.
 * position:fixed invece del solo overflow:hidden, perché su iOS Safari
 * overflow:hidden da solo non impedisce comunque lo scroll/rimbalzo dietro
 * l'overlay.
 */
export function lockBodyScroll() {
  if (scrollLockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
  }
  scrollLockCount += 1;
}

/** Sblocca lo scroll quando l'ultima modale aperta si chiude */
export function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    window.scrollTo(0, savedScrollY);
  }
}

/** Durata (ms) della chiusura di tutte le modali: la legge dal token CSS --dur-slow, così
 *  resta sempre uguale alla transizione del pannello (340 solo come valore di riserva). */
export function modalCloseMs() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-slow'));
  return Number.isFinite(v) && v > 0 ? v : 340;
}

/**
 * Apre una modale (overlay con classe .modal-overlay) con l'animazione
 * standard dell'app. Sicura se richiamata due volte o durante una chiusura.
 */
export function openOverlay(el) {
  if (!el || el.dataset.modalOpen) return;
  el.dataset.modalOpen = '1';
  feedback.overlayOpen();
  clearTimeout(el._hideTimer); // annulla un'eventuale chiusura ancora in corso
  el.classList.remove('hidden');
  void el.offsetWidth; // reflow: la transizione parte sempre
  lockBodyScroll();
  el.classList.add('modal-visible');
  // Il tasto indietro del telefono chiude la modale invece di uscire dall'app. Un modulo può
  // gestire lui la chiusura (pulizia extra) ascoltando 'overlay-back' e chiamando preventDefault().
  el._navLayer = pushLayer(() => {
    if (el.dispatchEvent(new CustomEvent('overlay-back', { cancelable: true }))) {
      el.dispatchEvent(new CustomEvent('overlay-cancel'));
      closeOverlay(el);
    }
  });
}

/** Chiude una modale con l'animazione standard. Sicura se già chiusa. */
export function closeOverlay(el) {
  if (!el || !el.dataset.modalOpen) return;
  delete el.dataset.modalOpen;
  feedback.overlayClose();
  releaseLayer(el._navLayer);
  el._navLayer = null;
  el.classList.remove('modal-visible');
  unlockBodyScroll();
  el._hideTimer = setTimeout(() => el.classList.add('hidden'), modalCloseMs());
}

/**
 * Trascinamento verso il basso per chiudere un cassetto (bottom sheet), valido
 * per tutte le modali. Zone che avviano il trascinamento: ogni elemento del
 * pannello con l'attributo data-sheet-drag (la maniglia in cima e la riga del
 * titolo): un'area ampia e a tutta larghezza, non solo la barretta.
 * - Solo al tocco (dito/penna) e solo su schermi stretti, dove il pannello è
 *   un cassetto: su desktop le modali sono finestre centrate e non si trascinano.
 * - Un tocco su un pulsante o un campo dentro la zona resta un normale tocco.
 * - Segue il dito 1:1; al rilascio chiude se si è superato il 28% dell'altezza
 *   oppure se il gesto è stato una strisciata veloce, altrimenti torna su.
 * @param {HTMLElement} panel il pannello (.modal-panel)
 * @param {() => void} onClose funzione di chiusura della modale
 */
export function enableSheetDrag(panel, onClose) {
  if (!panel || panel.dataset.sheetDragBound) return;
  panel.dataset.sheetDragBound = '1';
  const narrow = window.matchMedia('(max-width: 639px)');
  let pointerId = null;
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let thresholdHit = false; // vibrazione una sola volta quando si supera la soglia di chiusura

  panel.querySelectorAll('[data-sheet-drag]').forEach((zone) => {
    zone.addEventListener('pointerdown', (e) => {
      if (pointerId !== null || e.pointerType === 'mouse' || !narrow.matches) return;
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      pointerId = e.pointerId;
      startY = e.clientY;
      startT = performance.now();
      dy = 0;
      try {
        zone.setPointerCapture(e.pointerId); // continua a ricevere il gesto anche se il dito esce dalla zona
      } catch (err) {
        /* puntatore non più attivo: si prosegue senza cattura */
      }
      thresholdHit = false;
      panel.classList.add('sheet-dragging');
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      dy = Math.max(0, e.clientY - startY); // non si trascina oltre la posizione tutta aperta
      panel.style.transform = `translateY(${dy}px)`;
      const past = dy > (panel.getBoundingClientRect().height || 1) * 0.28;
      if (past && !thresholdHit) feedback.dragThreshold();
      thresholdHit = past;
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      panel.classList.remove('sheet-dragging');
      const height = panel.getBoundingClientRect().height || 1;
      const fastSwipe = dy > 48 && performance.now() - startT < 260;
      const shouldClose = e.type !== 'pointercancel' && (dy > height * 0.28 || fastSwipe);
      panel.style.transform = '';
      dy = 0;
      // Sotto soglia: tolta la classe .sheet-dragging e lo stile inline, la
      // transizione CSS riporta da sola il pannello in posizione.
      if (shouldClose) {
        feedback.cancelAction();
        onClose();
      }
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  });
}

/**
 * Segna un pulsante come "in corso" (richiesta al server in volo): lo disabilita, lo attenua
 * in modo uniforme (regola CSS su :disabled, non più una classe opacity- diversa per ogni
 * file) e, se richiesto, sostituisce la sua scritta con un'icona che gira più una nuova scritta.
 * Prima di questo helper c'erano tre livelli di attenuazione diversi (opacity-50, opacity-60,
 * nessuna) sparsi tra i file, e solo il login mostrava un testo di stato.
 * @param {HTMLButtonElement} btn
 * @param {boolean} busy
 * @param {string} [busyLabel] testo mostrato mentre è in corso (se omesso, resta il testo del pulsante)
 */
export function setButtonBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busy) return; // già in corso: non sovrascrivere il testo originale salvato
    btn.dataset.busy = '1';
    btn.disabled = true;
    if (busyLabel) {
      btn.dataset.originalHtml = btn.innerHTML;
      btn.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span><span>${busyLabel}</span>`;
    }
  } else {
    delete btn.dataset.busy;
    btn.disabled = false;
    if (btn.dataset.originalHtml != null) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

/**
 * Chiude tutte le modali aperte (es. alla disconnessione). Alle modali che
 * hanno una Promise in sospeso (picker, conferma) manda prima l'evento
 * 'overlay-cancel', cosí si risolvono come "annullato" invece di restare appese.
 */
export function closeAllOverlays() {
  document.querySelectorAll('.modal-overlay[data-modal-open]').forEach((el) => {
    el.dispatchEvent(new CustomEvent('overlay-cancel'));
    closeOverlay(el);
  });
}

/**
 * Anima il testo di un elemento da un numero all'altro (count-up/down),
 * invece di sostituire il valore di colpo. Rispetta prefers-reduced-motion.
 * @param {HTMLElement} el
 * @param {number} to
 * @param {{ from?: number, duration?: number, formatter?: (n:number)=>string }} [opts]
 */
export function animateNumber(el, to, { from = null, duration = 650, formatter } = {}) {
  if (!el) return;
  if (el.closest('.list-static')) duration = 0; // aggiornamento silenzioso: niente conteggio animato
  const start = from != null ? from : Number(el.textContent.replace(/[^\d.-]/g, '')) || 0;
  const end = Number(to) || 0;
  const fmt = formatter || ((n) => String(Math.round(n)));

  if (duration === 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || start === end) {
    el.textContent = fmt(end);
    return;
  }

  const t0 = performance.now();
  function frame(now) {
    const progress = Math.min((now - t0) / duration, 1);
    const value = start + (end - start) * easeOutCubic(progress);
    el.textContent = fmt(value);
    if (progress < 1) requestAnimationFrame(frame);
    else el.textContent = fmt(end);
  }
  requestAnimationFrame(frame);
}

/**
 * Anima lo stroke-dashoffset di un anello SVG di progresso verso una
 * percentuale target (0-100). circleEl deve avere già impostato
 * stroke-dasharray = circonferenza.
 */
export function animateRing(circleEl, percent, { duration = 700 } = {}) {
  if (!circleEl) return;
  if (circleEl.closest('.list-static')) duration = 0; // aggiornamento silenzioso: nessuna animazione dell'anello
  const circumference = parseFloat(circleEl.getAttribute('stroke-dasharray')) || 0;
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const targetOffset = circumference * (1 - clamped / 100);
  const startOffset = parseFloat(circleEl.style.strokeDashoffset || circleEl.getAttribute('stroke-dashoffset')) || circumference;

  if (duration === 0 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    circleEl.style.strokeDashoffset = String(targetOffset);
    return;
  }

  const t0 = performance.now();
  function frame(now) {
    const progress = Math.min((now - t0) / duration, 1);
    const value = startOffset + (targetOffset - startOffset) * easeOutCubic(progress);
    circleEl.style.strokeDashoffset = String(value);
    if (progress < 1) requestAnimationFrame(frame);
    else circleEl.style.strokeDashoffset = String(targetOffset);
  }
  requestAnimationFrame(frame);
}

/**
 * Forza un "replay" di un'animazione CSS su un elemento: rimuove la
 * classe, forza il reflow, la riaggiunge. Utile per far ripartire la
 * micro-animazione di comparsa ogni volta (es. card risultato scanner).
 */
export function replayAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth; // forza il reflow
  el.classList.add(className);
}

/**
 * Markup di uno stato vuoto illustrato (icona lucide + titolo + sottotitolo),
 * coerente in tutte le viste invece di una singola riga di testo grigio.
 */
/**
 * Indice limitato per lo sfalsamento (--i) delle liste lunghe: oltre una
 * decina di elementi lo stagger diventerebbe percettibilmente lento a
 * caricare, quindi si appiattisce sul valore massimo invece di crescere
 * all'infinito con la lunghezza della lista.
 */
export function staggerIndex(i, max = 10) {
  return Math.min(i, max);
}

export function emptyStateHtml(icon, title, subtitle = '') {
  return `
    <div class="empty-state-in flex flex-col items-center gap-2.5 py-4">
      <span class="w-14 h-14 rounded-full bg-graphite-800/60 flex items-center justify-center">
        <i data-lucide="${icon}" class="w-6 h-6 text-graphite-600" stroke-width="1.6"></i>
      </span>
      <p class="font-display font-semibold text-sm text-graphite-300">${title}</p>
      ${subtitle ? `<p class="text-xs text-graphite-500 max-w-[220px] text-center leading-relaxed">${subtitle}</p>` : ''}
    </div>`;
}


/**
 * Controlli segmentati (.seg): posiziona il rettangolo blu (.seg-indicator) sotto il pulsante
 * attivo passando --seg-x/--seg-w; il CSS lo fa scorrere lateralmente. Il primo posizionamento
 * (e quello dopo che il controllo era nascosto) è istantaneo, senza scivolare da sinistra.
 * Va richiamata dopo ogni cambio del pulsante attivo; la prima volta aggancia anche un
 * ResizeObserver per riallinearsi a rotazione schermo, font caricati o controllo che riappare.
 */
export function syncSegIndicator(seg) {
  if (!seg) return;
  if (!seg._segObserved && typeof ResizeObserver !== 'undefined') {
    seg._segObserved = true;
    new ResizeObserver(() => syncSegIndicator(seg)).observe(seg);
  }
  const active = seg.querySelector('.category-tab-active, .view-mode-tab-active');
  if (!active || !seg.offsetWidth) {
    seg._segHidden = true;
    return;
  }
  const instant = seg._segHidden !== false;
  if (instant) seg.classList.remove('seg-ready');
  seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
  seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
  if (instant) {
    void seg.offsetWidth; // reflow: la posizione si applica prima di riattivare la transizione
    seg.classList.add('seg-ready');
    seg._segHidden = false;
  }
}


/**
 * Cassetto (.modal-panel) che si adatta in modo animato alla nuova altezza quando cambia il
 * contenuto (es. filtro Tutti/Depositi/Prelievi con liste di lunghezza diversa): sale o scende
 * con la stessa durata dei cassetti invece di scattare. Tecnica: si fissa l'altezza attuale,
 * si esegue l'aggiornamento, si misura l'altezza naturale del nuovo contenuto e si anima da
 * una all'altra; a fine corsa l'altezza torna automatica (il contenuto può ancora crescere).
 * Il pannello resta ancorato al bordo inferiore, quindi il bordo superiore sale/scende.
 * Sicura se richiamata durante un'animazione già in corso (riparte dall'altezza attuale).
 * @param {HTMLElement|null} panel  il .modal-panel
 * @param {() => void} update       funzione che aggiorna il contenuto (sincrona)
 * @param {string} [animClass]      classe con la transizione dell'altezza (default: quella dei cassetti)
 */
export function animatePanelHeight(panel, update, animClass = 'panel-h-anim') {
  if (!panel) {
    update();
    return;
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  clearTimeout(panel._heightTimer);
  const before = panel.offsetHeight;

  panel.classList.remove(animClass); // niente transizione mentre si fissano/misurano le altezze
  panel.style.height = `${before}px`;
  update();
  panel.style.height = 'auto';
  const after = panel.offsetHeight; // altezza naturale (già limitata da max-h) del nuovo contenuto
  panel.style.height = `${before}px`;

  if (reduce || Math.abs(after - before) < 2) {
    panel.style.height = '';
    return;
  }
  void panel.offsetHeight; // reflow: parte da "before" e non da "auto"
  panel.classList.add(animClass);
  panel.style.height = `${after}px`;
  const done = () => {
    panel.classList.remove(animClass);
    panel.style.height = '';
  };
  panel._heightTimer = setTimeout(done, modalCloseMs() + 60);
}

// --- CARICAMENTO A RICHIESTA DELLE LIBRERIE PESANTI ---------------------------
// jsPDF, SheetJS (Excel) e html5-qrcode (scanner) servono solo in azioni precise:
// non vengono più caricate all'avvio ma al primo utilizzo. Dopo l'avvio, a thread
// libero, se ne scarica (senza eseguirla) una copia in rete/cache, così il primo
// uso è rapido e funziona anche offline.
const LIBS = {
  jspdf: { url: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js', ready: () => window.jspdf },
  xlsx: { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', ready: () => window.XLSX },
  qr: { url: 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js', ready: () => window.Html5Qrcode },
};
const libPromises = {};

export function loadLib(name) {
  const lib = LIBS[name];
  if (!lib) return Promise.reject(new Error(`Libreria sconosciuta: ${name}`));
  if (lib.ready()) return Promise.resolve();
  if (libPromises[name]) return libPromises[name];
  libPromises[name] = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = lib.url;
    script.onload = () => (lib.ready() ? resolve() : reject(new Error(`Libreria ${name} non disponibile dopo il caricamento.`)));
    script.onerror = () => {
      delete libPromises[name]; // permette un nuovo tentativo
      reject(new Error(`Impossibile caricare la libreria ${name}. Controlla la connessione.`));
    };
    document.head.appendChild(script);
  });
  return libPromises[name];
}

function prefetchLibs() {
  Object.values(LIBS).forEach((lib) => {
    fetch(lib.url, { mode: 'no-cors' }).catch(() => {});
  });
}
const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 4000));
window.addEventListener('load', () => idle(prefetchLibs, { timeout: 8000 }));

// --- ICONE LUCIDE: niente scansione inutile -------------------------------------
// createIcons() rianalizza tutta la pagina a ogni chiamata (ce ne sono decine nel
// codice). Qui la si rende un no-op quando non c'è nessun segnaposto ancora da
// trasformare, senza toccare i punti di chiamata.
function patchLucide() {
  const l = window.lucide;
  if (!l || l._patched) return;
  const original = l.createIcons;
  l.createIcons = function (...args) {
    if (!document.querySelector(':not(svg)[data-lucide]')) return;
    return original.apply(this, args);
  };
  l._patched = true;
}
patchLucide();

// --- INDICATORE DI AVANZAMENTO UPLOAD ------------------------------------------
/**
 * Modale quadrato al centro dello schermo (sempre a tema chiaro) con un anello a tacche che si
 * accendono, la percentuale e il nome del file. Blocca i tocchi sulla schermata sotto finché
 * l'upload non finisce. Uso: const up = startUploadProgress(file.name);
 * await upload(..., up.update); up.done();  (in caso di errore: up.fail()).
 * A 100% mostra "Elaborazione…" finché non si chiama done().
 */
const UP_TICKS = 60;
const UP_ARROW = '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>';
const UP_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const UP_CROSS = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';

export function startUploadProgress(fileName) {
  const el = document.createElement('div');
  el.className = 'upload-modal';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-label', 'Caricamento in corso');
  let ticksSvg = '';
  for (let i = 0; i < UP_TICKS; i++) {
    ticksSvg += `<line x1="66" x2="66" y1="6" y2="15" stroke-width="3" stroke-linecap="round" transform="rotate(${(i * 360) / UP_TICKS} 66 66)"></line>`;
  }
  el.innerHTML = `
    <div class="upload-modal-card">
      <div class="upload-modal-ring">
        <svg viewBox="0 0 132 132" width="132" height="132" aria-hidden="true">
          <g class="upload-modal-orbit"><circle cx="66" cy="66" r="50" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.1 12"></circle></g>
          <g class="upload-modal-ticks">${ticksSvg}</g>
        </svg>
        <div class="upload-modal-core upload-modal-core-up">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UP_ARROW}</svg>
        </div>
      </div>
      <div class="upload-modal-pct">0%</div>
      <div class="upload-modal-name"></div>
      <div class="upload-modal-status">Caricamento in corso</div>
    </div>`;
  el.querySelector('.upload-modal-name').textContent = fileName || 'File';
  const ticks = Array.from(el.querySelectorAll('.upload-modal-ticks line'));
  const core = el.querySelector('.upload-modal-core');
  const coreSvg = core.querySelector('svg');
  const pctEl = el.querySelector('.upload-modal-pct');
  const statusEl = el.querySelector('.upload-modal-status');
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('upload-modal-visible'));

  let target = 0;
  let shown = 0;
  let tone = 'busy'; // busy | ok | error
  let raf = 0;
  let closed = false;

  const paint = () => {
    const lit = Math.floor((shown / 100) * UP_TICKS);
    ticks.forEach((tick, i) => {
      const on = i < lit;
      const head = i === lit && tone === 'busy' && shown < 100;
      tick.style.stroke = on ? (tone === 'ok' ? '#2f9e6b' : tone === 'error' ? '#e5484d' : `rgb(var(--accent-rgb))`) : '#d5dae3';
      tick.setAttribute('y1', head ? 2 : 6);
      tick.style.opacity = on || head ? 1 : 0.7;
    });
    pctEl.textContent = tone === 'error' ? 'Errore' : `${Math.round(shown)}%`;
  };
  const loop = () => {
    raf = 0;
    if (closed) return;
    // la percentuale "insegue" il valore reale con un movimento morbido, anche se l'upload arriva a scatti
    shown += (target - shown) * 0.2;
    if (Math.abs(target - shown) < 0.15) shown = target;
    paint();
    if (shown !== target) raf = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (!raf && !closed) raf = requestAnimationFrame(loop);
  };
  const close = (delay) => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    clearTimeout(watchdog);
    setTimeout(() => {
      el.classList.remove('upload-modal-visible');
      setTimeout(() => el.remove(), 260);
    }, delay);
  };
  const watchdog = setTimeout(() => close(0), 15 * 60 * 1000); // rete di sicurezza: non lascia mai la schermata bloccata
  paint();

  return {
    update(percent) {
      if (closed || tone !== 'busy') return;
      target = Math.max(target, Math.max(0, Math.min(100, percent)));
      if (target >= 100) statusEl.textContent = 'Elaborazione…';
      kick();
    },
    done() {
      if (closed) return;
      tone = 'ok';
      target = 100;
      shown = 100;
      paint();
      core.className = 'upload-modal-core upload-modal-core-ok';
      coreSvg.innerHTML = UP_CHECK;
      statusEl.textContent = 'File caricato';
      close(1000);
    },
    fail() {
      if (closed) return;
      tone = 'error';
      paint();
      core.className = 'upload-modal-core upload-modal-core-error';
      coreSvg.innerHTML = UP_CROSS;
      statusEl.textContent = 'Caricamento non riuscito';
      close(1800);
    },
  };
}

// --- RITAGLIO AUTOMATICO DEI MARGINI DELLE IMMAGINI -------------------------------
/**
 * Prepara l'immagine di una macchina: toglie lo sfondo piatto (bianco, grigio chiaro o
 * trasparente) che circonda il soggetto, lo rende trasparente, ritaglia attorno alla
 * macchina lasciando un piccolo respiro e limita il lato maggiore a maxSide. Così il
 * disegno riempie il riquadro e si fonde con lo sfondo della scheda.
 *
 * Lo sfondo viene riconosciuto dai quattro angoli (devono avere lo stesso colore) e
 * rimosso partendo dai bordi, così le parti chiare DENTRO la macchina restano intatte.
 * Per le foto (sfondo non uniforme) e per le immagini illeggibili restituisce il file originale.
 */
export async function trimImageMargins(file, { maxSide = 2400, padding = 0.04, tolerance = 10 } = {}) {
  let url = null;
  try {
    url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) return file;

    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;

    // Sfondo di riferimento dai quattro angoli
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
    const transparentCorners = corners.filter((i) => d[i + 3] < 12).length;
    const solid = corners.filter((i) => d[i + 3] >= 12);
    let bg = null;
    if (transparentCorners < 4) {
      if (transparentCorners > 0) return file; // angoli misti: non è uno sfondo uniforme
      bg = [0, 1, 2].map((c) => Math.round(solid.reduce((n, i) => n + d[i + c], 0) / solid.length));
      const uniform = solid.every((i) => Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) <= tolerance);
      if (!uniform) return file; // foto o sfondo non uniforme
    }

    if (bg) {
      // Riempimento dai bordi: solo lo sfondo collegato ai bordi diventa trasparente
      const isBg = (i) => d[i + 3] < 12 || Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) <= tolerance;
      const seen = new Uint8Array(w * h);
      const stack = [];
      const push = (x, y) => {
        const p = y * w + x;
        if (seen[p] || !isBg(p * 4)) return;
        seen[p] = 1;
        stack.push(p);
      };
      for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
      for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
      while (stack.length) {
        const p = stack.pop();
        const x = p % w;
        const y = (p - x) / w;
        d[p * 4 + 3] = 0;
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < h - 1) push(x, y + 1);
      }
      ctx.putImageData(imageData, 0, 0);
    }

    // Riquadro del soggetto = pixel non trasparenti
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return file; // tutto trasparente: non si tocca

    const padX = Math.round((maxX - minX + 1) * padding);
    const padY = Math.round((maxY - minY + 1) * padding);
    const sx = Math.max(0, minX - padX);
    const sy = Math.max(0, minY - padY);
    const sw = Math.min(w, maxX + padX + 1) - sx;
    const sh = Math.min(h, maxY + padY + 1) - sy;
    if (!bg && sw >= w * 0.97 && sh >= h * 0.97 && scale === 1) return file; // niente da fare

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) return file;
    const base = (file.name || 'icona').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.png`, { type: 'image/png' });
  } catch (err) {
    return file;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
