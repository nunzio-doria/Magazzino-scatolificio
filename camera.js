// =============================================================
// camera.js — Gestione fotocamera condivisa (scanner principale +
// assegnazione barcode da form articolo). Un solo stream attivo
// alla volta: chi lo apre deve richiuderlo prima che un altro lo usi.
// =============================================================

import { toastError, toastInfo } from './toast.js';
import feedback from './feedback.js';

let html5Qrcode = null;
let isCameraRunning = false;
let availableCameras = []; // [{ id, label }] — cache condivisa tra tutti gli usi
let activeCameraIndex = 0;
let supportsManualFocus = false;
let supportsTorch = false;
let torchOn = false;
let activeContainerId = null;
let tapListenerEl = null;
let tapListenerFn = null;
let startToken = 0; // numero dell'ultima richiesta di avvio: chiudere o riavviare la rende obsoleta

/**
 * Avvia la fotocamera in un dato contenitore e inizia a leggere barcode.
 * @param {string} containerId id dell'elemento DOM dove montare il reader
 * @param {(code: string) => void} onDetected callback ad ogni codice letto
 * @param {{ focusHintEl?: HTMLElement, switchBtnEl?: HTMLElement, errorHint?: string }} [ui] elementi opzionali da aggiornare in base alle capacità rilevate; errorHint = suggerimento mostrato se la fotocamera non è accessibile
 * @returns {Promise<boolean|null>} true = avviata, false = non disponibile,
 *   null = richiesta superata (nel frattempo è stata chiusa o riavviata): non c'è nulla da fare
 */
export async function startCamera(containerId, onDetected, ui = {}) {
  if (isCameraRunning) await stopCamera();
  const myToken = ++startToken;
  const isStale = () => myToken !== startToken;
  let instance = null;
  try {
    // eslint-disable-next-line no-undef
    instance = new Html5Qrcode(containerId);
    html5Qrcode = instance;
    activeContainerId = containerId;
    await ensureCameraList();
    if (isStale()) return null;

    const chosen = availableCameras[activeCameraIndex];
    const cameraConfig = chosen ? { deviceId: { exact: chosen.id } } : { facingMode: 'environment' };
    const scanConfig = { fps: 12, qrbox: { width: 240, height: 80 }, aspectRatio: 1.6 };

    try {
      await instance.start(cameraConfig, scanConfig, (decodedText) => onDetected(decodedText), () => {});
    } catch (startErr) {
      if (isStale()) return null;
      console.warn('Avvio con deviceId fallito, riprovo con facingMode.', startErr);
      await instance.start({ facingMode: 'environment' }, scanConfig, (decodedText) => onDetected(decodedText), () => {});
    }

    if (isStale()) {
      // Nel frattempo è stata chiusa (o riavviata altrove): lo stream appena
      // aperto va spento subito, altrimenti resterebbe acceso senza controllo.
      await releaseStaleInstance(instance);
      return null;
    }

    isCameraRunning = true;
    ui.switchBtnEl?.classList.toggle('hidden', availableCameras.length < 2);
    await enableContinuousFocus(ui.focusHintEl);
    await detectTorchSupport(ui.torchBtnEl);
    attachTapToFocus(document.getElementById(containerId));
    return true;
  } catch (err) {
    if (isStale()) {
      await releaseStaleInstance(instance);
      return null;
    }
    console.error(err);
    toastError(`Impossibile accedere alla fotocamera. ${ui.errorHint || 'Controlla che sia consentita nelle impostazioni del browser.'}`);
    return false;
  }
}

/** Ferma un'istanza di avvio ormai obsoleta senza toccare quella eventualmente più recente. */
async function releaseStaleInstance(instance) {
  if (!instance) return;
  try {
    await instance.stop();
  } catch (err) {
    /* non era ancora partita davvero: niente da fermare */
  }
  // clear() svuota il contenitore: solo se non è già in uso da un avvio più recente
  if (html5Qrcode === instance) {
    try {
      await instance.clear();
    } catch (err) {
      /* già pulito */
    }
  }
}

export async function stopCamera() {
  startToken++; // rende obsoleto un eventuale avvio ancora in corso
  detachTapToFocus();
  if (html5Qrcode && isCameraRunning) {
    try {
      await html5Qrcode.stop();
      await html5Qrcode.clear();
    } catch (err) {
      console.warn(err);
    }
  }
  isCameraRunning = false;
  activeContainerId = null;
  supportsTorch = false;
  torchOn = false;
}

export function cameraIsRunning() {
  return isCameraRunning;
}

/** Recupera l'elenco fotocamere una sola volta (cache condivisa) e sceglie l'obiettivo principale */
async function ensureCameraList() {
  if (availableCameras.length) return;
  try {
    // eslint-disable-next-line no-undef
    const cams = await Html5Qrcode.getCameras();
    availableCameras = cams || [];
    activeCameraIndex = pickDefaultCameraIndex(availableCameras);
  } catch (err) {
    console.warn('Impossibile enumerare le fotocamere, uso facingMode di default.', err);
    availableCameras = [];
  }
}

/**
 * Sceglie l'obiettivo posteriore "principale", evitando l'ultra-grandangolo
 * ("0.5x"/"0.6x"/ultra wide) spesso selezionato di default da alcuni telefoni,
 * che rende difficile la messa a fuoco ravvicinata sui barcode.
 */
