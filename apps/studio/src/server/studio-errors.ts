export class StudioNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioNotFoundError";
  }
}

export class StudioConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioConflictError";
  }
}
