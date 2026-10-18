/** Thrown (as the abort reason) when the AI loop passes its time budget. */
export class AiTimeoutError extends Error {
  constructor() {
    super("AI budget exceeded");
    this.name = "AiTimeoutError";
  }
}
