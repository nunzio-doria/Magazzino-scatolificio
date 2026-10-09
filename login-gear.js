// =============================================================
// login-gear.js — l'ingranaggio del logo (schermata di accesso) si può "lanciare" col dito.
// Trascinandolo ruota seguendo il dito; al rilascio mantiene la velocità del gesto e poi
// rallenta con dolcezza fino alla rotazione normale (stesso comportamento del carosello).
// Le due parti visibili (alta e bassa) sono la stessa animazione CSS "mate-gear-run":
// qui se ne guida il tempo a mano, poi si restituisce il controllo al CSS.
// =============================================================
const RUN_NAME = 'mate-gear-run';
const RUN_DELAY_MS = 3020;       // deve coincidere con il ritardo di mate-gear-run in style.css
const RUN_PERIOD_MS = 14000;     // durata di un giro in style.css
const BASE_DEG_S = 360 / (RUN_PERIOD_MS / 1000); // velocità normale (gradi al secondo)
const MS_PER_DEG = RUN_PERIOD_MS / 360;
const SETTLE_MS = 1400;          // tempo con cui la velocità rientra a quella normale
const MAX_DEG_S = 1800;          // velocità massima di un lancio (gradi al secondo)

function initLoginGear() {
  const wrap = document.querySelector('.mate-logo-wrap');
  const pop = wrap?.querySelector('.mate-gear-pop');
  if (!wrap || !pop) return;

  let anims = [];
  let t = 0;                 // tempo dell'animazione guidato a mano (ms)
  let omega = BASE_DEG_S;    // velocità angolare attuale (gradi al secondo)
  let dragging = false;
  let active = false;        // true mentre il gioco di velocità è guidato da qui
  let pointerId = null;
  let cx = 0;
  let cy = 0;
  let radius = 1;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let dragOmega = 0;
  let last = 0;

  const findAnims = () => [...wrap.querySelectorAll('.mate-gear')]
    .map((img) => img.getAnimations().find((a) => a.animationName === RUN_NAME))
    .filter(Boolean);

  const apply = () => {
    // Un giro ricomincia identico a se stesso: si resta sempre dentro il primo periodo
    t = RUN_DELAY_MS + (((t - RUN_DELAY_MS) % RUN_PERIOD_MS) + RUN_PERIOD_MS) % RUN_PERIOD_MS;
    anims.forEach((a) => { a.currentTime = t; });
  };

  const frame = (now) => {
    if (!active) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!dragging) {
      omega += (BASE_DEG_S - omega) * (1 - Math.exp(-dt * 1000 / SETTLE_MS * 3));
      t += omega * dt * MS_PER_DEG;
      apply();
      if (Math.abs(omega - BASE_DEG_S) < 1.5) {
        // Di nuovo alla velocità normale: riparte l'animazione CSS da dove si trova
        active = false;
        anims.forEach((a) => { try { a.play(); } catch (_) { /* ignora */ } });
        return;
      }
    }
    requestAnimationFrame(frame);
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!pop.offsetParent) return;
    const found = active ? anims : findAnims();
    // Solo a rotazione normale avviata (finita la sequenza di apertura del logo)
    if (!found.length || found.some((a) => (a.currentTime ?? 0) < RUN_DELAY_MS)) return;
    const r = pop.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    radius = r.width / 2;
    // Il dito deve toccare l'ingranaggio (o la zona del logo che lo copre)
    if (Math.hypot(e.clientX - cx, e.clientY - cy) > radius * 1.05) return;
    anims = found;
    if (!active) {
      t = anims[0].currentTime;
      anims.forEach((a) => a.pause());
      omega = BASE_DEG_S;
    }
    active = true;
    dragging = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp;
    dragOmega = 0;
    last = performance.now();
    try { wrap.setPointerCapture(pointerId); } catch (_) { /* ignora */ }
    requestAnimationFrame(frame);
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const dtMs = Math.max(1, e.timeStamp - lastT);
    // Rotazione del dito attorno al centro: positiva = senso orario (come la rotazione CSS).
    // Vicino al centro il raggio è limitato, così un gesto che lo attraversa non fa impazzire l'ingranaggio.
    const rx = lastX - cx;
    const ry = lastY - cy;
    const r2 = Math.max(rx * rx + ry * ry, (radius * 0.45) ** 2);
    const deg = ((rx * dy - ry * dx) / r2) * (180 / Math.PI);
    t += deg * MS_PER_DEG;
    apply();
    dragOmega = dragOmega * 0.6 + ((deg / dtMs) * 1000) * 0.4;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp;
  });

  const release = (e) => {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    try { wrap.releasePointerCapture(pointerId); } catch (_) { /* ignora */ }
    // Dito fermo prima di staccarsi: niente lancio
    const idle = e ? e.timeStamp - lastT : 0;
    const w = idle > 90 ? 0 : dragOmega;
    omega = Math.max(-MAX_DEG_S, Math.min(MAX_DEG_S, w));
    last = performance.now();
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
  wrap.addEventListener('lostpointercapture', () => release(null));
}

initLoginGear();
