// Sound is off for now: the owner decides later whether the pill gets audio and what it sounds like. The island calls this
// module at every transition, so the hooks stay in place and simply do nothing until sounds exist.

export type SoundName = "open" | "close" | "peek" | "blip" | "approve" | "send" | "finish" | "error";

export const Sound = {
  play(_name: SoundName) { /* no audio assets yet */ },
  setEnabled(_on: boolean) {},
  setVolume(_v: number) {},
  resume() {},
  idle() {},
};
