// =============================================================
// nav-history.js — Tasto "indietro" del telefono (e del browser).
//
// Ogni "livello" che si apre sopra la schermata corrente (una modale, il
// dettaglio di una macchina, la modalità modifica, un cambio di sezione...)
// aggiunge una voce alla cronologia del browser. Il tasto indietro toglie
// l'ultima voce e chiude quel livello, invece di uscire dall'app: si torna
// alla schermata da cui si veniva. Alla radice (nessun livello aperto) il
// tasto indietro fa quello di sempre.
//
// Le chiusure fatte dall'interfaccia (X, tocco fuori, salvataggio) chiamano
// releaseLayer(), che toglie la voce dalla cronologia: così i due percorsi
// restano sempre allineati.
// =============================================================

import feedback from './feedback.js';

const slots = []; // una voce per ogni entry di cronologia sopra la base: { open, close }
const queue = []; // operazioni sulla cronologia in attesa (history.go è asincrono)
let expecting = false; // true finché non arriva il popstate di un history.go() fatto da noi
let started = false;

function drain() {
  while (!expecting && queue.length) queue.shift()();
}

function enqueue(fn) {
  queue.push(fn);
  drain();
}

function goBack(n) {
  enqueue(() => {
    expecting = true;
    history.go(-n);
  });
}

/** Da chiamare una volta all'avvio. */
export function initNavHistory() {
  if (started) return;
  started = true;
  const depth = history.state?.navDepth || 0;
  if (depth > 0) {
    // Pagina ricaricata con voci di un'esecuzione precedente: si torna alla base.
    expecting = true;
    history.go(-depth);
  } else {
    history.replaceState({ ...(history.state || {}), navDepth: 0 }, '');
  }
  window.addEventListener('popstate', onPop);
}

/**
 * Registra un livello aperto. `close` viene chiamata SOLO quando l'utente preme
 * "indietro": deve chiudere il livello (e può chiamare releaseLayer, è innocuo).
 * @returns {object} il livello, da passare a releaseLayer() alla chiusura normale
 */
export function pushLayer(close) {
  const layer = { open: true, close };
  slots.push(layer);
  const depth = slots.length;
  enqueue(() => history.pushState({ navDepth: depth }, ''));
  return layer;
}

/** Il livello è stato chiuso dall'interfaccia: toglie la sua voce dalla cronologia. */
export function releaseLayer(layer) {
  if (!layer || !layer.open) return;
  layer.open = false;
  let n = 0;
  while (slots.length && !slots[slots.length - 1].open) {
    slots.pop();
    n += 1;
  }
  if (n) goBack(n);
  // Se il livello non era l'ultimo resta una voce "fantasma": onPop la scavalca da sola.
}

/** Chiude in silenzio tutti i livelli (logout): riporta la cronologia alla base. */
export function resetLayers() {
  const n = slots.length;
  slots.forEach((s) => {
    s.open = false;
  });
  slots.length = 0;
  if (n) goBack(n);
}

function onPop(event) {
  if (expecting) {
    expecting = false;
    drain();
    return;
  }
  const depth = event.state?.navDepth || 0;
  let closedSomething = false;
  let skipped = 0;
  while (slots.length > depth) {
    const layer = slots.pop();
    if (layer.open) {
      layer.open = false;
      closedSomething = true;
      try {
        layer.close();
      } catch (err) {
        console.error(err);
      }
    } else {
      skipped += 1;
    }
  }
  // Voce fantasma (livello già chiuso dall'interfaccia): non è cambiato nulla a schermo,
  // quindi si prosegue all'indietro fino a un livello reale o alla base.
  if (closedSomething) feedback.back();
  if (!closedSomething && skipped) history.go(-1);
}
