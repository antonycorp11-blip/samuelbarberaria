/**
 * Mantém o app instalado no celular sempre na versão publicada. O celular quase nunca abre
 * o app do zero (só volta do segundo plano), então a versão nova é procurada a cada minuto e
 * sempre que o app volta para a tela. O service worker novo assume assim que é baixado, e a
 * tela recarrega quando o app sai da tela ou logo ao abrir, nunca no meio de uma venda.
 */
export function keepUpdated() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  const sw = navigator.serviceWorker
  const openedAt = Date.now()
  // No primeiro acesso o service worker também "assume", mas aí não há versão velha para trocar.
  const hadVersion = Boolean(sw.controller)
  let fresh = false
  const reload = () => window.location.reload()

  sw.addEventListener('controllerchange', () => {
    if (!hadVersion) return
    fresh = true
    if (document.visibilityState === 'hidden' || Date.now() - openedAt < 8000) reload()
  })

  void sw.register('/sw.js', { scope: '/' }).then((registration) => {
    const check = () => void registration.update().catch(() => {})
    setInterval(check, 60_000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
      else if (fresh) reload()
    })
  }).catch(() => {})
}
