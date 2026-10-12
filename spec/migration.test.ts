import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";

// A database exactly as the live app left it before the sketchbook (the
// schema src/db.ts created at 0b60b87), opened by today's src/db.ts: every
// old mark survives, gains the new columns empty, and still counts toward
// its hand's daily limit. A redeploy onto the Fly volume does exactly this.
const dbPath = join(mkdtempSync(join(tmpdir(), "trace-migrate-")), "trace.db");
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE hands (id TEXT PRIMARY KEY, name TEXT NOT NULL, colour TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE marks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id TEXT NOT NULL REFERENCES hands(id),
    path TEXT NOT NULL,
    colour TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
const now = Date.now();
old.prepare("INSERT INTO hands VALUES (?, ?, ?, ?)").run("old-hand", "quiet-heron", "#cc4a28", now - 1000);
old.prepare("INSERT INTO marks (hand_id, path, colour, created_at) VALUES (?, ?, ?, ?)").run(
  "old-hand",
  "M1,1 L2,2",
  "#cc4a28",
  now - 1000,
);
old.close();

process.env.DB_PATH = dbPath;

it("keeps every existing mark, with the new fields empty", async () => {
  const db = await import("../src/db.ts");
  expect(db.allMarks()).toEqual([
    {
      id: 1,
      hand_id: "old-hand",
      path: "M1,1 L2,2",
      colour: "#cc4a28",
      created_at: now - 1000,
      prompt: null,
      samples: null,
    },
  ]);
  expect(db.ownMarks("old-hand")).toMatchObject([{ id: 1, note: null }]);
  // The old mark still spends today's allowance.
  expect(db.msUntilNextMark("old-hand")).toBeGreaterThan(0);
  // And the new features work on it.
  expect(db.setNote("old-hand", 1, "from before the notes existed")).toBe(true);
  expect(db.ownMarks("old-hand")[0].note).toBe("from before the notes existed");
});

it("draws an old mark, which has no samples, exactly as it was drawn before them", async () => {
  const db = await import("../src/db.ts");
  const { keepsakeSvg, wallPage } = await import("../src/pages.ts");
  const [mark] = db.allMarks();
  const wall = new JSDOM(wallPage([mark], { id: "someone-else", colour: "#000" }, 0, 5000, "a prompt")).window.document;
  const el = wall.querySelector('#wall path[data-id="1"]')!;
  expect([el.getAttribute("d"), el.getAttribute("stroke"), el.getAttribute("class"), el.getAttribute("fill")]).toEqual(
    ["M1,1 L2,2", "#cc4a28", null, null],
  );
  expect(keepsakeSvg(mark)).toContain(
    '<path d="M1,1 L2,2" stroke="#cc4a28" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />',
  );
  // Nothing is made up for it: its samples stay empty in the database itself.
  const raw = new DatabaseSync(dbPath).prepare("SELECT samples FROM marks WHERE id = 1").get();
  expect(raw).toEqual({ samples: null });
});

it("is safe to run again on an already-migrated database", async () => {
  vi.resetModules();
  const db = await import("../src/db.ts");
  expect(db.allMarks().length).toBe(1);
  expect(db.ownMarks("old-hand")[0].note).toBe("from before the notes existed");
});
