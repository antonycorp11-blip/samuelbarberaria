import { useEffect, useRef, useState } from 'react'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { Button, Input } from './kit'

const formats = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] as const
const cameraKey = 'scan-camera'

type Camera = Pick<MediaDeviceInfo, 'deviceId' | 'label'>
type SeenCode = { text: string; missingSince: number | null }
type Detector = { detect: (image: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> }
type DetectorClass = {
  new (options: { formats: Array<(typeof formats)[number]> }): Detector
  getSupportedFormats: () => Promise<readonly string[]>
}
type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[]
  zoom?: { min: number; max: number }
  torch?: boolean
  pointsOfInterest?: boolean
}

/** Prefere a câmera que troca de lente para fotos próximas. */
export function backCameras(cameras: Camera[]): Camera[] {
  return cameras
    .filter((camera) => !/front|frontal|user|facing front/i.test(camera.label))
    .sort((a, b) => Number(/triple|tripla|dual wide|dupla/i.test(b.label)) - Number(/triple|tripla|dual wide|dupla/i.test(a.label)))
}

/** Um código só volta a contar depois de 700 ms fora da imagem. */
export function readOnce(seen: SeenCode, code: string, now: number): { seen: SeenCode; accepted: string } {
  if (!code) {
    if (!seen.text) return { seen, accepted: '' }
    const missingSince = seen.missingSince ?? now
    return { seen: now - missingSince >= 700 ? { text: '', missingSince: null } : { ...seen, missingSince }, accepted: '' }
  }
  const leftFrame = seen.missingSince !== null && now - seen.missingSince >= 700
  return { seen: { text: code, missingSince: null }, accepted: code !== seen.text || leftFrame ? code : '' }
}

