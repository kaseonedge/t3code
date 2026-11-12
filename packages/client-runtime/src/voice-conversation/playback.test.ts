import { expect, it } from "vite-plus/test";
import { createVoicePlayback } from "./playback.ts";

function sink() {
  const scheduled: Array<{ at: number; samples: number[]; stopped: boolean }> = [];
  const volumes: number[] = [];
  const clock = { now: 10 };
  return {
    clock,
    scheduled,
    volumes,
    playback: createVoicePlayback({
      now: () => clock.now,
      schedule: (samples, at) => {
        const entry = { at, samples: [...samples], stopped: false };
        scheduled.push(entry);
        return { stop: () => void (entry.stopped = true) };
      },
      setVolume: (volume) => void volumes.push(volume),
    }),
  };
}

/** `ms` of 24 kHz 16-bit audio. */
const pcm = (ms: number, value = 0) => {
  const samples = new Int16Array(ms * 24).fill(value);
  return new Uint8Array(samples.buffer);
};

it("plays chunks back to back and reports exactly how much was heard when cleared", () => {
  const { playback, scheduled, clock } = sink();
  playback.enqueue(1, pcm(500));
  playback.enqueue(1, pcm(500));
  expect(scheduled.map(({ at }) => at)).toEqual([10.06, 10.56]);

  clock.now = 10.06 + 0.3;
  expect(playback.clear(1)).toBeCloseTo(300);
  expect(scheduled.every(({ stopped }) => stopped)).toBe(true);
  // Frames for a cleared speech that were already on the wire are never heard.
  playback.enqueue(1, pcm(500));
  expect(scheduled).toHaveLength(2);
  expect(playback.clear(1)).toBe(0);
});

it("never reports more than was sent, or audio that had not started", () => {
  const early = sink();
  early.playback.enqueue(1, pcm(500));
  expect(early.playback.isDrained(1)).toBe(false);
  expect(early.playback.clear(1)).toBe(0);

  const late = sink();
  late.playback.enqueue(1, pcm(500));
  late.clock.now = 60;
  expect(late.playback.isDrained(1)).toBe(true);
  expect(late.playback.clear(1)).toBeCloseTo(500);
  expect(late.playback.isDrained(1)).toBe(false);
});

it("resumes from now after the network starves playback", () => {
  const { playback, scheduled, clock } = sink();
  playback.enqueue(1, pcm(100));
  clock.now = 12;
  playback.enqueue(1, pcm(100));
  expect(scheduled[1]?.at).toBe(12);
});

it("joins a sample split across two frames", () => {
  const { playback, scheduled } = sink();
  const bytes = new Uint8Array(new Int16Array([16384, -32768]).buffer);
  playback.enqueue(1, bytes.subarray(0, 3));
  playback.enqueue(1, bytes.subarray(3));
  expect(scheduled.flatMap(({ samples }) => samples)).toEqual([0.5, -1]);
});

it("a new speech silences the one before it, and volume stays within bounds", () => {
  const { playback, scheduled, volumes } = sink();
  playback.enqueue(1, pcm(500));
  playback.enqueue(2, pcm(500));
  expect(scheduled.map(({ stopped }) => stopped)).toEqual([true, false]);
  for (let step = 0; step < 6; step++) playback.adjustVolume("louder");
  for (let step = 0; step < 12; step++) playback.adjustVolume("quieter");
  expect(Math.max(...volumes)).toBe(2);
  expect(volumes.at(-1)).toBe(0.25);
});
