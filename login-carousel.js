// =============================================================
// login-carousel.js — carosello orizzontale della schermata di accesso
// Scorre in continuo con ordine casuale a ogni apertura; si può trascinare col dito
// (o col mouse) e, al rilascio, rallenta con dolcezza e riprende da solo.
// PER USARE FOTO/LOGHI VERI: metti il file nella cartella carousel/ e
// aggiungi una riga in ITEMS (poi aggiungilo anche a service-worker.js
// nell'elenco APP_SHELL, se vuoi che si veda anche offline).
// Le voci qui sotto sono grafiche segnaposto, da sostituire.
// =============================================================
const ITEMS = [
  { src: './carousel/reparto.png', alt: 'Reparto' },
  { src: './carousel/forno.png', alt: 'Forno' },
  { src: './carousel/uniformer.jpg', alt: 'Uniformer' },
  { src: './carousel/saldatrice.jpg', alt: 'Saldatrice' },
  { src: './carousel/macchina.jpg', alt: 'Macchina' },
];

const TILE_W = 240;       // larghezza scheda (px) — deve coincidere con style.css
const TILE_GAP = 12;      // spazio tra le schede (px)
const SPEED = 36;         // velocità di scorrimento automatico (px al secondo)
const SETTLE_MS = 700;    // dopo un lancio, tempo con cui la velocità rientra a quella automatica
const MAX_FLING = 3200;   // velocità massima di un lancio (px al secondo)

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
  el.appendChild(img);
  return { el, img };
}

function initLoginCarousel() {
  const track = document.getElementById('login-carousel-track');
  if (!track) return;
  const host = track.parentElement;
  const order = shuffle(ITEMS.slice());
  const step = TILE_W + TILE_GAP;
  // Ripete l'elenco finché un giro è più largo dello schermo, poi lo duplica
  // per il ciclo continuo senza stacchi.
  const repeats = Math.max(1, Math.ceil(window.innerWidth / (order.length * step)));
  const oneSet = [];
  for (let r = 0; r < repeats; r++) oneSet.push(...order);

  let firstDup = null;
  oneSet.forEach((it) => track.appendChild(tile(it, false).el));
  oneSet.forEach((it, idx) => {
    const t = tile(it, true);
    if (idx === 0) firstDup = t.el;
    track.appendChild(t.el);
  });

  // Larghezza di un giro completo = distanza tra la prima scheda e la sua copia.
  let setWidth = oneSet.length * step;
  const measure = () => {
    if (firstDup && firstDup.isConnected && firstDup.offsetLeft > 0) setWidth = firstDup.offsetLeft;
  };
  // Se un'immagine non si carica, la scheda (e la sua copia) sparisce senza lasciare buchi rotti
  track.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      img.parentElement.remove();
      requestAnimationFrame(measure);
    });
  });
  window.addEventListener('resize', measure);
  requestAnimationFrame(measure);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const autoSpeed = () => (reduceMotion.matches ? 0 : -SPEED); // negativo = verso sinistra

  let x = 0;                 // spostamento del nastro (px)
  let vel = autoSpeed();     // velocità attuale (px/s)
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastT = 0;
  let dragVel = 0;           // velocità del dito, lisciata
  let last = performance.now();

  const wrap = () => {
    if (setWidth <= 0) return;
    x %= setWidth;
    if (x > 0) x -= setWidth;
  };

  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (track.offsetParent !== null && !dragging) {
      // Dopo il rilascio la velocità decelera con dolcezza fino a quella di crociera
      vel += (autoSpeed() - vel) * (1 - Math.exp(-dt * 1000 / SETTLE_MS * 3));
      x += vel * dt;
      wrap();
      track.style.transform = `translate3d(${x}px,0,0)`;
    }
    requestAnimationFrame(frame);
  };

  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastT = e.timeStamp;
    dragVel = 0;
    vel = 0;
    host.classList.add('is-dragging');
    try { host.setPointerCapture(pointerId); } catch (_) { /* ignora */ }
  });

  host.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    const dtMs = Math.max(1, e.timeStamp - lastT);
    x += dx;
    wrap();
    track.style.transform = `translate3d(${x}px,0,0)`;
    // velocità istantanea lisciata, per un lancio fedele al gesto
    dragVel = dragVel * 0.6 + ((dx / dtMs) * 1000) * 0.4;
    lastX = e.clientX;
    lastT = e.timeStamp;
  });

  const release = (e) => {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    host.classList.remove('is-dragging');
    try { host.releasePointerCapture(pointerId); } catch (_) { /* ignora */ }
    // Se il dito si era fermato prima di staccarsi, niente lancio
    const idle = e ? e.timeStamp - lastT : 0;
    const v = idle > 90 ? 0 : dragVel;
    vel = Math.max(-MAX_FLING, Math.min(MAX_FLING, v));
    last = performance.now();
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);
  host.addEventListener('lostpointercapture', () => release(null));

  requestAnimationFrame((t) => { last = t; frame(t); });
}

initLoginCarousel();