export function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const handler = useRef(onCode)
  const switchCamera = useRef<() => void>(() => {})
  const changeZoom = useRef<() => void>(() => {})
  const changeTorch = useRef<() => void>(() => {})
  const focusAt = useRef<(x: number, y: number) => void>(() => {})
  const [error, setError] = useState('')
  const [status, setStatus] = useState('Abrindo a câmera…')
  const [slow, setSlow] = useState(false)
  const [manual, setManual] = useState('')
  const [cameras, setCameras] = useState<Camera[]>([])
  const [canZoom, setCanZoom] = useState(false)
  const [canTorch, setCanTorch] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  handler.current = onCode

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let detector: Detector | null = null
    let tick: ReturnType<typeof setInterval> | null = null
    let slowTimer: ReturnType<typeof setTimeout> | null = null
    let busy = false
    // Um erro isolado (imagem ainda carregando, troca de câmera) não pode desligar o leitor.
    let failures = 0
    let seen: SeenCode = { text: '', missingSince: null }
    let available: Camera[] = []
    let currentId = ''
    let generation = 0
    let zoomActive = false
    let torchActive = false

    const stopStream = () => {
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
      if (video.current) video.current.srcObject = null
    }
    const resetSlowTimer = () => {
      if (slowTimer) clearTimeout(slowTimer)
      setSlow(false)
      slowTimer = setTimeout(() => { if (!stopped) setSlow(true) }, 8000)
    }
    const trackAndCaps = () => {
      const track = stream?.getVideoTracks()[0]
      const caps = track?.getCapabilities?.() as CameraCapabilities | undefined
      return { track, caps }
    }
    const apply = async (advanced: Record<string, unknown>) => {
      const { track } = trackAndCaps()
      if (!track) return false
      try {
        await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints)
        return true
      } catch {
        return false
      }
    }
    const useStream = async (constraints: MediaStreamConstraints, requestedId = '') => {
      const request = ++generation
      stopStream()
      setStatus('Abrindo a câmera…')
      setError('')
      try {
        const opened = await navigator.mediaDevices.getUserMedia(constraints)
        if (stopped || request !== generation) {
          opened.getTracks().forEach((track) => track.stop())
          return
        }
        stream = opened
        const element = video.current
        if (!element) return
        element.srcObject = opened
        await element.play()
        if (stopped || request !== generation) return
        const { track, caps } = trackAndCaps()
        currentId = track?.getSettings().deviceId || requestedId
        setCanZoom(Boolean(caps?.zoom))
        setCanTorch(Boolean(caps?.torch))
        zoomActive = false
        torchActive = false
        setZoomed(false)
        setTorchOn(false)
        if (caps?.focusMode?.includes('continuous')) await apply({ focusMode: 'continuous' })
        if (stopped || request !== generation) return
        if (requestedId) {
          try { localStorage.setItem(cameraKey, requestedId) } catch { /* Armazenamento pode estar bloqueado. */ }
        }
        setStatus('Procurando código… aproxime até as barras ficarem nítidas.')
        resetSlowTimer()
      } catch (e) {
        if (stopped || request !== generation) return
        stopStream()
        const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        setError(denied ? 'Libere o acesso à câmera para este site nas configurações do celular.' : 'Não foi possível abrir a câmera deste aparelho.')
      }
    }

    switchCamera.current = () => {
      if (available.length < 2) return
      const index = available.findIndex((camera) => camera.deviceId === currentId)
      const next = available[(index + 1) % available.length]
      if (!next) return
      void useStream({ audio: false, video: { deviceId: { exact: next.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, next.deviceId)
    }
    changeZoom.current = () => {
      const { caps } = trackAndCaps()
      if (!caps?.zoom) return
      const next = zoomActive ? caps.zoom.min : Math.max(caps.zoom.min, Math.min(2, caps.zoom.max))
      void apply({ zoom: next }).then((ok) => {
        if (ok && !stopped) {
          zoomActive = next > caps.zoom!.min
          setZoomed(zoomActive)
        }
      })
    }
    changeTorch.current = () => {
      const { caps } = trackAndCaps()
      if (!caps?.torch) return
      const next = !torchActive
      void apply({ torch: next }).then((ok) => {
        if (ok && !stopped) {
          torchActive = next
          setTorchOn(next)
        }
      })
    }
    focusAt.current = (x, y) => {
      const { caps } = trackAndCaps()
      if (caps?.pointsOfInterest) void apply({ pointsOfInterest: [{ x, y }] })
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Não foi possível abrir a câmera deste aparelho.')
        return
      }
      await useStream({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      if (stopped || !stream) return
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (stopped) return
        available = backCameras(devices.filter((device) => device.kind === 'videoinput'))
        setCameras(available)
        let saved = ''
        try { saved = localStorage.getItem(cameraKey) || '' } catch { /* Armazenamento pode estar bloqueado. */ }
        const preferred = available.find((camera) => camera.deviceId === saved) || available[0]
        if (preferred && preferred.deviceId !== currentId) {
          await useStream({ audio: false, video: { deviceId: { exact: preferred.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, preferred.deviceId)
        }
      } catch { /* A câmera inicial continua disponível. */ }
      if (stopped || !stream) return
      try {
        const native = (globalThis as typeof globalThis & { BarcodeDetector?: DetectorClass }).BarcodeDetector
        let DetectorType: DetectorClass | undefined
        let usableFormats: Array<(typeof formats)[number]> = [...formats]
        if (native) {
          try {
            const supported = await native.getSupportedFormats()
            if (supported.includes('ean_13') && supported.includes('qr_code')) {
              DetectorType = native
              usableFormats = formats.filter((format) => supported.includes(format))
            }
          } catch { /* Usa o leitor local. */ }
        }
        if (!DetectorType) {
          const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill')
          await prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => path.endsWith('.wasm') ? wasmUrl : prefix + path }, fireImmediately: true })
          DetectorType = BarcodeDetector
        }
        if (stopped) return
        if (!DetectorType) throw new Error('Leitor indisponível')
        detector = new DetectorType({ formats: usableFormats })
        tick = setInterval(() => {
          const element = video.current
          if (busy || !detector || !element || !stream || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
          busy = true
          const detectingGeneration = generation
          void detector.detect(element).then((results) => {
            failures = 0
            if (stopped || detectingGeneration !== generation) return
            const result = readOnce(seen, results.find((item) => item.rawValue)?.rawValue || '', Date.now())
            seen = result.seen
            if (result.accepted) {
              handler.current(result.accepted)
              if (navigator.vibrate) navigator.vibrate(60)
              resetSlowTimer()
            }
          }).catch(() => {
            failures++
            if (!stopped && detectingGeneration === generation && failures >= 8) {
              if (tick) clearInterval(tick)
              tick = null
              setError('Não foi possível ler com esta câmera.')
            }
          }).finally(() => { busy = false })
        }, 120)
      } catch {
        if (!stopped) setError('Não foi possível ler com esta câmera.')
      }
    }
    void start()
    return () => {
      stopped = true
      generation++
      if (tick) clearInterval(tick)
      if (slowTimer) clearTimeout(slowTimer)
      stopStream()
      switchCamera.current = () => {}
      changeZoom.current = () => {}
      changeTorch.current = () => {}
      focusAt.current = () => {}
    }
  }, [])

  const digits = manual.replace(/\D/g, '')
  return (
    <div className="space-y-2 rounded-2xl bg-raised p-3">
      <div className="relative overflow-hidden rounded-xl bg-black">
        <video ref={video} muted playsInline className="aspect-[4/3] w-full object-cover" onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          focusAt.current((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height)
        }} />
        <div className="pointer-events-none absolute left-[10%] top-[32.5%] h-[35%] w-[80%] rounded-2xl border-2 border-brass/80" />
      </div>
      {error ? <p role="alert" className="text-center text-sm font-semibold text-bad">{error}</p> : (
        <p role="status" className="text-center text-[13px] text-muted">{status}{slow ? ' Não está lendo? Digite os números embaixo das barras.' : ''}</p>
      )}
      <p className="text-center text-[13px] text-muted">Aponte para um QR ou código de barras. Para ler de novo, afaste e aponte outra vez.</p>
      {(cameras.length > 1 || canZoom || canTorch) && <div className="flex flex-wrap justify-center gap-2">
        {cameras.length > 1 && <Button onClick={() => switchCamera.current()}>Trocar câmera</Button>}
        {canZoom && <Button onClick={() => changeZoom.current()} aria-pressed={zoomed}>Zoom 2x</Button>}
        {canTorch && <Button onClick={() => changeTorch.current()} aria-pressed={torchOn}>Lanterna</Button>}
      </div>}
      {canZoom && <p className="text-center text-[13px] text-muted">Afaste um pouco e use o zoom se não focar.</p>}
      <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (digits) { handler.current(digits); setManual('') } }}>
        <label className="min-w-0 flex-1 text-[13px] text-muted">Digitar o código
          <Input className="mt-1" inputMode="numeric" placeholder="Números embaixo das barras" value={manual} onChange={(event) => setManual(event.target.value.replace(/\D/g, ''))} />
        </label>
        <Button type="submit" disabled={!digits}>Usar</Button>
      </form>
      <Button block onClick={onClose}>Terminar leitura</Button>
    </div>
  )
}
