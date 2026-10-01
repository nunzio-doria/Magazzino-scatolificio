// =============================================================
// login-carousel.js — carosello orizzontale della schermata di accesso
// Scorre in continuo con ordine casuale a ogni apertura.
// PER USARE FOTO/LOGHI VERI: metti il file nella cartella carousel/ e
// aggiungi una riga in ITEMS (poi aggiungilo anche a service-worker.js
// nell'elenco APP_SHELL, se vuoi che si veda anche offline).
// Le voci qui sotto sono grafiche segnaposto, da sostituire.
// =============================================================
const ITEMS = [
  { src: './carousel/reparto.png', alt: 'Reparto' },
  { src: './carousel/forno.png', alt: 'Forno' },
];

const TILE_W = 168;       // larghezza scheda (px) — deve coincidere con style.css
const TILE_GAP = 12;      // spazio tra le schede (px)
const SPEED = 36;         // velocità di scorrimento (px al secondo)

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function tile(item, hidden) {
  const el = document.createElement('div');
  el.className = 'login-carousel-tile';
  const img = document.createElement('img');
  img.src = item.src;
  img.alt = hidden ? '' : item.alt;
  img.decoding = 'async';
  img.draggable = false;
  // Se un'immagine non si carica, la scheda sparisce senza lasciare buchi rotti
  img.addEventListener('error', () => el.remove());
  el.appendChild(img);
  return el;
}

function initLoginCarousel() {
  const track = document.getElementById('login-carousel-track');
  if (!track) return;
  const order = shuffle(ITEMS.slice());
  const step = TILE_W + TILE_GAP;
  // Ripete l'elenco finché un giro è più largo dello schermo, poi lo duplica
  // per il ciclo continuo senza stacchi.
  const repeats = Math.max(1, Math.ceil(window.innerWidth / (order.length * step)));
  const oneSet = [];
  for (let r = 0; r < repeats; r++) oneSet.push(...order);
  oneSet.forEach((it) => track.appendChild(tile(it, false)));
  oneSet.forEach((it) => track.appendChild(tile(it, true)));
  track.style.setProperty('--carousel-shift', `${oneSet.length * step}px`);
  track.style.setProperty('--carousel-duration', `${(oneSet.length * step) / SPEED}s`);
}

initLoginCarousel();
