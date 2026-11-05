// Confere a senha de app e manda um e-mail para a própria conta.
// Uso: coloque GMAIL_USER e GMAIL_APP_PASSWORD no .env.local e rode `npm run test:gmail`.
import nodemailer from 'nodemailer'

const { GMAIL_USER: user, GMAIL_APP_PASSWORD: pass, MAIL_FROM_NAME: name = 'Samuel Barbearia' } = process.env
if (!user || !pass) {
  console.error('Faltam GMAIL_USER e GMAIL_APP_PASSWORD no .env.local')
  process.exit(1)
}

const gmail = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } })
await gmail.verify()
const info = await gmail.sendMail({
  from: { name, address: user },
  to: user,
  subject: 'Teste de envio da barbearia',
  text: 'Se este e-mail chegou, a senha de app está funcionando.',
})
console.log('Enviado:', info.response)
