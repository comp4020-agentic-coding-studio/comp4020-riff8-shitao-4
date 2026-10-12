// How a stroke's recorded pressure becomes its width, shared by the browser
// (loaded before wall.js) and the server (src/ink.ts imports this file), so
// the wall the server renders, the keepsake and the stroke under a hand's
// pointer are the same shape. Plain script, no import or export, so it runs
// unchanged as a classic browser script and as a Node module.
//
// A sample is [x, y, pressure, t]: viewBox coordinates, PointerEvent.pressure
// (null when the input reports none, like a keyboard), and milliseconds since
// the gesture's first point.
//
// The width rule: a stroke's lightest point draws exactly as every stroke
// always has (the CSS stroke-width), and each point pressed harder than that
// adds EXTRA viewBox units per unit of pressure above it. Pressure is never
// normalised, so a pen held at a near-constant pressure stays near-constant
// rather than having its noise stretched into a taper, and a mouse or finger
// (which reports one constant value) gets no outline at all: `outline`
// returns null and the caller draws the plain centreline path, as before.
// Since the lightest point isn't known until the stroke ends, a stroke still
// being drawn widens all along if a later point is lighter than any before.
globalThis.TraceInk = (() => {
  const EXTRA = 12;
  const round = (n) => Math.round(n * 10) / 10;

  const pressureRange = (samples) => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      const p = s[2];
      if (typeof p !== "number") return null;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    return max > min ? min : null;
  };

  // A filled outline around the stroke's centreline, its half-width at each
  // sample the extra width that sample's pressure earns, with round caps.
  // The caller still strokes it at the CSS width, which adds the base width
  // evenly all round: total width = base + extra.
  const outline = (samples) => {
    if (!Array.isArray(samples) || samples.length < 2) return null;
    const min = pressureRange(samples);
    if (min === null) return null;
    const n = samples.length;
    const left = [];
    const right = [];
    const half = samples.map((s) => (EXTRA * (s[2] - min)) / 2);
    const tangent = (i) => {
      const a = samples[Math.max(0, i - 1)];
      const b = samples[Math.min(n - 1, i + 1)];
      return [b[0] - a[0], b[1] - a[1]];
    };
    // A pen pressed in one spot has no direction to be wide across: it
    // draws as the plain path's round dot.
    const first = samples.findIndex((_, i) => tangent(i).some((v) => v !== 0));
    if (first === -1) return null;
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < n; i++) {
      // A repeated point has no direction of its own: take the nearest
      // one's, the stroke's first direction for any repeats it starts with.
      const [tx, ty] = tangent(Math.max(i, first));
      const len = Math.hypot(tx, ty);
      if (len > 0) {
        nx = -ty / len;
        ny = tx / len;
      }
      const [x, y] = samples[i];
      left.push(`${round(x + nx * half[i])},${round(y + ny * half[i])}`);
      right.push(`${round(x - nx * half[i])},${round(y - ny * half[i])}`);
    }
    const cap = (h, to) => `A${round(h)},${round(h)} 0 0 0 ${to}`;
    return [
      `M${left[0]}`,
      ...left.slice(1).map((p) => `L${p}`),
      cap(half[n - 1], right[n - 1]),
      ...right.slice(0, -1).reverse().map((p) => `L${p}`),
      cap(half[0], left[0]),
      "Z",
    ].join(" ");
  };

  return { EXTRA, outline };
})();
