import qrcode from 'qrcode-generator'
import { Copy, Download, Share2 } from 'lucide-react'
import { useMemo } from 'react'
import { Button, Sheet, toast } from './kit'

function matrix(text: string) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  return { size, dark: (r: number, c: number) => qr.isDark(r, c) }
}

export function QrSvg({ text, size = 220 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const m = matrix(text)
    let d = ''
    for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { d, n: m.size }
  }, [text])
  return (
    <svg viewBox={`-2 -2 ${path.n + 4} ${path.n + 4}`} width={size} height={size} role="img" aria-label="QR code" className="rounded-xl bg-white">
      <path d={path.d} fill="#000" />
    </svg>
  )
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })

/** Cartaz pronto para imprimir no balcão ou postar no Instagram (1080x1350). */
async function poster(text: string, title: string, caption: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 1080
  canvas.height = 1350
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = '#000'
  g.fillRect(0, 0, 1080, 1350)
  const logo = await loadImage('/logo.webp').catch(() => null)
  if (logo) g.drawImage(logo, 390, 70, 300, 300)
  g.fillStyle = '#d9a441'
  g.textAlign = 'center'
  g.font = 'bold 64px Georgia, serif'
  g.fillText(title, 540, 470, 980)
  const m = matrix(text)
  const box = 560
  const cell = Math.floor(box / (m.size + 4))
  const side = cell * (m.size + 4)
  const x0 = (1080 - side) / 2
  const y0 = 520
  g.fillStyle = '#fff'
  g.beginPath()
  g.roundRect(x0, y0, side, side, 28)
  g.fill()
  g.fillStyle = '#000'
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.dark(r, c)) g.fillRect(x0 + (c + 2) * cell, y0 + (r + 2) * cell, cell, cell)
  g.fillStyle = '#f5f0e7'
  g.font = '40px Georgia, serif'
  g.fillText(caption, 540, y0 + side + 90, 980)
  g.fillStyle = '#a89e90'
  g.font = '30px sans-serif'
  g.fillText('Aponte a câmera do celular', 540, y0 + side + 150)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'))
}

export function QrSheet({ text, title, caption, onClose }: { text: string; title: string; caption: string; onClose: () => void }) {
  const file = async () => new File([await poster(text, title, caption)], 'qr-barbearia.png', { type: 'image/png' })
  const download = async () => {
    const url = URL.createObjectURL(await file())
    const a = document.createElement('a')
    a.href = url
    a.download = 'qr-barbearia.png'
    a.click()
    URL.revokeObjectURL(url)
  }
  const share = async () => {
    const f = await file()
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title, text: caption }).catch(() => {})
    else await download()
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-raised p-5">
        <QrSvg text={text} />
        <p className="text-center text-sm text-muted">{caption}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" onClick={() => void share()}><Share2 size={17} /> Compartilhar</Button>
        <Button onClick={() => void download()}><Download size={17} /> Baixar cartaz</Button>
      </div>
      <Button block variant="ghost" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast.ok('Link copiado'))}>
        <Copy size={16} /> Copiar link
      </Button>
    </Sheet>
  )
}
