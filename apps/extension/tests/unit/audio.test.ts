import { describe, expect, it } from "vitest";
import { initialAudioStatus, transitionAudio } from "../../src/audio";

describe("Phase 2A audio stop race", () => {
  it("stop 后迟到 energy/track_started 不得恢复 active", () => {
    const active = transitionAudio(
      transitionAudio(initialAudioStatus("2026-08-06T00:00:00.000Z"), { type: "request", observedAt: "2026-08-06T00:00:01.000Z" }),
      { type: "track_started", observedAt: "2026-08-06T00:00:02.000Z", trackCount: 1 }
    );
    const stopped = transitionAudio(active, { type: "stop", observedAt: "2026-08-06T00:00:03.000Z" });
    expect(transitionAudio(stopped, { type: "energy", observedAt: "2026-08-06T00:00:04.000Z", band: "normal", activeSeconds: 4 }).captureLifecycle).toBe("stopped");
    expect(transitionAudio(stopped, { type: "track_started", observedAt: "2026-08-06T00:00:05.000Z", trackCount: 1 }).captureLifecycle).toBe("stopped");
    const restarted = transitionAudio(
      transitionAudio(initialAudioStatus("2026-08-06T00:00:06.000Z"), { type: "request", observedAt: "2026-08-06T00:00:07.000Z" }),
      { type: "track_started", observedAt: "2026-08-06T00:00:08.000Z", trackCount: 1 }
    );
    expect(restarted.captureLifecycle).toBe("active");
  });
});
