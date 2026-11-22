import assert from "node:assert/strict";
import test from "node:test";
import { nativeValueControlRegion, sameNativeControlEpoch } from "../src/lib/native/native-control-region";
import type { NativeWindowStructureElement } from "../src/lib/native/windows-desktop-stage";

function field(id: string, path: number[], runtimeId: number[], ref = "snapshot-a"): NativeWindowStructureElement {
  return { ref, path, runtimeId, automationId: id, role: "edit", className: "Edit", label: id, enabled: true,
    focused: false, depth: path.length, rect: { x: 0, y: 0, width: 100, height: 20 },
    actions: { setValue: true, invoke: false, select: false, toggle: false, legacy: false } };
}
test("independent snapshots derive the same semantic region, with distinct controls in separate regions", () => {
  const title = field("title", [0], [42, 1]);
  const caption = field("caption", [1], [42, 2]);
  const otherTitle = { ...title, ref: "snapshot-b", path: [2] };
  assert.equal(nativeValueControlRegion(title, [title, caption], true), nativeValueControlRegion(otherTitle, [caption, otherTitle], true));
  assert.notEqual(nativeValueControlRegion(title, [title, caption], true), nativeValueControlRegion(caption, [title, caption], true));
});
test("RuntimeId is a live epoch, while the canonical semantic region survives a recreated control", () => {
  const observed = field("title", [0], [42, 1]);
  const recreated = { ...observed, runtimeId: [42, 99] };
  assert.equal(nativeValueControlRegion(observed, [observed], true), nativeValueControlRegion(recreated, [recreated], true));
  assert.equal(sameNativeControlEpoch(observed, recreated), false);
  assert.equal(sameNativeControlEpoch(observed, { ...observed, path: [3], ref: "new-snapshot" }), true);
});
test("partial, weak, or ambiguous control identities keep the whole-window fence", () => {
  const title = field("title", [0], [42, 1]);
  assert.equal(nativeValueControlRegion(title, [title], false), undefined);
  assert.equal(nativeValueControlRegion({ ...title, automationId: "" }, [title], true), undefined);
  assert.equal(nativeValueControlRegion({ ...title, runtimeId: undefined }, [title], true), undefined);
  assert.equal(nativeValueControlRegion(title, [title, { ...title, path: [1], runtimeId: [42, 2] }], true), undefined);
});
