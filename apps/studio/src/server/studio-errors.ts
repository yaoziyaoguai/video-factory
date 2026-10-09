export class StudioNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioNotFoundError";
  }
}

export class StudioConflictError extends Error {
  constructor(message: string, readonly recovery?: StudioStaleHumanContentRecovery) {
    super(message);
    this.name = "StudioConflictError";
  }
}
import type { StudioStaleHumanContentRecovery } from "../shared/api.js";
