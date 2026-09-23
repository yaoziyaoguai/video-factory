import { describe, expect, it } from "vitest";
import { initialFilmArrival, nextFilmArrival, stageHandoffIdentityChanged } from "../src/client/film-arrival.js";

describe("film arrival (M6)", () => {
  it("does not reveal when the run is opened with an existing video", () => {
    let r = nextFilmArrival(initialFilmArrival, "run-1", "artifact-old", true);
    expect(r.reveal).toBe(false);
    // 旧成片反复加载/更新都不庆祝。
    for (let i = 0; i < 10; i += 1) {
      r = nextFilmArrival(r.state, "run-1", "artifact-old", true);
      expect(r.reveal).toBe(false);
    }
    // 旧片是基线，不妨碍当前会话里新片到达后揭幕。
    r = nextFilmArrival(r.state, "run-1", "artifact-new", true);
    expect(r.reveal).toBe(true);
  });

  it("reveals exactly once after a genuinely new video arrives and its media is ready", () => {
    let r = nextFilmArrival(initialFilmArrival, "run-1", undefined, false);
    expect(r.reveal).toBe(false);
    // 渲染完成：成片到达，但媒体尚未 loadeddata。
    r = nextFilmArrival(r.state, "run-1", "artifact-1", false);
    expect(r.reveal).toBe(false);
    // loadeddata 后揭幕一次。
    r = nextFilmArrival(r.state, "run-1", "artifact-1", true);
    expect(r.reveal).toBe(true);
    // 同一 artifact 的后续快照更新（轮询）不重播。
    for (let i = 0; i < 10; i += 1) {
      r = nextFilmArrival(r.state, "run-1", "artifact-1", true);
      expect(r.reveal).toBe(false);
    }
  });

  it("starts fresh on remount so an old video never celebrates", () => {
    // 组件卸载后状态清零：重新打开旧 run 等价于首次观察。
    let r = nextFilmArrival(initialFilmArrival, "run-1", undefined, false);
    r = nextFilmArrival(r.state, "run-1", "artifact-2", true);
    expect(r.reveal).toBe(true);
    const fresh = nextFilmArrival(initialFilmArrival, "run-1", "artifact-2", true);
    expect(fresh.reveal).toBe(false);
  });

  it("does not reveal while the artifact is absent", () => {
    let r = nextFilmArrival(initialFilmArrival, "run-1", undefined, true);
    r = nextFilmArrival(r.state, "run-1", undefined, true);
    expect(r.reveal).toBe(false);
    expect(r.state.baselineArtifact).toBeNull();
  });

  it("does not replay a previous artifact after another one arrived, or carry history into a new run", () => {
    let r = nextFilmArrival(initialFilmArrival, "run-1", undefined, false);
    r = nextFilmArrival(r.state, "run-1", "A", true);
    r = nextFilmArrival(r.state, "run-1", "B", true);
    expect(r.reveal).toBe(true);
    r = nextFilmArrival(r.state, "run-1", "A", true);
    expect(r.reveal).toBe(false);
    r = nextFilmArrival(r.state, "run-2", "A", true);
    expect(r.reveal).toBe(false);
    expect(r.state.revealed).toEqual([]);
  });
});

describe("stage handoff (M2)", () => {
  it("does not fire on initial observation or on repeated identical identities", () => {
    let seen: string | null = null;
    let r = stageHandoffIdentityChanged(seen, "draft-a");
    expect(r.changed).toBe(false);
    seen = r.seen;
    for (let i = 0; i < 10; i += 1) {
      r = stageHandoffIdentityChanged(seen, "draft-a");
      expect(r.changed).toBe(false);
      seen = r.seen;
    }
  });

  it("fires once when the effective draft identity truly changes", () => {
    let seen: string | null = "draft-a";
    const r = stageHandoffIdentityChanged(seen, "draft-b");
    expect(r.changed).toBe(true);
    seen = r.seen;
    expect(stageHandoffIdentityChanged(seen, "draft-b").changed).toBe(false);
  });

  it("ignores undefined identity (stage not mounted) without resetting the seen value", () => {
    const r = stageHandoffIdentityChanged("draft-a", undefined);
    expect(r.changed).toBe(false);
    expect(r.seen).toBe("draft-a");
  });
});
