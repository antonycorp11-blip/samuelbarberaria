import { useEffect, useRef, useState } from 'react'
import { Button } from './kit'

/**
 * Câmera dentro do app lendo QR sem parar. Um QR parado na frente da câmera conta uma vez só:
 * para lançar o mesmo serviço de novo, ele precisa sair da frente da câmera e voltar.
 */
export function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const handler = useRef(onCode)
  handler.current = onCode

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer = 0
    let stopped = false
    // QR que está na frente da câmera agora; some depois de um instante sem ser visto.
    const seen = { text: '', at: 0 }
    const canvas = document.createElement('canvas')
    const g = canvas.getContext('2d', { willReadFrequently: true })

    const start = async () => {
      try {
        const [{ default: jsQR }, media] = await Promise.all([
          import('jsqr'),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }),
        ])
        stream = media
        if (stopped || !video.current) return media.getTracks().forEach((t) => t.stop())
        video.current.srcObject = media
        await video.current.play()
        const tick = () => {
          if (stopped) return
          const v = video.current
          if (v && g && v.videoWidth > 0) {
            // Imagem reduzida: lê rápido mesmo em celular simples.
            const scale = Math.min(1, 640 / v.videoWidth)
            canvas.width = Math.round(v.videoWidth * scale)
            canvas.height = Math.round(v.videoHeight * scale)
            g.drawImage(v, 0, 0, canvas.width, canvas.height)
            const img = g.getImageData(0, 0, canvas.width, canvas.height)
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
            const now = Date.now()
            if (code?.data) {
              if (code.data !== seen.text) handler.current(code.data)
              seen.text = code.data
              seen.at = now
            } else if (seen.text && now - seen.at > 700) {
              seen.text = ''
            }
          }
          timer = window.setTimeout(tick, 150)
        }
        tick()
      } catch (e) {
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        setError(denied ? 'Libere o acesso à câmera para este site nas configurações do celular.' : 'Não foi possível abrir a câmera deste aparelho.')
      }
    }
    void start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
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
      <p className="text-center text-[13px] text-muted">Aponte para o QR de cada serviço feito. Para lançar o mesmo serviço de novo, afaste e aponte outra vez.</p>
      <Button block onClick={onClose}>Terminar leitura</Button>
    </div>
  )
}
