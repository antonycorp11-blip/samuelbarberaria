// Layout do e-mail. Tabelas e estilos embutidos: é o que funciona em Gmail, Outlook e Apple Mail.

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const GOLD = '#d9a441'
const FONT = "font-family:Georgia,'Times New Roman',serif"
const SANS = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif'

/** Linhas "Rótulo: valor" viram o quadro de detalhes; o resto vira parágrafo. */
const DETAIL = /^([A-Za-zÀ-ú]{2,12}): (.+)$/

export function renderEmail(n: { subject: string; body: string }, appUrl: string, shopName: string) {
  const lines = n.body.split('\n').map((l) => l.trim()).filter(Boolean)
  const details = lines.map((l) => l.match(DETAIL)).filter((m) => m !== null)
  const paragraphs = lines.filter((l) => !DETAIL.test(l))
  const [intro, ...closing] = paragraphs

  const linkify = (html: string) =>
    html.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:${GOLD};font-weight:700">${url.includes('/agendar/cancelar') ? 'Cancelar este horário' : url}</a>`)
  const paragraph = (text: string) =>
    `<p style="margin:0 0 14px;${SANS};font-size:16px;line-height:1.55;color:#e9e4da">${linkify(escape(text))}</p>`

  const table = details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;background:#1c1915;border:1px solid #3a3226;border-radius:12px">
        ${details.map((m) => `<tr>
          <td style="padding:11px 16px;${SANS};font-size:14px;color:#a89e90;white-space:nowrap;vertical-align:top">${escape(m[1] as string)}</td>
          <td style="padding:11px 16px 11px 0;${SANS};font-size:15px;font-weight:600;color:#f5f0e7;text-align:right">${escape(m[2] as string)}</td>
        </tr>`).join('')}
      </table>`
    : ''

  const button = details.length
    ? ''
    : `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 6px"><tr><td style="background:${GOLD};border-radius:10px">
        <a href="${escape(appUrl)}/agendar" style="display:inline-block;padding:14px 26px;${SANS};font-size:16px;font-weight:700;color:#1b1407;text-decoration:none">Agendar horário</a>
      </td></tr></table>`

  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escape(n.subject)}</title></head>
<body style="margin:0;padding:0;background:#0b0a08">
  <div style="display:none;max-height:0;overflow:hidden">${escape(intro ?? n.subject)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0a08"><tr><td align="center" style="padding:28px 14px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#14110e;border:1px solid #3a3226;border-radius:18px">
      <tr><td align="center" style="padding:28px 24px 8px">
        <img src="${escape(appUrl)}/logo-email.png" width="104" height="104" alt="${escape(shopName)}" style="display:block;border:0;border-radius:18px">
      </td></tr>
      <tr><td style="padding:14px 28px 26px">
        <h1 style="margin:0 0 16px;${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${GOLD};text-align:center">${escape(n.subject)}</h1>
        ${intro ? paragraph(intro) : ''}
        ${table}
        ${closing.map(paragraph).join('')}
        ${button}
      </td></tr>
    </table>
    <p style="margin:16px 0 0;${SANS};font-size:12px;color:#7d7468">${escape(shopName)}</p>
  </td></tr></table>
</body>
</html>`
}
