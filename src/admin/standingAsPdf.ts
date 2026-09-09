// The fixe Atemschutz-URL as a printable A5 card (laminate, hang on the Überwachungstafel).
// Same lazy-chunk pattern as capturePdf: jsPDF + qrcode load only when the button is tapped,
// and the file downloads — no popup, no print dialog; the admin decides when to print.

import { jsPDF } from 'jspdf'
import { toDataURL } from 'qrcode'
import { appConfig } from '../config/appConfig'

const A5 = { w: 148, h: 210 }

export async function downloadStandingAsCard(url: string, stationName: string): Promise<void> {
  const C = appConfig.copy.admin.atemschutzUrl
  const qr = await toDataURL(url, { width: 1024, margin: 1 })
  const doc = new jsPDF({ unit: 'mm', format: 'a5' })
  const cx = A5.w / 2

  doc.setFont('helvetica', 'normal').setFontSize(12).setTextColor(90)
  doc.text(stationName, cx, 22, { align: 'center' })
  doc.setFont('helvetica', 'bold').setFontSize(24).setTextColor(20)
  doc.text(C.cardHead, cx, 34, { align: 'center' })

  const qrSize = 96
  doc.addImage(qr, 'PNG', cx - qrSize / 2, 46, qrSize, qrSize)

  doc.setFont('helvetica', 'normal').setFontSize(12).setTextColor(60)
  doc.text(C.cardHint, cx, 156, { align: 'center', maxWidth: A5.w - 28 })

  // The address in the clear, small: the fallback for a camera that will not scan, and the
  // honest label of what this piece of paper IS — whoever holds it holds the access.
  doc.setFontSize(7).setTextColor(130)
  doc.text(url, cx, A5.h - 10, { align: 'center', maxWidth: A5.w - 20 })
  doc.save('atemschutz-qr-karte.pdf')
}
