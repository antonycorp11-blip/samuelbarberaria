/* OneSignal no navegador. O worker dele fica em pasta própria para não disputar com o da PWA. */

import { PUSH_TEAM_ID } from '@/domain/push'

interface OneSignalSdk {
  init(o: Record<string, unknown>): Promise<void>
  login(externalId: string): Promise<void>
  Notifications: { isPushSupported(): boolean; permission: boolean; requestPermission(): Promise<void> }
  User: { PushSubscription: { optedIn?: boolean; id?: string | null; optIn(): Promise<void> } }
}

type Deferred = ((sdk: OneSignalSdk) => void)[]

let ready: Promise<OneSignalSdk | null> | null = null

export function initPush(): Promise<OneSignalSdk | null> {
  ready ??= (async () => {
    const res = await fetch('/api/config').catch(() => null)
    const config = (await res?.json().catch(() => null)) as { oneSignalAppId?: string | null } | null
    const appId = config?.oneSignalAppId
    if (!appId) return null
    const w = window as unknown as { OneSignalDeferred?: Deferred }
    w.OneSignalDeferred = w.OneSignalDeferred ?? []
    const script = document.createElement('script')
    script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'
    script.defer = true
    document.head.appendChild(script)
    return new Promise<OneSignalSdk>((resolve) => {
      w.OneSignalDeferred?.push((sdk) => {
        void sdk
          .init({
            appId,
            serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js',
            serviceWorkerParam: { scope: '/push/onesignal/' },
          })
          .then(() => resolve(sdk))
      })
    })
  })()
  return ready
}

export interface PushStatus {
  available: boolean
  supported: boolean
  subscribed: boolean
}

export async function pushStatus(): Promise<PushStatus> {
  const sdk = await initPush()
  if (!sdk) return { available: false, supported: false, subscribed: false }
  const sub = sdk.User.PushSubscription
  return { available: true, supported: sdk.Notifications.isPushSupported(), subscribed: Boolean(sub.optedIn && sub.id) }
}

/** Precisa vir de um toque do usuário: o iPhone recusa pedido automático. */
export async function enablePush(): Promise<PushStatus> {
  const sdk = await initPush()
  if (sdk) {
    await sdk.Notifications.requestPermission()
    await sdk.User.PushSubscription.optIn()
    await sdk.login(PUSH_TEAM_ID)
  }
  return pushStatus()
}

/** Liga este aparelho à equipe. Chamado com alguém logado, nunca no link público. */
export async function linkTeamDevice() {
  const sdk = await initPush()
  if (sdk?.User.PushSubscription.optedIn) await sdk.login(PUSH_TEAM_ID)
}
