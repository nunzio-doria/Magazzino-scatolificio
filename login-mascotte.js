// Mascotte della schermata di login.
// Pressione prolungata (3 s) sul logo centrale: la mascotte entra da destra verso sinistra (1 s),
// una stellina ruota sui denti e scompare, poi la mascotte esce con l'animazione inversa (1 s).

const HOLD_MS = 3000;
const ENTER_MS = 1000;
const STAR_MS = 1300;
const EXIT_MS = 1000;
const MOVE_TOLERANCE = 12;

// Curva di uscita = curva di entrata specchiata (animazione inversa esatta)
const EASE_IN = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const EASE_OUT = 'cubic-bezier(0.8, 0, 0.8, 0.2)';

// Posizione dei denti, in frazione dell'immagine (larghezza, altezza)
const TEETH = { x: 0.624, y: 0.449 };

const LOGO_SELECTORS = '.mate-brand';

const IMG_URL = new URL('./icons/mascotte.png', import.meta.url).href;

let running = false;
let styleReady = false;

function ensureStyle() {
  if (styleReady) return;
  styleReady = true;
  const s = document.createElement('style');
  s.textContent = `
    .login-mascotte{position:fixed;right:0;bottom:0;z-index:9000;pointer-events:none;
      height:min(52vh,400px);aspect-ratio:825/1092;will-change:transform;transform:translateX(110%)}
    .login-mascotte img{display:block;width:100%;height:100%;user-select:none;-webkit-user-drag:none;
      filter:drop-shadow(0 6px 14px rgba(0,0,0,.28))}
    .login-mascotte-star{position:absolute;width:22%;aspect-ratio:1;opacity:0;transform:translate(-50%,-50%) scale(0);
      filter:drop-shadow(0 0 6px #fff) drop-shadow(0 0 14px rgba(255,214,90,.95));will-change:transform,opacity}
    .login-logo-holding{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
  `;
  document.head.appendChild(s);
}

function starSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.cssText = 'width:100%;height:100%;display:block';
  const outer = document.createElementNS(ns, 'path');
  outer.setAttribute('d', 'M50 0 C54 34 66 46 100 50 C66 54 54 66 50 100 C46 66 34 54 0 50 C34 46 46 34 50 0Z');
  outer.setAttribute('fill', '#fff7d1');
  const inner = document.createElementNS(ns, 'path');
  inner.setAttribute('d', 'M50 22 C52 42 58 48 78 50 C58 52 52 58 50 78 C48 58 42 52 22 50 C42 48 48 42 50 22Z');
  inner.setAttribute('fill', '#ffffff');
  svg.append(outer, inner);
  return svg;
}

function preload() {
  const i = new Image();
  i.src = IMG_URL;
  return i.decode ? i.decode().catch(() => {}) : Promise.resolve();
}

async function play() {
  if (running) return;
  running = true;
  ensureStyle();
  await preload();

  const box = document.createElement('div');
  box.className = 'login-mascotte';
  box.setAttribute('aria-hidden', 'true');
  const img = document.createElement('img');
  img.src = IMG_URL;
  img.alt = '';
  img.draggable = false;
  const star = document.createElement('div');
  star.className = 'login-mascotte-star';
  star.style.left = `${TEETH.x * 100}%`;
  star.style.top = `${TEETH.y * 100}%`;
  star.appendChild(starSvg());
  box.append(img, star);
  document.body.appendChild(box);

  try {
    if (navigator.vibrate) navigator.vibrate(25);

    // 1) entra da destra verso sinistra
    await box.animate(
      [{ transform: 'translateX(110%)' }, { transform: 'translateX(0)' }],
      { duration: ENTER_MS, easing: EASE_IN, fill: 'forwards' }
    ).finished;
    box.style.transform = 'translateX(0)';

    // 2) stellina che ruota sui denti e scompare
    await star.animate([
      { opacity: 0, transform: 'translate(-50%,-50%) scale(0) rotate(0deg)', offset: 0 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1.25) rotate(200deg)', offset: 0.35 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(420deg)', offset: 0.7 },
      { opacity: 0, transform: 'translate(-50%,-50%) scale(0) rotate(720deg)', offset: 1 },
    ], { duration: STAR_MS, easing: 'ease-in-out', fill: 'forwards' }).finished;

    // 3) esce con l'animazione inversa
    await box.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(110%)' }],
      { duration: EXIT_MS, easing: EASE_OUT, fill: 'forwards' }
    ).finished;
  } catch (_) {
    /* animazione interrotta: si ripulisce comunque */
  } finally {
    box.remove();
    running = false;
  }
}

export function initLoginMascotte() {
  if (window.__loginMascotteReady) return;
  window.__loginMascotteReady = true;

  let timer = null;
  let startX = 0;
  let startY = 0;
  let holdEl = null;

  const isLogo = (x, y) => document.elementsFromPoint(x, y).some((el) => el.matches?.(LOGO_SELECTORS) || el.closest?.(LOGO_SELECTORS));

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (holdEl) { holdEl.classList.remove('login-logo-holding'); holdEl = null; }
  };

  document.addEventListener('pointerdown', (e) => {
    if (running || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!isLogo(e.clientX, e.clientY)) return;
    cancel();
    ensureStyle();
    preload();
    startX = e.clientX;
    startY = e.clientY;
    holdEl = e.target instanceof Element ? e.target : null;
    holdEl?.classList.add('login-logo-holding');
    timer = setTimeout(() => { cancel(); play(); }, HOLD_MS);
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE) cancel();
  }, { passive: true });
  ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach((t) => document.addEventListener(t, cancel, { passive: true }));
  window.addEventListener('blur', cancel);
  document.addEventListener('contextmenu', (e) => { if (timer || running) e.preventDefault(); });
}

initLoginMascotte();
