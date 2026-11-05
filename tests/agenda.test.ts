import { describe, expect, it } from 'vitest'
import {
  addToWaitlist, availableSlots, bookOnline, cancelAppointment, createAppointment, createBlock, findFitIns,
  onlineSlots, rescheduleAppointment, setAppointmentStatus,
} from '../src/domain/agenda'
import { upsertBarber } from '../src/domain/team'
import { timeOf, toISO } from '../src/domain/time'
import { assertInvariants, setup } from './helpers'

const at = (t: string) => toISO('2026-03-03', t)

describe('agendamento', () => {
  it('impede dois clientes no mesmo horário do mesmo barbeiro', () => {
    const { w, ana, cut, joao, maria } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    expect(() =>
      w.do(createAppointment, { clientId: maria, barberId: ana, serviceIds: [cut], start: at('10:15') }),
    ).toThrow(/já tem atendimento/)
  })

  it('permite horário colado no anterior e em outro barbeiro', () => {
    const { w, ana, beto, cut, joao, maria } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    w.do(createAppointment, { clientId: maria, barberId: ana, serviceIds: [cut], start: at('10:30') })
    w.do(createAppointment, { clientId: maria, barberId: ana, serviceIds: [cut], start: at('09:30') })
    w.do(createAppointment, { clientId: maria, barberId: beto, serviceIds: [cut], start: at('10:00') })
    expect(assertInvariants(w.state)).toEqual([])
  })

  it('bloqueia passado, dia fechado, fora do horário e serviço que passa do fechamento', () => {
    const { w, ana, cut, joao } = setup()
    const base = { clientId: joao, barberId: ana, serviceIds: [cut] }
    expect(() => w.do(createAppointment, { ...base, start: toISO('2026-03-01', '10:00') })).toThrow(/passado/)
    expect(() => w.do(createAppointment, { ...base, start: toISO('2026-03-08', '10:00') })).toThrow(/não atende/)
    expect(() => w.do(createAppointment, { ...base, start: at('08:00') })).toThrow(/Fora do horário/)
    expect(() => w.do(createAppointment, { ...base, start: at('19:45') })).toThrow(/Fora do horário/)
  })

  it('respeita intervalo do barbeiro e bloqueio', () => {
    const { w, ana, cut, joao } = setup()
    const b = w.state.barbers.find((x) => x.id === ana)!
    w.do(upsertBarber, { ...b, breakStart: '12:00', breakEnd: '13:00' })
    const base = { clientId: joao, barberId: ana, serviceIds: [cut] }
    expect(() => w.do(createAppointment, { ...base, start: at('11:45') })).toThrow(/intervalo/)
    w.do(createBlock, { barberId: ana, start: at('15:00'), end: at('16:00'), reason: 'Médico' })
    expect(() => w.do(createAppointment, { ...base, start: at('15:30') })).toThrow(/Médico/)
    expect(availableSlots(w.state, ana, '2026-03-03', 30, w.now).map(timeOf)).not.toContain('15:00')
  })

  it('não deixa bloquear por cima de atendimento marcado', () => {
    const { w, ana, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    expect(() => w.do(createBlock, { barberId: ana, start: at('09:00'), end: at('11:00'), reason: '' })).toThrow(/Remarque/)
  })

  it('cancelar libera o horário e avisa a lista de espera', () => {
    const { w, ana, cut, joao, maria } = setup()
    const a = w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    w.do(addToWaitlist, { clientId: maria, serviceIds: [cut], barberId: null, date: '2026-03-03' })
    w.do(cancelAppointment, { id: a.id })
    expect(w.state.waitlist[0]?.status).toBe('notified')
    expect(w.state.messages.some((m) => m.kind === 'waitlist_slot' && m.to === 'maria@teste.com')).toBe(true)
    w.do(createAppointment, { clientId: maria, barberId: ana, serviceIds: [cut], start: at('10:00') })
  })

  it('lista de espera não recebe vaga que não comporta o serviço', () => {
    const { w, ana, cut, beard, joao, maria } = setup()
    const a = w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    w.do(addToWaitlist, { clientId: maria, serviceIds: [cut, beard], barberId: null, date: '2026-03-03' })
    w.do(cancelAppointment, { id: a.id })
    expect(w.state.waitlist[0]?.status).toBe('waiting')
  })

  it('remarcar não colide consigo mesmo e valida o novo horário', () => {
    const { w, ana, cut, joao, maria } = setup()
    const a = w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    w.do(createAppointment, { clientId: maria, barberId: ana, serviceIds: [cut], start: at('11:00') })
    w.do(rescheduleAppointment, { id: a.id, barberId: ana, start: at('10:15') })
    expect(() => w.do(rescheduleAppointment, { id: a.id, barberId: ana, start: at('10:45') })).toThrow()
  })

  it('não permite status inválido', () => {
    const { w, ana, cut, joao } = setup()
    const a = w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('10:00') })
    w.do(cancelAppointment, { id: a.id })
    expect(() => w.do(setAppointmentStatus, { id: a.id, status: 'confirmed' })).toThrow(/inválida/)
  })

  it('encaixe devolve o horário livre mais próximo entre todos os barbeiros', () => {
    const { w, ana, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: toISO('2026-03-02', '09:00') })
    const fits = findFitIns(w.state, { durationMin: 30, from: w.now })
    expect(fits[0]?.start).toBe(toISO('2026-03-02', '09:00'))
    expect(fits[0]?.barberId).not.toBe(ana)
  })
})

