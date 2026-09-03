export class ProviderRequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestRejectedError";
  }
}
