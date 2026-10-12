// The server's handle on public/ink.js, the one copy of the width rule the
// browser also runs (that file says what the rule is).
import "../public/ink.js";

// [x, y, pressure, t]: viewBox coordinates, PointerEvent.pressure (null when
// the input reports none), and milliseconds since the gesture's first point.
export type Sample = [x: number, y: number, pressure: number | null, t: number];

declare global {
  var TraceInk: { EXTRA: number; outline: (samples: Sample[]) => string | null };
}

export const { outline } = globalThis.TraceInk;

// What to draw for a mark: a filled outline when its samples carry real
// pressure variation, otherwise its plain path, exactly as before samples.
export function inkFor(m: { path: string; samples: Sample[] | null }): { d: string; inked: boolean } {
  const d = m.samples ? outline(m.samples) : null;
  return d ? { d, inked: true } : { d: m.path, inked: false };
}

export const pathPoints = (path: string): [number, number][] =>
  path
    .slice(1)
    .split(" L")
    .map((p) => p.split(",").map(Number) as [number, number]);

// Where a stroke began and ended. Read from the path, which a mark's samples
// are checked against point for point, so for a mark with samples these are
// samples[0] and the last sample; older marks have them too.
export function endpoints(path: string): { start: [number, number]; end: [number, number] } {
  const pts = pathPoints(path);
  return { start: pts[0], end: pts[pts.length - 1] };
}
