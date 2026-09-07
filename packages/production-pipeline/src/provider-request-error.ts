export class ProviderRequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestRejectedError";
  }
}

export function providerHttpFailure(status: number, message: string): Error {
  const definitivelyRejected = status >= 400
    && status < 500
    && ![408, 409, 425, 429, 499].includes(status);
  return definitivelyRejected ? new ProviderRequestRejectedError(message) : new Error(message);
}
