/** Share control details by ref; retain differing fields as explicit overrides. */
export function compactObservationPayload(observation: Record<string, unknown>): Record<string, unknown> {
  const structure = observation.structure as Record<string, unknown> | undefined;
  if (!structure || !Array.isArray(structure.elements) || !Array.isArray(observation.controls)) return observation;
  const controls = new Map(observation.controls.filter(control => control && typeof control === "object")
    .map(control => [control.ref, control as Record<string, unknown>]));
  let removed = 0;
  const elements = structure.elements.map(element => {
    if (!element || typeof element !== "object") return element;
    const control = controls.get(element.ref);
    if (!control) return element;
    return Object.fromEntries(Object.entries(element).filter(([key, value]) => {
      if (key === "ref" || !(key in control) || JSON.stringify(value) !== JSON.stringify(control[key])) return true;
      removed++;
      return false;
    }));
  });
  return removed ? { ...observation, structure: { ...structure, elements,
    elementDetails: "Resolve elements[].ref in observation.controls; fields on an element override those control details." } } : observation;
}
