// No original real-session fixtures, transcripts, dates, people or metrics are shipped.
import type { MvpRealReplayWindow, MvpReplayMetadata, MvpTranscriptEvidence } from "@live-growth/contracts";
export type MvpRealReplayOptions = { sessionId: string; seed: number };
export type MvpRealReplay = { metadata: MvpReplayMetadata; windows: MvpRealReplayWindow[]; transcript: MvpTranscriptEvidence[] };
export function generateMvpRealReplay(options: MvpRealReplayOptions): MvpRealReplay {
  void options;
  throw new Error("PUBLIC_REPLAY_DATA_NOT_INCLUDED");
}
