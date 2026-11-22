import assert from "node:assert/strict";
import test from "node:test";
import { classifySaveAsConflict, findSaveAsButton, findSaveAsNameField, resolveSaveAsTarget } from "../src/lib/native/stage-save-as";

test("Save As target parsing keeps absolute parent and basename separate", () => {
  assert.deepEqual(resolveSaveAsTarget("C:\\Users\\owner\\Desktop\\M9R Benchmark\\I1 Run1\\M9R-demo-smoke.txt"), {
    path: "C:\\Users\\owner\\Desktop\\M9R Benchmark\\I1 Run1\\M9R-demo-smoke.txt",
    directory: "C:\\Users\\owner\\Desktop\\M9R Benchmark\\I1 Run1",
    fileName: "M9R-demo-smoke.txt",
  });
  assert.deepEqual(resolveSaveAsTarget("\\\\fileserver\\share\\folder\\drawing.png"), {
    path: "\\\\fileserver\\share\\folder\\drawing.png",
    directory: "\\\\fileserver\\share\\folder",
    fileName: "drawing.png",
  });
});

test("Save As target parsing rejects relative paths, directories, and invalid Windows filenames", () => {
  for (const value of ["Desktop\\file.txt", "C:\\folder\\", "C:\\folder\\CON.txt", "C:\\folder\\bad?.txt", "C:\\folder\\trailing. ",
    "\\\\?\\C:\\folder\\file.txt", "\\\\.\\C:\\folder\\file.txt"]) {
    assert.throws(() => resolveSaveAsTarget(value), /Save As/);
  }
});

test("Save As control resolution requires one accessible editable name field and one Save action", () => {
  const controls = [
    { role: "Edit", label: "File name", automationId: "", enabled: true, actions: { setValue: true } },
    { role: "Button", label: "&Save", automationId: "1", enabled: true, actions: { invoke: true } },
    { role: "Button", label: "Cancel", automationId: "2", enabled: true, actions: { invoke: true } },
  ];
  assert.equal(findSaveAsNameField(controls), controls[0]);
  assert.equal(findSaveAsButton(controls), controls[1]);
  assert.equal(findSaveAsNameField([...controls, { ...controls[0] }]), undefined);
  assert.equal(findSaveAsButton([...controls, { ...controls[1] }]), undefined);
  assert.equal(findSaveAsNameField([{ ...controls[0], actions: { setValue: false } }]), undefined);
});

test("overwrite prompts are handled only when they name the requested target and the policy allows it", () => {
  const prompt = [
    { role: "Text", label: "M9R-demo-smoke.txt already exists. Do you want to replace it?", automationId: "", enabled: true },
    { role: "Button", label: "Yes", automationId: "6", enabled: true, actions: { invoke: true } },
    { role: "Button", label: "No", automationId: "7", enabled: true, actions: { invoke: true } },
  ];
  assert.deepEqual(classifySaveAsConflict(prompt, "M9R-demo-smoke.txt", true), { recognized: true, confirm: true });
  assert.deepEqual(classifySaveAsConflict(prompt, "M9R-demo-smoke.txt", false), {
    recognized: true, dismiss: true, reason: "The existing file was preserved because replacement was not authorized.",
  });
  assert.equal(classifySaveAsConflict(prompt, "other.txt", true).recognized, false);
  assert.equal(classifySaveAsConflict([{ ...prompt[0]!, label: "M9R-demo-smoke.txt.backup already exists. Replace it?" }, ...prompt.slice(1)],
    "M9R-demo-smoke.txt", true).recognized, false, "a neighboring filename is not an exact target match");
  assert.equal(classifySaveAsConflict(prompt.slice(0, 1), "M9R-demo-smoke.txt", true).confirm, undefined);
});