function pickDefaultCameraIndex(cameras) {
  if (!cameras.length) return 0;
  let bestIdx = 0;
  let bestScore = -Infinity;
  cameras.forEach((cam, idx) => {
    const l = (cam.label || '').toLowerCase();
    let score = 0;
    if (/front|user|selfie|anteriore/.test(l)) score -= 100;
    if (/back|rear|posteriore|environment/.test(l)) score += 10;
    if (/ultra.?wide|grandangolare|0\.5x|0\.6x/.test(l)) score -= 25;
    if (/tele(photo)?|zoom|[2-9]x/.test(l)) score -= 8;
    if (/\bwide\b/.test(l) && !/ultra/.test(l)) score += 6;
    if (/main|principale|normal/.test(l)) score += 8;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });
  return bestIdx;
}

/** Passa manualmente alla fotocamera successiva disponibile (utile se l'euristica sbaglia obiettivo) */
export async function switchCamera(onDetected, ui = {}) {
  if (availableCameras.length < 2 || !activeContainerId) return;
  const containerId = activeContainerId;
  activeCameraIndex = (activeCameraIndex + 1) % availableCameras.length;
  await stopCamera();
  const started = await startCamera(containerId, onDetected, ui);
  if (!started) return; // chiusa nel frattempo o non disponibile: niente feedback né avviso
  feedback.cameraSwitch();
  const label = availableCameras[activeCameraIndex]?.label || `Fotocamera ${activeCameraIndex + 1}`;
  toastInfo(`Fotocamera attiva: ${label}`, 2500);
}

/** Rileva se l'obiettivo attivo supporta il flash/torcia e mostra/nasconde il relativo pulsante */
async function detectTorchSupport(torchBtnEl) {
  supportsTorch = false;
  torchOn = false;
  torchBtnEl?.classList.remove('torch-active');
  try {
    const capabilities = html5Qrcode.getRunningTrackCapabilities?.();
    supportsTorch = !!capabilities?.torch;
  } catch (err) {
    supportsTorch = false;
  }
  torchBtnEl?.classList.toggle('hidden', !supportsTorch);
}

/**
 * Accende/spegne il flash della fotocamera attiva, se supportato.
 * @param {HTMLElement} [torchBtnEl] elemento pulsante da marcare come "attivo"
 * @returns {Promise<boolean>} lo stato risultante della torcia
 */
export async function toggleTorch(torchBtnEl) {
  if (!supportsTorch || !html5Qrcode || !isCameraRunning) return false;
  try {
    torchOn = !torchOn;
    await html5Qrcode.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
    torchBtnEl?.classList.toggle('torch-active', torchOn);
    feedback.cameraSwitch();
    return torchOn;
  } catch (err) {
    console.warn('Impossibile controllare il flash su questo dispositivo.', err);
    torchOn = false;
    return false;
  }
}

/** Attiva la messa a fuoco continua automatica, se supportata dal dispositivo */
async function enableContinuousFocus(focusHintEl) {
  supportsManualFocus = false;
  try {
    const capabilities = html5Qrcode.getRunningTrackCapabilities?.();
    if (!capabilities || !capabilities.focusMode) {
      focusHintEl?.classList.add('hidden');
      return;
    }
    if (capabilities.focusMode.includes('continuous')) {
      await html5Qrcode.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
    if (capabilities.focusMode.includes('single-shot') || capabilities.focusMode.includes('manual')) {
      supportsManualFocus = true;
    }
    focusHintEl?.classList.toggle('hidden', !supportsManualFocus);
  } catch (err) {
    console.warn('Messa a fuoco automatica non supportata su questo dispositivo.', err);
    focusHintEl?.classList.add('hidden');
  }
}

function attachTapToFocus(containerEl) {
  if (!containerEl) return;
  detachTapToFocus();
  tapListenerEl = containerEl;
  tapListenerFn = (event) => handleTapToFocus(event, containerEl);
  containerEl.addEventListener('click', tapListenerFn);
}

function detachTapToFocus() {
  if (tapListenerEl && tapListenerFn) tapListenerEl.removeEventListener('click', tapListenerFn);
  tapListenerEl = null;
  tapListenerFn = null;
}

/** Tocca lo schermo per forzare la messa a fuoco sul punto indicato (utile per barcode piccoli/vicini) */
async function handleTapToFocus(event, containerEl) {
  if (!isCameraRunning || !html5Qrcode) return;
  feedback.focusTap();
  showFocusRing(event.clientX, event.clientY, containerEl);
  if (!supportsManualFocus) return;

  try {
    const capabilities = html5Qrcode.getRunningTrackCapabilities?.();
    if (!capabilities || !capabilities.focusMode) return;

    const advanced = [];
    const videoEl = containerEl.querySelector('video');
    if (capabilities.pointsOfInterest && videoEl) {
      const rect = videoEl.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      advanced.push({ pointsOfInterest: [{ x, y }] });
    }
    if (capabilities.focusMode.includes('single-shot')) {
      advanced.push({ focusMode: 'single-shot' });
    }
    if (advanced.length) await html5Qrcode.applyVideoConstraints({ advanced });

    if (capabilities.focusMode.includes('continuous')) {
      setTimeout(() => {
        html5Qrcode?.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }, 1500);
    }
  } catch (err) {
    console.warn('Tap-to-focus non riuscito.', err);
  }
}

function showFocusRing(clientX, clientY, container) {
  const rect = container.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'focus-ring';
  ring.style.left = `${clientX - rect.left}px`;
  ring.style.top = `${clientY - rect.top}px`;
  container.appendChild(ring);
  setTimeout(() => ring.remove(), 550);
}
