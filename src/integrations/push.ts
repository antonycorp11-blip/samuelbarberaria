/** Liga o OneSignal só quando o App ID existir. Sem ele, o app segue sem push. */
export function initPush() {
  const appId = import.meta.env.VITE_ONESIGNAL_APP_ID as string | undefined
  if (!appId) return
  const script = document.createElement('script')
  script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'
  script.defer = true
  document.head.appendChild(script)
  const w = window as unknown as { OneSignalDeferred?: ((s: { init(o: { appId: string }): Promise<void> }) => void)[] }
  w.OneSignalDeferred = w.OneSignalDeferred ?? []
  w.OneSignalDeferred.push((sdk) => void sdk.init({ appId }))
}
