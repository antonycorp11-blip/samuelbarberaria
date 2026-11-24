import { describe, expect, it } from 'vitest'
import { mailSettings } from '../worker/email'

describe('servidor de envio de e-mail', () => {
  it('sem nada configurado, usa o Gmail e o próprio login como remetente', () => {
    const m = mailSettings({ GMAIL_USER: 'barbearia@gmail.com', GMAIL_APP_PASSWORD: 'x' })
    expect(m.smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true })
    expect(m.from).toEqual({ name: 'Samuel Barber Shop', email: 'barbearia@gmail.com' })
  })

  it('Brevo: login interno, remetente com o domínio da barbearia', () => {
    const m = mailSettings({
      SMTP_HOST: 'smtp-relay.brevo.com', GMAIL_USER: 'abc123@smtp-brevo.com', GMAIL_APP_PASSWORD: 'chave',
      MAIL_FROM: 'contato@samuelbarbearia.com.br', MAIL_FROM_NAME: 'Samuel Barbearia',
    })
    expect(m.smtp).toMatchObject({ host: 'smtp-relay.brevo.com', port: 465, credentials: { username: 'abc123@smtp-brevo.com' } })
    expect(m.from).toEqual({ name: 'Samuel Barbearia', email: 'contato@samuelbarbearia.com.br' })
  })
})
