// =============================================================
// manuals-data.js — Cache dei manuali (ricambi, operatore, sezioni),
// condivisa da machines.js (Impostazioni) e da products.js (Ricambi
// tecnici). Codice spostato qui pari pari da manuals.js: stessa logica,
// stesso comportamento, solo riorganizzato in un file più piccolo.
// Nessuna dipendenza dal visualizzatore PDF: solo dati.
// =============================================================

import { listMachineManuals, listOperatorManuals, listManualSections, normalizeMachineName } from './supabase.js';

let manualsByMachineId = new Map(); // machine_id -> Map<linea, riga machine_manuals> (linea '' = generale)
let manualsByMachineName = new Map(); // nome macchina normalizzato (minuscolo) -> Map<linea, riga>
let manualsTableMissing = false;
let operatorManualsByMachineId = new Map(); // machine_id -> Array<riga machine_operator_manuals> (più di uno per macchina)
let operatorManualsTableMissing = false;
let sectionsByOperatorManualId = new Map(); // operator_manual_id -> Array<riga machine_manual_sections>, in ordine
let sectionsTableMissing = false;

/** Ricarica dal database le mappe machine_id/nome → { linea → manuale } (ricambi) e machine_id → [manuali] (operatore). Va richiamata dopo ogni upload/eliminazione. */
export async function refreshManualsCache() {
  try {
    const [{ manuals, tableMissing }, { manuals: opManuals, tableMissing: opTableMissing }, { sections, tableMissing: sectionsMissing }] = await Promise.all([
      listMachineManuals(),
      listOperatorManuals(),
      listManualSections(),
    ]);
    manualsByMachineId = new Map();
    manualsByMachineName = new Map();
    manuals.forEach((row) => {
      if (!manualsByMachineId.has(row.machine_id)) manualsByMachineId.set(row.machine_id, new Map());
      manualsByMachineId.get(row.machine_id).set(row.linea || '', row);

      const nomeKey = normalizeMachineName(row.machines?.nome).toLowerCase();
      if (nomeKey) {
        if (!manualsByMachineName.has(nomeKey)) manualsByMachineName.set(nomeKey, new Map());
        manualsByMachineName.get(nomeKey).set(row.linea || '', row);
      }
    });
    manualsTableMissing = tableMissing;

    operatorManualsByMachineId = new Map();
    opManuals.forEach((row) => {
      if (!operatorManualsByMachineId.has(row.machine_id)) operatorManualsByMachineId.set(row.machine_id, []);
      operatorManualsByMachineId.get(row.machine_id).push(row);
    });
    operatorManualsTableMissing = opTableMissing;

    sectionsByOperatorManualId = new Map();
    sections.forEach((row) => {
      if (!sectionsByOperatorManualId.has(row.operator_manual_id)) sectionsByOperatorManualId.set(row.operator_manual_id, []);
      sectionsByOperatorManualId.get(row.operator_manual_id).push(row);
    });
    sectionsTableMissing = sectionsMissing;
  } catch (err) {
    console.warn('Impossibile caricare l\'elenco dei manuali.', err);
  }
  return manualsByMachineId;
}

/**
 * Manuale (riga machine_manuals) per una macchina (per id), con ripiego sul
 * manuale "generale" (linea vuota) se non esiste uno specifico per `linea`.
 */
export function getManualForMachine(machineId, linea = '') {
  const byLinea = machineId && manualsByMachineId.get(machineId);
  if (!byLinea) return null;
  return byLinea.get(linea || '') || byLinea.get('') || null;
}

/** Tutte le varianti (per linea) caricate per una macchina, dato il suo id. Chiave '' = generale. */
export function getManualsForMachine(machineId) {
  return manualsByMachineId.get(machineId) || new Map();
}

/**
 * Manuale per una macchina dato il suo nome testuale (es. `products.macchina`)
 * e la linea del pezzo (es. `products.linea`), con ripiego sul manuale
 * generale della stessa macchina se non ce n'è uno specifico per la linea.
 */
export function getManualForMachineName(nome, linea = '') {
  const key = normalizeMachineName(nome).toLowerCase();
  const byLinea = key && manualsByMachineName.get(key);
  if (!byLinea) return null;
  return byLinea.get(linea || '') || byLinea.get('') || null;
}

export function isManualsTableMissing() {
  return manualsTableMissing;
}

/** Il "miglior" manuale ricambi disponibile per una macchina, per chi non ha una linea specifica da cercare (vista Manuali): il generale se c'è, altrimenti il primo caricato. */
export function getAnyManualForMachine(machineId) {
  const byLinea = machineId && manualsByMachineId.get(machineId);
  if (!byLinea || byLinea.size === 0) return null;
  return byLinea.get('') || byLinea.values().next().value;
}

/** Tutti i manuali operatore caricati per una macchina (nell'ordine di caricamento), dato il suo id. */
export function getOperatorManualsForMachine(machineId) {
  return operatorManualsByMachineId.get(machineId) || [];
}

export function isOperatorManualsTableMissing() {
  return operatorManualsTableMissing;
}

/** Tutte le sezioni/pulsanti (in ordine) definiti per un manuale operatore. */
export function getSectionsForOperatorManual(operatorManualId) {
  return sectionsByOperatorManualId.get(operatorManualId) || [];
}

export function isSectionsTableMissing() {
  return sectionsTableMissing;
}
