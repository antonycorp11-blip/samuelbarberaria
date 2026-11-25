import { useEffect, useRef, useState } from 'react'
import type { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { Button } from './kit'

/** Um código parado conta uma vez. Para repetir, tire da frente da câmera. */
export function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const handler = useRef(onCode)
  handler.current = onCode

  useEffect(() => {
    let stopped = false
    let controls: { stop: () => void } | null = null
    const seen = { text: '', at: 0 }
    const start = async () => {
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import('@zxing/browser'), import('@zxing/library'),
        ])
        if (stopped || !video.current) return
        const hints = new Map<DecodeHintType, BarcodeFormat[]>([[DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.QR_CODE, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A, BarcodeFormat.CODE_128,
        ]]])
        const reader = new BrowserMultiFormatReader(hints)
        // Câmera traseira: a padrão de muitos celulares é a frontal, que não serve para ler embalagem.
        const camera = { video: { facingMode: 'environment' }, audio: false }
        const active = await reader.decodeFromConstraints(camera, video.current, (result: { getText(): string } | undefined) => {
          if (stopped) return
          const now = Date.now()
          if (result) {
            const code = result.getText()
            if (code !== seen.text) handler.current(code)
            seen.text = code
            seen.at = now
          } else if (seen.text && now - seen.at > 700) {
            seen.text = ''
          }
        })
        controls = active
        if (stopped) active.stop()
      } catch (e) {
        if (stopped) return
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        setError(denied ? 'Libere o acesso à câmera para este site nas configurações do celular.' : 'Não foi possível abrir a câmera deste aparelho.')
      }
    }
    void start()
    return () => {
      stopped = true
      controls?.stop()
    }
  }, [])

  return (
    <div className="space-y-2 rounded-2xl bg-raised p-3">
      {error ? (
        <p className="p-3 text-center text-sm font-semibold text-bad">{error}</p>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={video} muted playsInline className="aspect-[4/3] w-full object-cover" />
          <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-brass/80" />
        </div>
      )}
      <p className="text-center text-[13px] text-muted">Aponte para um QR ou código de barras. Para ler o mesmo código de novo, afaste e aponte outra vez.</p>
      <Button block onClick={onClose}>Terminar leitura</Button>
    </div>
  )
}
