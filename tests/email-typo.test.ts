import { describe, expect, it } from 'vitest'
import { emailTypoFix } from '../src/domain/emailTypo'

describe('erro de digitação no e-mail', () => {
  it('corrige os erros comuns no fim do endereço', () => {
    expect(emailTypoFix('samuel@gmail.con')).toBe('samuel@gmail.com')
    expect(emailTypoFix('Ana@Gmial.com')).toBe('ana@gmail.com')
    expect(emailTypoFix('joao@hotmial.com')).toBe('joao@hotmail.com')
    expect(emailTypoFix('bia@outlok.com')).toBe('bia@outlook.com')
    expect(emailTypoFix('leo@yahoo.com.bt')).toBe('leo@yahoo.com.br')
    expect(emailTypoFix('rui@gmail.co')).toBe('rui@gmail.com')
  })

  it('não mexe em endereço certo ou em domínio desconhecido', () => {
    expect(emailTypoFix('samuel@gmail.com')).toBeNull()
    expect(emailTypoFix('contato@uol.com.br')).toBeNull()
    expect(emailTypoFix('dono@samuelbarbearia.com.br')).toBeNull()
    expect(emailTypoFix('fulano@empresa.com')).toBeNull()
    expect(emailTypoFix('sem-arroba')).toBeNull()
    expect(emailTypoFix('')).toBeNull()
  })
})
