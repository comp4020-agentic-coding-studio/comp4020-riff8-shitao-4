// The ephemeral layer: strokes still being drawn. Nothing here ever touches
// src/db.ts --- a preview lives in this process's memory, is broadcast to
// open tabs, and is gone when its gesture is committed, cancelled, replaced
// or simply goes quiet for longer than its lease. A restart forgets every
// preview, which is the point: an unfinished gesture is never artwork.

import type { Sample } from "./ink.ts";

// A bare coordinate from a tab loaded before samples existed, or a sample
// with its pressure and timing. One gesture uses one or the other throughout.
export type Point = [number, number] | Sample;

export interface PreviewSnapshot {
  gesture: string;
  colour: string;
  points: Point[];
  held: boolean;
}

export type LiveEvent =
  | { type: "preview"; gesture: string; colour: string; from: number; points: Point[]; held: boolean }
  | { type: "preview-end"; gesture: string; reason: "cancelled" | "expired" | "replaced" };

export type UpdateResult =
  | { ok: true; count: number; events: LiveEvent[] }
  | { ok: false; status: number; reason: string; count?: number };

interface Preview {
  gesture: string;
  handId: string;
  colour: string;
  points: Point[];
  held: boolean;
  // When the stroke was finished into a draft awaiting Add to the wall.
  heldSince: number | null;
  startedAt: number;
  updatedAt: number;
}

// A gesture id is a fresh random UUID per stroke, chosen by the drawing tab
// so it can recognise its own preview and mark coming back over SSE before
// any response arrives. It's broadcast, so it must say nothing about the
// hand: it's never stored, never reused, and ownership is checked against
// the hand cookie, never against knowledge of the id.
export const GESTURE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LIMITS = {
  // Same cap as a finished mark's path (src/server.ts's PATH_RE).
  pointsPerGesture: 2001,
  pointsPerUpdate: 200,
  updatesPerSecond: 30,
  activeGestures: 100,
  // Ended ids are remembered so a delayed update can't resurrect a preview,
  // and a mark can't borrow another hand's gesture id.
  endedRemembered: 2000,
  endedForgetMs: 10 * 60 * 1000,
  // Generous enough for a phone that draws outside the wall with pointer
  // capture on; the viewBox itself is 1000 × 600.
  coordMin: -1000,
  coordMax: 2000,
  // A sample's timestamp is milliseconds since the gesture's first point, and
  // no preview outlives this (createLive's maxAgeMs), so no gesture can.
  gestureMs: 10 * 60 * 1000,
};

const validCoord = (n: unknown) => Number.isInteger(n) && (n as number) >= LIMITS.coordMin && (n as number) <= LIMITS.coordMax;

const validSample = (s: unknown): s is Sample =>
  Array.isArray(s) &&
  s.length === 4 &&
  validCoord(s[0]) &&
  validCoord(s[1]) &&
  (s[2] === null || (typeof s[2] === "number" && s[2] >= 0 && s[2] <= 1)) &&
  Number.isInteger(s[3]) &&
  s[3] >= 0 &&
  s[3] <= LIMITS.gestureMs;

const validPoint = (p: unknown): p is Point =>
  validSample(p) || (Array.isArray(p) && p.length === 2 && p.every(validCoord));

// Timestamps never run backwards, from `after` (the previous sample's) on.
const inOrder = (samples: Sample[], after = 0) =>
  samples.every((s, i) => s[3] >= (i === 0 ? after : samples[i - 1][3]));

// A finished mark's samples, checked against the path it was submitted with:
// one per path point, at exactly that point, starting at t = 0, in order,
// each in range. Anything else is refused, never repaired.
export function samplesMatch(samples: unknown, path: [number, number][]): samples is Sample[] {
  return (
    Array.isArray(samples) &&
    samples.length === path.length &&
    samples.every(validSample) &&
    samples[0][3] === 0 &&
    inOrder(samples) &&
    samples.every((s, i) => s[0] === path[i][0] && s[1] === path[i][1])
  );
}

