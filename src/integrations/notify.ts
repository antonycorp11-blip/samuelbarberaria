import { api } from '@/data/store'

export const serverStatus = () => api<{ email: boolean; push: boolean }>('/api/status')

export const sendNow = (n: { channel: 'email' | 'push'; to: string; subject: string; body: string }) =>
  api('/api/notify', { method: 'POST', body: JSON.stringify(n) })
