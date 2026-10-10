// =============================================================
// interventi-pdf.js — PDF degli interventi effettuati in una giornata (o periodo)
// Organizzato per linea e, dentro ogni linea, per macchina (ordine scelto in Impostazioni, come
// nell'app). Per ogni intervento si legge solo il lavoro effettuato: niente orari, nomi, note o foto,
// e niente data/ora di generazione. Sui telefoni che lo supportano si apre il foglio di
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
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * @param {Date} from inizio (00:00 del primo giorno)
 * @param {Date} to   fine (23:59:59 dell'ultimo giorno)
 * @returns {Promise<'empty'|'cancelled'|true>}
 */
export async function exportGiornoPdf(from, to, { rows: given = null } = {}) {
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

  // ---- Intestazione (senza data/ora di generazione) ----
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

  let y = 36;
  doc.setTextColor(...DEEP);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`${rows.length} ${rows.length === 1 ? 'intervento effettuato' : 'interventi effettuati'}`, M, y);
  y += 3;
  doc.setDrawColor(...LINE);
  doc.line(M, y, PW - M, y);
  y += 7;

  const ensure = (h) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M + 2;
    }
  };

  // ---- Organizzazione: Linea -> Macchina (ordine come nell'app) -> interventi ----
  // Solo l'intervento eseguito: niente orari, né chi l'ha annotato o eseguito, né note e foto.
  let order = [];
  try {
    order = await listDistinctMacchine();
  } catch (err) {
    console.warn('Ordine delle macchine non disponibile: si usa l\'alfabetico.', err);
  }
  const orderIdx = new Map(order.map((n, i) => [n.toLowerCase(), i]));
  const idxOf = (m) => (orderIdx.has(m.toLowerCase()) ? orderIdx.get(m.toLowerCase()) : 9999);
  const lineaIdx = (v) => (LINEE.findIndex((l) => l.value === v) + 1 || 99);

  const linee = [...new Set(rows.map((r) => r.linea))].sort((a, b) => lineaIdx(a) - lineaIdx(b));
  const LINE_H = 4.9; // altezza di una riga di testo (10,5 pt)

  for (const linea of linee) {
    const inLinea = rows.filter((r) => r.linea === linea);
    const machines = [...new Set(inLinea.map((r) => r.macchina))].sort((a, b) => idxOf(a) - idxOf(b) || a.localeCompare(b, 'it'));

    // fascia della linea (con almeno la prima macchina e il suo primo intervento sotto)
    ensure(34);
    doc.setFillColor(...DEEP);
    doc.roundedRect(M, y, CW, 8.5, 1.2, 1.2, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.text(lineaLabel(linea).toUpperCase(), M + 3.5, y + 5.9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`${inLinea.length}`, PW - M - 3.5, y + 5.9, { align: 'right' });
    y += 13;

    for (const macchina of machines) {
      const items = inLinea
        .filter((r) => r.macchina === macchina)
        .sort((a, b) => new Date(a.esito_at) - new Date(b.esito_at));

      // intestazione della macchina: non resta mai sola in fondo alla pagina
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      const firstLines = doc.splitTextToSize(items[0].descrizione || '', CW - 12);
      ensure(11 + firstLines.length * LINE_H);
      doc.setTextColor(...ACCENT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(macchina.toUpperCase(), M + 1, y + 4, { maxWidth: CW - 14 });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...GREY);
      doc.text(`${items.length}`, PW - M - 1, y + 4, { align: 'right' });
      doc.setDrawColor(...ACCENT);
      doc.setLineWidth(0.4);
      doc.line(M, y + 6, PW - M, y + 6);
      doc.setLineWidth(0.2);
      y += 11.5;

      for (const r of items) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        const lines = doc.splitTextToSize(r.descrizione || '', CW - 12);
        ensure(lines.length * LINE_H + 3);
        doc.setFillColor(...ACCENT);
        doc.circle(M + 3, y - 1.3, 0.9, 'F');
        doc.setTextColor(30, 30, 34);
        doc.text(lines, M + 7, y);
        y += lines.length * LINE_H + 2.4;
      }
      y += 3;
    }
    y += 3;
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
