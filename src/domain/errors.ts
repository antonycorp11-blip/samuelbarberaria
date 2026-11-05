/** Regra de negócio violada. A mensagem vai direto para o usuário. */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function fail(code: string, message: string): never {
  throw new DomainError(code, message)
}