describe('agendamento online', () => {
  const data = { name: 'Novo Cliente', phone: '(11) 98888-7777', email: 'NOVO@teste.com', marketingOptIn: false }

  it('cria cliente, normaliza dados e reaproveita cadastro pelo celular', () => {
    const { w, ana, cut } = setup()
    const before = w.state.clients.length
    w.do(bookOnline, { ...data, serviceIds: [cut], barberId: ana, start: at('10:00') })
    w.do(bookOnline, { ...data, phone: '+55 11 98888-7777', serviceIds: [cut], barberId: ana, start: at('11:00') })
    expect(w.state.clients.length).toBe(before + 1)
    expect(w.state.clients.at(-1)?.email).toBe('novo@teste.com')
    expect(w.state.appointments.every((a) => a.source === 'online')).toBe(true)
  })

  it('recusa horário sem a antecedência mínima e além da janela', () => {
    const { w, ana, cut } = setup()
    const base = { ...data, serviceIds: [cut], barberId: ana }
    expect(() => w.do(bookOnline, { ...base, start: toISO('2026-03-02', '09:30') })).toThrow(/disponível/)
    expect(() => w.do(bookOnline, { ...base, start: toISO('2026-06-02', '10:00') })).toThrow(/abriu/)
  })

  it('segundo cliente no mesmo instante perde a corrida sem criar cadastro solto', () => {
    const { w, ana, cut } = setup()
    w.do(bookOnline, { ...data, serviceIds: [cut], barberId: ana, start: at('10:00') })
    const count = w.state.clients.length
    expect(() =>
      w.do(bookOnline, { ...data, phone: '11977776666', serviceIds: [cut], barberId: ana, start: at('10:00') }),
    ).toThrow()
    expect(w.state.clients.length).toBe(count)
  })

  it('sem preferência distribui para o barbeiro com menos atendimentos no dia', () => {
    const { w, ana, beto, cut, joao } = setup()
    w.do(createAppointment, { clientId: joao, barberId: ana, serviceIds: [cut], start: at('09:00') })
    const slot = onlineSlots(w.state, null, '2026-03-03', 30, w.now).find((x) => timeOf(x.start) === '14:00')
    expect(slot?.barberId).toBe(beto)
  })
})
