// =============================================================
// interventi-pdf.js — PDF degli interventi effettuati in una giornata (o periodo)
// Raggruppa per macchina (nell'ordine scelto in Impostazioni, come nell'app), con linea, descrizione,
// esito, operatori e orari (senza foto). Sui telefoni che lo supportano si apre il foglio di
// condivisione (mail, WhatsApp…); altrimenti il file viene scaricato.
// =============================================================

import { listEffettuatiRange, LINEE, lineaLabel } from './interventi-data.js';

export { listEffettuatiRange };
import { loadLib } from './ui-utils.js';
import { listDistinctMacchine } from './supabase.js';
import { confirmDialog } from './ui-modal.js';

const ACCENT = [47, 79, 146];
const DEEP = [19, 34, 63];
const GREY = [98, 102, 110];
const LINE = [195, 201, 209];

const fmtDate = (d) => d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDT = (iso) => (iso ? `${fmtDate(new Date(iso))} ${fmtTime(iso)}` : '');
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * @param {Date} from inizio (00:00 del primo giorno)
 * @param {Date} to   fine (23:59:59 dell'ultimo giorno)
 * @returns {Promise<'empty'|'cancelled'|true>}
 */
export async function exportGiornoPdf(from, to, { authorName = '', rows: given = null } = {}) {
  // `rows`: gli interventi scelti dall'utente; senza, si prendono tutti quelli effettuati nel periodo
  const rows = given ?? (await listEffettuatiRange(from.toISOString(), to.toISOString()));
  if (!rows.length) return 'empty';

  await loadLib('jspdf');
  const { jsPDF } = window.jspdf;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M = 14;
  const CW = PW - M * 2;
  const BOTTOM = PH - 16;
  const sameDay = isoDay(from) === isoDay(to);
  const periodo = sameDay ? fmtDate(from) : `${fmtDate(from)} - ${fmtDate(to)}`;

  // ---- Intestazione ----
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PW, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('Rapporto interventi di manutenzione', M, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Scatolificio Sarno  |  Interventi effettuati', M, 19);
  doc.setFont('helvetica', 'bold');
  doc.text(periodo, PW - M, 12, { align: 'right' });

  let y = 33;
  doc.setTextColor(...GREY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generato il ${fmtDT(new Date().toISOString())}${authorName ? ` da ${authorName}` : ''}`, M, y);

  // ---- Riepilogo per linea ----
  y += 7;
  const counts = LINEE.map((l) => ({ label: l.label, n: rows.filter((r) => r.linea === l.value).length })).filter((c) => c.n);
  doc.setTextColor(...DEEP);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`${rows.length} ${rows.length === 1 ? 'intervento effettuato' : 'interventi effettuati'}`, M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...GREY);
  doc.text(counts.map((c) => `${c.label}: ${c.n}`).join('   |   '), PW - M, y, { align: 'right' });
  y += 3;
  doc.setDrawColor(...LINE);
  doc.line(M, y, PW - M, y);
  y += 6;

  const ensure = (h) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M + 2;
    }
  };

  // ---- Interventi, per macchina (ordine delle macchine come nell'app) ----
  let order = [];
  try {
    order = await listDistinctMacchine();
  } catch (err) {
    console.warn('Ordine delle macchine non disponibile: si usa l\'alfabetico.', err);
  }
  const orderIdx = new Map(order.map((n, i) => [n.toLowerCase(), i]));
  const idxOf = (m) => (orderIdx.has(m.toLowerCase()) ? orderIdx.get(m.toLowerCase()) : 9999);
  const lineaIdx = (v) => LINEE.findIndex((l) => l.value === v);
  const machines = [...new Set(rows.map((r) => r.macchina))].sort((a, b) => idxOf(a) - idxOf(b) || a.localeCompare(b, 'it'));

  for (const macchina of machines) {
    const group = rows
      .filter((r) => r.macchina === macchina)
      .sort((a, b) => lineaIdx(a.linea) - lineaIdx(b.linea) || new Date(a.esito_at) - new Date(b.esito_at));

    ensure(16);
    doc.setFillColor(...DEEP);
    doc.roundedRect(M, y, CW, 7.5, 1.2, 1.2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(macchina.toUpperCase(), M + 3, y + 5.2, { maxWidth: CW - 20 });
    doc.setFont('helvetica', 'normal');
    doc.text(`${group.length}`, PW - M - 3, y + 5.2, { align: 'right' });
    y += 11;

    for (const r of group) {
      const innerW = CW - 8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const descLines = doc.splitTextToSize(r.descrizione || '', innerW);
      doc.setFontSize(9.5);
      const noteLines = r.note_esito ? doc.splitTextToSize(`Esito: ${r.note_esito}`, innerW) : [];

      const h = 9 + descLines.length * 4.6 + (noteLines.length ? noteLines.length * 4.4 + 1.5 : 0) + 6 + 4;
      ensure(h);

      // scheda
      doc.setDrawColor(...LINE);
      doc.setLineWidth(0.3);
      doc.roundedRect(M, y, CW, h, 1.5, 1.5, 'S');
      doc.setFillColor(...ACCENT);
      doc.rect(M, y + 0.6, 1.4, h - 1.2, 'F');

      let cy = y + 6.5;
      // La macchina è già nell'intestazione del gruppo: nella scheda si indica la linea
      doc.setTextColor(...ACCENT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(lineaLabel(r.linea).toUpperCase(), M + 5, cy);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...GREY);
      doc.text(sameDay ? fmtTime(r.esito_at) : fmtDT(r.esito_at), PW - M - 4, cy, { align: 'right' });
      cy += 5.5;

      doc.setTextColor(30, 30, 34);
      doc.setFontSize(10);
      doc.text(descLines, M + 5, cy);
      cy += descLines.length * 4.6;

      if (noteLines.length) {
        cy += 1.5;
        doc.setFontSize(9.5);
        doc.setTextColor(...GREY);
        doc.text(noteLines, M + 5, cy);
        cy += noteLines.length * 4.4;
      }

      cy += 4.5;
      doc.setFontSize(8.5);
      doc.setTextColor(...GREY);
      const who = [
        r.created_by_name ? `Annotato da ${r.created_by_name} (${fmtDT(r.created_at)})` : `Annotato il ${fmtDT(r.created_at)}`,
        r.esito_by_name ? `Eseguito da ${r.esito_by_name}` : '',
      ].filter(Boolean).join('  |  ');
      doc.text(who, M + 5, cy, { maxWidth: CW - 10 });

      y += h + 4;
    }
    y += 2;
  }

  // ---- Numeri di pagina ----
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(...GREY);
    doc.text(`Pagina ${i} di ${total}`, PW - M, PH - 8, { align: 'right' });
    doc.text(`Interventi ${periodo}`, M, PH - 8);
  }

  // ---- Consegna: condividi (mail…) o scarica ----
  const name = sameDay ? `interventi_${isoDay(from)}.pdf` : `interventi_${isoDay(from)}_${isoDay(to)}.pdf`;
  const blob = doc.output('blob');
  const file = new File([blob], name, { type: 'application/pdf' });
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  if (canShare) {
    // Il foglio di condivisione richiede un tocco appena avvenuto: lo si ottiene dalla scelta
    const share = await confirmDialog({
      title: 'PDF pronto',
      message: `${rows.length} ${rows.length === 1 ? 'intervento' : 'interventi'} del ${periodo}. Vuoi inviarlo (mail, WhatsApp…) o salvarlo sul telefono?`,
      confirmLabel: 'Invia',
      cancelLabel: 'Salva',
    });
    if (share) {
      try {
        await navigator.share({ files: [file], title: `Interventi ${periodo}`, text: `Interventi di manutenzione effettuati - ${periodo}` });
        return true;
      } catch (err) {
        if (err?.name === 'AbortError') return 'cancelled';
        // se la condivisione non parte, ripiega sul download
      }
    }
  }
  doc.save(name);
  return true;
}
