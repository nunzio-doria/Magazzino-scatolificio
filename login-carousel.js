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
  // Luce del neon: ogni scheda è tanto più illuminata quanto più è vicina al centro dello schermo.
  // Si scrive in --d (0 centro, 1 lati) la distanza della scheda dal centro, a ogni spostamento del nastro.
  let tiles = [];
  let centers = [];
  const refreshTiles = () => {
    tiles = Array.from(track.children);
    centers = tiles.map((t) => t.offsetLeft + t.offsetWidth / 2);
  };
  const light = () => {
    const half = host.clientWidth / 2;
    if (!half) return;
    for (let i = 0; i < tiles.length; i++) {
      const d = Math.min(1, Math.abs(centers[i] + x - half) / (half * 1.15));
      tiles[i].style.setProperty('--d', d.toFixed(3));
    }
  };
  const measure = () => {
    refreshTiles();
    light();
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
  // Il carosello resta fermo e non si può trascinare finché non inizia a girare l'ingranaggio del logo
  // (con "riduci animazioni" non c'è sequenza da aspettare: nessuna attesa).
  let started = reduceMotion.matches;
  const setStarted = (v) => {
    started = v;
    host.classList.toggle('is-locked', !v);
  };
  setStarted(started);
  const view = document.getElementById('auth-view');
  if (view && !reduceMotion.matches) {
    view.addEventListener('animationstart', (e) => {
      if (e.target === view && e.animationName === 'auth-neon') {
        setStarted(false);               // nuova presentazione della schermata: di nuovo fermo e bloccato
        vel = 0;
      } else if (e.animationName === 'mate-gear-start') {
        setStarted(true);                // l'ingranaggio inizia a girare: parte il carosello
      }
    });
    // Se la sequenza era già arrivata alla rotazione prima che questo codice partisse, non aspetta oltre
    const gearAnim = view.querySelector('.mate-gear')?.getAnimations?.().find((a) => a.animationName === 'mate-gear-start');
    if (gearAnim && gearAnim.currentTime > 0) setStarted(true);
  }
  const autoSpeed = () => (reduceMotion.matches || !started ? 0 : -SPEED); // negativo = verso sinistra

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
      light();
    }
    requestAnimationFrame(frame);
  };

  host.addEventListener('pointerdown', (e) => {
    if (!started) return;
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
    light();
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

// =============================================================
// Luce neon della schermata di accesso (variabile CSS --neon: 0 spento, 1 acceso).
// È la prima cosa che succede alla comparsa della schermata: la luce si accende in 2 secondi con un
// lampeggio diverso a ogni apertura della pagina (pochi tentativi sempre più lunghi e luminosi,
// poi sale piano a piena luce). Se questo non parte, resta il lampeggio base in style.css.
// =============================================================
const NEON_MS = 2000;

function neonKeyframes() {
  const r = (a, b) => a + Math.random() * (b - a);
  const rampMs = r(380, 520);                 // ultimo tratto: sale piano a piena luce
  const flickMs = NEON_MS - rampMs;
  const hold = 'steps(1, end)';               // lampeggio netto: il valore resta fino al passo dopo
  const kf = [{ offset: 0, '--neon': '0', easing: hold }];
  let t = r(60, 320);                         // buio iniziale
  let on = true;
  while (t < flickMs - 40) {
    const p = t / flickMs;                    // 0 → 1: i lampi diventano più forti e lunghi
    const level = on ? r(0.3 + 0.35 * p, 0.65 + 0.35 * p) : r(0, 0.14);
    kf.push({ offset: t / NEON_MS, '--neon': level.toFixed(2), easing: hold });
    t += on ? r(35, 80 + 130 * p) : r(45, 230 - 120 * p);
    on = !on;
  }
  kf.push({ offset: flickMs / NEON_MS, '--neon': r(0.5, 0.75).toFixed(2), easing: 'ease-out' });
  kf.push({ offset: 1, '--neon': '1' });
  return kf;
}

function initLoginNeon() {
  const view = document.getElementById('auth-view');
  if (!view || typeof view.animate !== 'function') return;
  // "animationstart" dell'accensione base scatta a ogni presentazione della schermata
  view.addEventListener('animationstart', (e) => {
    if (e.target !== view || e.animationName !== 'auth-neon') return;
    try {
      view.animate(neonKeyframes(), { duration: NEON_MS, easing: 'linear', fill: 'none' });
    } catch (_) { /* resta il lampeggio base in CSS */ }
  });
}

initLoginNeon();
