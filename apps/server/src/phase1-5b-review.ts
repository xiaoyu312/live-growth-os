// The original internal evaluation fixture and recordings are not distributed.
// This compatibility boundary keeps the application's explicit unavailable response.
import type { EventStore } from "./storage";
export class BusinessReviewNotFoundError extends Error {}
export class BusinessReviewDataUnavailableError extends Error {}
export class Phase15bReviewService {
  constructor(store: EventStore) { void store; }
  async get(): Promise<never> { throw new BusinessReviewDataUnavailableError("Internal replay data is not included in the public source edition."); }
  async submit(input: unknown): Promise<never> { void input; return this.get(); }
  audioPath(id: string): { path: string; size: number } { void id; throw new BusinessReviewDataUnavailableError("Internal recordings are not distributed."); }
  audioStream(id: string): NodeJS.ReadableStream { void id; throw new BusinessReviewDataUnavailableError("Internal recordings are not distributed."); }
}
