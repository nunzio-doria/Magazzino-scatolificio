// =============================================================
// input-clear.js — Tasto "X" dentro ogni campo di testo dell'app.
// Compare quando il campo contiene qualcosa e lo svuota con un tocco, senza
// dover cancellare a mano dalla tastiera. Nessuna modifica ai singoli file:
// il modulo scova da solo tutti i campi (anche quelli creati dopo, come le
// ricerche dei selettori o l'elenco utenti) e ne aggiunge uno per campo.
//
// Regole:
// - campi di tipo text / email / number / tel / url / search; esclusi password,
//   checkbox, file, hidden, readonly e quelli con data-no-clear
// - i campi stretti (< 96px, es. il salto pagina del visualizzatore) restano senza X
// - la X è un pulsante assoluto accanto al campo (nessun wrapper: il layout non cambia)
// - svuotando si emette l'evento "input" come se si fosse cancellato a mano, così
//   filtri e ricerche si aggiornano da soli; il focus resta com'era (se la tastiera
//   era aperta resta aperta, se no non si apre)
// - il tocco sulla X dà un feedback aptico e sonoro (feedback.clearInput), che rispetta
//   le preferenze suoni/vibrazione delle Impostazioni
// =============================================================

import feedback from './feedback.js';

const CLEARABLE = new Set(['text', 'email', 'number', 'tel', 'url', 'search']);
const MIN_WIDTH = 96; // sotto questa larghezza la X non ci sta senza coprire il testo
const BTN = 20; // diametro visivo (px)
const EDGE = 10; // distanza dal bordo destro del campo (px)

const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const updaters = new WeakMap(); // elemento osservato → insieme di funzioni di riallineamento (un genitore può avere più campi)
const ro =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => entries.forEach((e) => updaters.get(e.target)?.forEach((fn) => fn())))
    : null;

const X_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function enhance(input) {
  if (input._clearBtn) return;
  const type = (input.getAttribute('type') || 'text').toLowerCase();
  if (!CLEARABLE.has(type) || input.hasAttribute('data-no-clear') || input.readOnly) return;
  const parent = input.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'input-clear';
  btn.tabIndex = -1; // non è una tappa della tastiera: il campo resta l'unico
  btn.setAttribute('aria-label', 'Cancella testo');
  btn.setAttribute('aria-hidden', 'true');
  btn.innerHTML = X_SVG;
  input.after(btn);
  input._clearBtn = btn;
  input.classList.add('has-clear'); // spazio a destra per la X, sempre: il testo non "salta" quando compare

  function update() {
    const w = input.offsetWidth;
    if (w > 0) input.classList.toggle('has-clear', w >= MIN_WIDTH);
    const show = input.value !== '' && w >= MIN_WIDTH && !input.disabled;
    btn.classList.toggle('input-clear-on', show);
    btn.setAttribute('aria-hidden', show ? 'false' : 'true');
    btn.style.left = `${input.offsetLeft + w - BTN - EDGE}px`;
    btn.style.top = `${input.offsetTop + (input.offsetHeight - BTN) / 2}px`;
  }

  // Cambi di valore da codice (input.value = '...') non emettono eventi: si intercetta il setter.
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return valueDesc.get.call(this);
    },
    set(v) {
      valueDesc.set.call(this, v);
      update();
    },
  });

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.form?.addEventListener('reset', () => setTimeout(update, 0));

  // Il tocco sulla X non deve togliere il focus al campo (altrimenti la tastiera si chiude).
  btn.addEventListener('pointerdown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (input.value === '') return;
    feedback.clearInput();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  if (ro) {
    [input, parent].forEach((el) => {
      if (!updaters.has(el)) updaters.set(el, new Set());
      updaters.get(el).add(update);
      ro.observe(el);
    });
  }
  update();
}

function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.tagName === 'INPUT') enhance(root);
  root.querySelectorAll?.('input').forEach(enhance);
}

function init() {
  scan(document.body);
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan))).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