// A finished stroke waiting on its hand's decision is shown dashed, kept
// alive by heartbeats --- but not forever: after heldMaxMs it's swept like
// any abandoned preview, and the draft stays private on the hand's screen.
// No preview outlives maxAgeMs from its first point, heartbeat or not, so
// a client can't hold a slot of LIMITS.activeGestures open forever.
export function createLive({
  leaseMs,
  heldMaxMs = 120_000,
  maxAgeMs = LIMITS.gestureMs,
}: {
  leaseMs: number;
  heldMaxMs?: number;
  maxAgeMs?: number;
}) {
  const active = new Map<string, Preview>();
  const ended = new Map<string, { handId: string; at: number }>();
  // Per hand, not per gesture, so minting fresh gesture ids can't dodge it:
  // the start of the current one-second window and the updates within it.
  const rate = new Map<string, { start: number; count: number }>();

  const remember = (gesture: string, handId: string, at: number) => {
    ended.set(gesture, { handId, at });
    if (ended.size > LIMITS.endedRemembered) {
      ended.delete(ended.keys().next().value!);
    }
  };

  const end = (preview: Preview, now: number) => {
    active.delete(preview.gesture);
    remember(preview.gesture, preview.handId, now);
  };

  return {
    update(
      handId: string,
      colour: string,
      body: { gesture?: unknown; from?: unknown; points?: unknown; held?: unknown },
      now = Date.now(),
    ): UpdateResult {
      const { gesture, from, points } = body;
      if (typeof gesture !== "string" || !GESTURE_RE.test(gesture)) {
        return { ok: false, status: 400, reason: "bad gesture id" };
      }
      if (!Number.isInteger(from) || (from as number) < 0) {
        return { ok: false, status: 400, reason: "bad from" };
      }
      if (
        !Array.isArray(points) ||
        points.length > LIMITS.pointsPerUpdate ||
        !points.every(validPoint)
      ) {
        return { ok: false, status: 400, reason: "bad points" };
      }
      const pts = points as Point[];
      if (!pts.every((p) => p.length === pts[0].length)) {
        return { ok: false, status: 400, reason: "bad points" };
      }
      if (pts[0]?.length === 4 && (!inOrder(pts as Sample[]) || (from === 0 && (pts[0] as Sample)[3] !== 0))) {
        return { ok: false, status: 400, reason: "bad timestamps" };
      }
      const held = body.held === true;

      const endedEntry = ended.get(gesture);
      if (endedEntry) return { ok: false, status: 410, reason: "gesture already ended" };

      const slot = rate.get(handId);
      if (!slot || now - slot.start >= 1000) {
        rate.set(handId, { start: now, count: 1 });
      } else if (++slot.count > LIMITS.updatesPerSecond) {
        return { ok: false, status: 429, reason: "too many updates" };
      }

      const events: LiveEvent[] = [];
      let preview = active.get(gesture);
      if (preview && preview.handId !== handId) {
        return { ok: false, status: 403, reason: "not your gesture" };
      }
      if (!preview) {
        if ((from as number) !== 0) return { ok: false, status: 409, reason: "unknown gesture", count: 0 };
        // One live stroke per hand: a second tab (or a stuck first one)
        // starting a new gesture ends the old one rather than stacking.
        for (const other of active.values()) {
          if (other.handId === handId) {
            end(other, now);
            events.push({ type: "preview-end", gesture: other.gesture, reason: "replaced" });
          }
        }
        if (active.size >= LIMITS.activeGestures) {
          return { ok: false, status: 503, reason: "too many people drawing right now" };
        }
        preview = { gesture, handId, colour, points: [], held, heldSince: null, startedAt: now, updatedAt: now };
        active.set(gesture, preview);
      }

      const start = from as number;
      const count = preview.points.length;
      if (start > count) return { ok: false, status: 409, reason: "gap", count };
      // A retried update overlaps what's already here; keep only what's new.
      const fresh = (points as Point[]).slice(count - start);
      if (count + fresh.length > LIMITS.pointsPerGesture) {
        return { ok: false, status: 413, reason: "stroke too long", count };
      }
      const last = preview.points.at(-1);
      if (last && fresh.length > 0) {
        if (fresh[0].length !== last.length) return { ok: false, status: 400, reason: "bad points", count };
        if (last.length === 4 && (fresh[0] as Sample)[3] < last[3]) {
          return { ok: false, status: 400, reason: "bad timestamps", count };
        }
      }
      preview.points.push(...fresh);
      preview.updatedAt = now;
      const heldChanged = preview.held !== held;
      preview.held = held;
      preview.heldSince = held ? (preview.heldSince ?? now) : null;
      if (fresh.length > 0 || heldChanged || count === 0) {
        events.push({ type: "preview", gesture, colour: preview.colour, from: count, points: fresh, held });
      }
      return { ok: true, count: preview.points.length, events };
    },

    cancel(handId: string, gesture: unknown, now = Date.now()): LiveEvent[] {
      if (typeof gesture !== "string" || !GESTURE_RE.test(gesture)) return [];
      const preview = active.get(gesture);
      if (!preview) {
        // A cancel can overtake the gesture's first update on another
        // connection; remembering the id makes that update arrive dead.
        if (!ended.has(gesture)) remember(gesture, handId, now);
        return [];
      }
      if (preview.handId !== handId) return [];
      end(preview, now);
      return [{ type: "preview-end", gesture, reason: "cancelled" }];
    },

    // Called once a mark has been persisted. Returns the gesture id to tag
    // the mark's broadcast with, so viewers can swap the preview for the
    // committed stroke in place --- or undefined if the id isn't this hand's
    // to claim. The preview ends silently: the mark event is its end.
    commit(handId: string, gesture: unknown, now = Date.now()): string | undefined {
      if (typeof gesture !== "string" || !GESTURE_RE.test(gesture)) return undefined;
      const preview = active.get(gesture);
      if (preview) {
        if (preview.handId !== handId) return undefined;
        end(preview, now);
        return gesture;
      }
      // Only an id this hand is remembered to have used (a preview cancelled
      // by a failed submission, now retried) is still its to claim; an
      // unknown id tags nothing, so forgetting old ids never lets another
      // hand borrow one.
      const endedEntry = ended.get(gesture);
      if (!endedEntry || endedEntry.handId !== handId) return undefined;
      endedEntry.at = now;
      return gesture;
    },

    // Abandoned previews (a closed tab, a dropped connection, a cancel that
    // never arrived) end here, whether or not anyone said goodbye.
    sweep(now = Date.now()): LiveEvent[] {
      const events: LiveEvent[] = [];
      for (const preview of active.values()) {
        const heldTooLong = preview.heldSince !== null && now - preview.heldSince > heldMaxMs;
        const tooOld = now - preview.startedAt > maxAgeMs;
        if (now - preview.updatedAt > leaseMs || heldTooLong || tooOld) {
          end(preview, now);
          events.push({ type: "preview-end", gesture: preview.gesture, reason: "expired" });
        }
      }
      for (const [gesture, entry] of ended) {
        if (now - entry.at > LIMITS.endedForgetMs) ended.delete(gesture);
      }
      for (const [handId, slot] of rate) {
        if (now - slot.start >= 1000) rate.delete(handId);
      }
      return events;
    },

    snapshot(): PreviewSnapshot[] {
      return [...active.values()].map((p) => ({
        gesture: p.gesture,
        colour: p.colour,
        points: [...p.points],
        held: p.held,
      }));
    },

    activeCount: () => active.size,
  };
}
