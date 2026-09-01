// =============================================================
// ui-select.js — Sostituisce i <select> nativi con un pulsante e una
// tendina animata (stessa tecnica grid-template-rows già usata per le
// card scaffale: "si abbassa" invece di comparire di scatto).
//
// Il <select> originale resta nel DOM, solo nascosto: è ancora lui la
// fonte di verità per .value e per l'evento 'change', cosí il resto del
// codice (dashboard.js, products.js) non deve cambiare come legge o
// imposta il valore — continua a funzionare esattamente come prima.
// =============================================================

/**
 * @param {HTMLSelectElement} selectEl
 * @returns {{ sync: () => void, rebuild: () => void } | null}
 */
export function enhanceSelect(selectEl) {
  if (!selectEl || selectEl.dataset.enhanced === 'true') return null;
  selectEl.dataset.enhanced = 'true';

  const originalClass = selectEl.className;
  selectEl.classList.add('custom-select-native');

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `${originalClass} custom-select-trigger flex items-center justify-between gap-2`;

  const label = document.createElement('span');
  label.className = 'custom-select-label truncate';
  trigger.appendChild(label);

  const chevron = document.createElement('i');
  chevron.setAttribute('data-lucide', 'chevron-down');
  chevron.setAttribute('stroke-width', '2');
  chevron.className = 'custom-select-chevron w-4 h-4 shrink-0';
  trigger.appendChild(chevron);

  // Tendina: track esterno che anima l'altezza (0fr → 1fr), inner con
  // l'overflow nascosto e le opzioni reali dentro.
  const panelTrack = document.createElement('div');
  panelTrack.className = 'custom-select-panel-track';
  const panelInner = document.createElement('div');
  panelInner.className = 'custom-select-panel-inner card-plate rounded-lg border border-graphite-700';
  panelTrack.appendChild(panelInner);

  const optionButtons = [];

  function buildOptions() {
    panelInner.innerHTML = '';
    optionButtons.length = 0;
    [...selectEl.options].forEach((opt) => {
      const optBtn = document.createElement('button');
      optBtn.type = 'button';
      optBtn.className =
        'custom-select-option w-full text-left px-3.5 py-2.5 text-sm border-t border-graphite-700 first:border-t-0 flex items-center justify-between gap-2';
      optBtn.textContent = opt.textContent;
      optBtn.dataset.value = opt.value;
      optBtn.addEventListener('click', () => {
        if (selectEl.value !== opt.value) {
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        sync();
        close();
      });
      panelInner.appendChild(optBtn);
      optionButtons.push(optBtn);
    });
  }

  function sync() {
    const selected = selectEl.options[selectEl.selectedIndex];
    label.textContent = selected ? selected.textContent : '';
    optionButtons.forEach((btn) => btn.classList.toggle('custom-select-option-active', btn.dataset.value === selectEl.value));
  }

  let open = false;
  function openPanel() {
    if (open) return;
    open = true;
    wrap.classList.add('custom-select-open');
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }
  function close() {
    if (!open) return;
    open = false;
    wrap.classList.remove('custom-select-open');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }
  function onDocClick(e) {
    if (!wrap.contains(e.target)) close();
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  trigger.addEventListener('click', () => (open ? close() : openPanel()));

  buildOptions();
  sync();

  selectEl.insertAdjacentElement('afterend', wrap);
  wrap.appendChild(trigger);
  wrap.appendChild(panelTrack);

  window.lucide?.createIcons();

  return {
    sync,
    rebuild() {
      buildOptions();
      sync();
      window.lucide?.createIcons();
    },
  };
}
