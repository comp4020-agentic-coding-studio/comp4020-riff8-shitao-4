# Trace: record what a stroke actually was, not just where it ended up

## Your task and working context

You are the crit agent continuing Trace in this pod-riff repository. Right
now a mark only remembers two things: its `path` (a point-by-point SVG
path string built from plain `[x, y]` pairs — see `pathFrom` in
`public/wall.js`) and its `colour` (derived from the hand, never the
client). Everything else about how the stroke was actually drawn is
thrown away before it reaches `src/db.ts`: thickness is a single
hard-coded `stroke-width="6"` in `src/pages.ts` and `public/style.css`,
not a property of the stroke itself, and nothing records pressure or
timing at all — `src/live.ts`'s `Point` type is just `[number, number]`.

Your task: record each stroke's full detail as it's actually drawn —
every point's coordinate, its pressure where the input device reports
one, and when it happened — and use that detail to render a real,
varying thickness instead of the current constant. Inspect the actual
repository, its history, its tests and its deployment configuration
before choosing an approach; don't assume this description is still
exactly accurate by the time you run.

## Per-point samples: coordinate, pressure, timestamp

Change what a drawing hand sends from a bare list of `[x, y]` points to a
list of samples, each carrying:

- **coordinate** — `x, y`, exactly as today;
- **pressure** — `PointerEvent.pressure` at that point, where the input
  device reports one. Mice and most touchscreens report a constant value
  (commonly `0.5` while a button/finger is down); don't present that
  constant as if it were real pressure data, but do still record it
  faithfully — a flat line of identical values is the honest signal that
  no real pressure was available, not a defect to paper over;
- **timestamp** — when that sample was taken, recorded as **milliseconds
  elapsed since the gesture's first point**, not an absolute clock time.
  Relative timing is all the rendering or analysis in this brief needs,
  and it avoids adding a second, finer-grained public timestamp beside
  the mark's existing `created_at` for no product reason.

This applies both to the finished `path` a mark is submitted with and to
the in-progress updates `public/wall.js` already streams through
`/api/strokes/live` (`src/live.ts`). A live preview should carry the same
per-point detail the committed mark will, not a stripped-down version of
it — so the stroke doesn't visibly change character the moment it lands.

Keep the existing `path` string as the plain rendering geometry (it's
still exactly what `PATH_RE` in `src/server.ts` validates); add the
sample detail alongside it rather than folding pressure and timing into
that string. This is structured numeric data about *how* a gesture was
drawn, not reader-visible text, so it doesn't touch the "a public mark is
a path, never text" rule — but validate it with the same seriousness as
the path: bound coordinate ranges the way `validPoint` in `src/live.ts`
already does, bound pressure to `[0, 1]`, bound each timestamp to be
non-negative, non-decreasing, and within a sane maximum gesture duration
(consistent with `LIMITS.pointsPerGesture` and the existing lease/hold
timeouts), and cap the sample array's length to match the path's own
point-count limit. A client that sends out-of-range or malformed samples
should be rejected the same way a malformed path already is, not
silently clamped.

## Thickness, derived honestly

Use the recorded pressure to render a stroke whose width actually varies
along its length where real pressure data exists — a pressure-sensitive
pen should visibly taper; a mouse or finger-drawn stroke, with its flat
constant pressure, should render essentially as it does today, not gain
fake variation. `src/pages.ts`'s wall rendering and the keepsake SVG
should both use this derived width instead of the fixed
`stroke-width="6"`; `public/wall.js`'s own live rendering of the
in-progress stroke should match. You may build the variable-width line
however is simplest to get right — multiple segments each with their own
`stroke-width`, a generated outline (a library such as
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) takes
exactly this coordinate+pressure input), or another approach — but the
result must visibly reflect the recorded samples, not just exist in the
database.

## Schema, validation and migration

Extend `src/db.ts`'s `marks` table the way earlier columns were added:
`ALTER TABLE ... ADD COLUMN`, checked against `PRAGMA table_info` before
running, never a table rebuild, so a redeploy onto the existing Fly
volume loses nothing. Store the sample list as **JSON text** in a new
column (for example `samples`) — this app's API, SSE stream and export
are JSON throughout (`/api/marks`, `/api/marks/stream`,
`/mine/export.json`); don't introduce CSV or any other serialisation for
this one column. Each row's samples belong to that row, so they're
already tied to its existing `hand_id` the same way `path` and `colour`
are — no new "who drew this" field is needed or wanted. **Do not
fabricate samples for marks that predate this change** — leave the column `NULL` for them rather than inventing
plausible-looking pressure or timing data that was never actually
captured; have rendering fall back to the current fixed appearance
whenever samples are absent. Extend `spec/migration.test.ts` to prove an
old database, made before this change, still opens with every mark
intact and renders unchanged.

Update `src/server.ts`'s mark-creation validation to accept and bound the
new sample data, and `src/live.ts`'s preview path and types accordingly.
Expose the start (`samples[0]`) and end (last sample) coordinates
wherever a mark already appears in the API — `/api/marks`,
`/api/marks/stream`'s `mark` event, and any export — either as stored
fields or derived at response time; either is fine as long as they're
correct and present for new marks.

## Constraints carried over from the governing rules

Everything in the `CLAUDE.md` block above this prompt still applies: no
accounts, no public text, no third-party requests, persistence only at
`DB_PATH`, the rolling 24-hour limit unchanged, and a mark still
broadcasts over `/api/marks/stream` only after it's persisted. This is a
narrow, mechanical-data brief, not licence to revisit product direction —
don't add anything here beyond what's needed to capture and render this
detail honestly, and don't let per-point timing become a new privacy
surface (relative-to-gesture only, never wall-clock per point, never
exposed per-hand across marks in a way that didn't already exist via
`created_at`).

`hand_id` already records which anonymous hand drew a mark, and that's
enough: it's used server-side for the daily limit, ownership and My
traces, and it stays exactly that internal — never added to `/api/marks`,
the SSE `mark` event, the wall HTML, or any response a different hand can
read. Samples, width and start/end ride on the same row and inherit that
same boundary; don't introduce any new way for one hand's marks to be
grouped or identified by another visitor. Surfacing who drew what would
reverse the "no way to find out who drew which mark unless they tell you"
design in `README.md` and is explicitly out of scope here.

## Verification and completion

Extend `spec/wall.test.ts` and `spec/wall-client.test.ts` to cover: a
pressure-varying synthetic `PointerEvent` stream producing samples that
actually vary and a visibly non-uniform rendered width; a plain
mouse/touch stroke still rendering as it does today; rejection of
out-of-range pressure, bad timestamps, or a mismatched sample/path length;
start/end coordinates present and correct on `/api/marks` and the SSE
`mark` event; and the live preview's per-point detail matching what the
eventually-committed mark stores. Keep `spec/invariants.test.ts` green,
run `pnpm check` and the project's other required checks, and
browser-check with synthetic pressure values if no real pressure-capable
input device is available in your environment — say so plainly in your
summary rather than implying it was tested on real hardware.

Update the relevant part of README.md to describe what you built and why
(pressure and timing as an honest record of how a gesture was drawn, not
an invented psychological signal — keep the same restraint the README
already shows about not inventing findings).

This is an unattended run: make reasonable, documented choices rather
than stopping on an open question. Keep `main` deployable throughout,
preserve every existing visitor mark, and delete this file in your final
commit.
