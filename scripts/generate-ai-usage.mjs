#!/usr/bin/env node
// Renders the AI-coding-tools activity card from local transcript files.
//
// This one CANNOT run in CI: it reads ~/.claude, ~/.codex and Cursor's SQLite
// store, which only exist on the machine the work was done on. Run it locally
// and commit the SVG — that is why the output lands in assets/ on main rather
// than on the workflow-managed output branch, which is force-replaced on every
// scheduled run and would delete anything it did not build itself.
//
//   node scripts/generate-ai-usage.mjs
//
// Like the stats card, the artwork is theme-neutral. Cells are drawn as one
// hue at varying opacity over a transparent ground, so each level composites
// correctly whether the reader's GitHub is light or dark — no <picture>, whose
// prefers-color-scheme follows the visitor's OS rather than their GitHub theme.

import { createReadStream, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const OUT = process.env.AI_USAGE_OUT || "assets/ai-usage.svg";
const localDay = (d) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local tz

async function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

async function eachLine(file, fn) {
  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d && typeof d === "object") fn(d);
  }
}

const bump = (m, day) => m.set(day, (m.get(day) || 0) + 1);

// ------------------------------------------------------------- Claude Code
async function claudeCode() {
  const counts = new Map(), sessions = new Set(), seen = new Set();
  for (const f of await walk(join(HOME, ".claude", "projects"))) {
    await eachLine(f, (d) => {
      if (d.type !== "user" && d.type !== "assistant") return;
      if (d.uuid) {                      // resumed sessions replay earlier records
        if (seen.has(d.uuid)) return;
        seen.add(d.uuid);
      }
      if (!d.timestamp) return;
      bump(counts, localDay(new Date(d.timestamp)));
      if (d.sessionId) sessions.add(d.sessionId);
    });
  }
  return { counts, sessions: sessions.size };
}

// ------------------------------------------------------------------- Codex
async function codex() {
  const counts = new Map(), sessions = new Set();
  const files = [
    ...(await walk(join(HOME, ".codex", "sessions"))),
    ...(await walk(join(HOME, ".codex", "archived_sessions"))),
  ];
  for (const f of files) {
    let used = false;
    await eachLine(f, (d) => {
      const p = d.payload;
      if (!p || typeof p !== "object") return;
      if (p.type !== "user_message" && p.type !== "agent_message") return;
      if (!d.timestamp) return;
      bump(counts, localDay(new Date(d.timestamp)));
      used = true;
    });
    if (used) sessions.add(f);
  }
  return { counts, sessions: sessions.size };
}

// ------------------------------------------------------------------ Cursor
function cursor() {
  const counts = new Map();
  const db = join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  if (!existsSync(db)) return { counts, sessions: 0 };
  const con = new DatabaseSync(db, { readOnly: true });
  const rows = con
    .prepare("select value from cursorDiskKV where key like 'composerData:%'")
    .all();
  let sessions = 0;
  for (const { value } of rows) {
    let d;
    try { d = JSON.parse(value); } catch { continue; }
    // a few rows hold literal JSON null, which parses without throwing
    if (!d || typeof d !== "object" || !d.createdAt) continue;
    // Cursor stores no per-message timestamp, so a thread's messages all land
    // on the day it was opened.
    const day = localDay(new Date(d.createdAt));
    const n = (d.fullConversationHeadersOnly || []).length;
    if (!n) continue;
    counts.set(day, (counts.get(day) || 0) + n);
    sessions++;
  }
  con.close();
  return { counts, sessions };
}

// ----------------------------------------------------------------- render
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const F = `font-family="ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"`;
const MUTE = "#7D8590";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const nf = (n) => n.toLocaleString("en-US");

function quartiles(values) {
  const v = [...values].sort((a, b) => a - b);
  return [0.25, 0.5, 0.85].map((q) => v[Math.floor(v.length * q)] || 1);
}
function longestStreak(days) {
  const s = [...days].sort();
  let best = 0, run = 0, prev = null;
  for (const d of s) {
    const t = Date.parse(d + "T00:00:00Z");
    run = prev !== null && t - prev === 864e5 ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  }
  return best;
}

function render(tools) {
  const W = 900, PAD = 28, RAIL = 178, GAP = 14;
  const GX = PAD + RAIL + GAP, CELL = 9, PITCH = 11, ROW = 11;

  const active = tools.filter((t) => t.counts.size);
  const all = active.flatMap((t) => [...t.counts.keys()]).sort();
  const first = new Date(all[0] + "T12:00:00");
  const last = new Date(all[all.length - 1] + "T12:00:00");
  first.setDate(first.getDate() - first.getDay());          // back to Sunday
  last.setDate(last.getDate() + (6 - last.getDay()));        // on to Saturday
  const days = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1))
    days.push(localDay(d));
  const weeks = Math.ceil(days.length / 7);

  const TRACK_H = ROW * 7 - 2;
  const TRACK_GAP = 24;
  const TOP = 68;
  const H = TOP + active.length * (TRACK_H + TRACK_GAP) + 14;

  // month ruler — label a column whenever its week opens a new month
  let axis = "";
  for (let w = 0; w < weeks; w++) {
    const cur = days[w * 7], prev = w ? days[(w - 1) * 7] : null;
    if (prev && cur.slice(5, 7) === prev.slice(5, 7)) continue;
    const m = +cur.slice(5, 7);
    axis += `<text x="${GX + w * PITCH}" y="60" ${F} font-size="9" fill="${MUTE}" fill-opacity=".85">${
      MON[m - 1]}${m === 1 ? " ’" + cur.slice(2, 4) : ""}</text>`;
  }

  let body = "";
  active.forEach((t, i) => {
    const y = TOP + i * (TRACK_H + TRACK_GAP);
    const q = quartiles(t.counts.values());
    const total = [...t.counts.values()].reduce((a, b) => a + b, 0);
    const peak = Math.max(...t.counts.values());
    const streak = longestStreak(t.counts.keys());

    body += `
  <text x="${PAD}" y="${y + 11}" ${F} font-size="12.5" font-weight="700" fill="${t.color}">${esc(t.name)}</text>
  <text x="${PAD}" y="${y + 28}" ${F} font-size="11.5" font-weight="700" fill="${t.color}">${nf(total)}</text>
  <text x="${PAD + nf(total).length * 7 + 4}" y="${y + 28}" ${F} font-size="10" fill="${MUTE}">messages</text>
  <text x="${PAD}" y="${y + 43}" ${F} font-size="9.5" fill="${MUTE}">${t.counts.size} active days · ${nf(t.sessions)} sessions</text>
  <text x="${PAD}" y="${y + 56}" ${F} font-size="9.5" fill="${MUTE}" fill-opacity=".8">peak ${nf(peak)} · streak ${streak}d</text>`;

    days.forEach((d, idx) => {
      const n = t.counts.get(d) || 0;
      const x = GX + Math.floor(idx / 7) * PITCH;
      const yy = y + (idx % 7) * ROW;
      const o = n === 0 ? null : n <= q[0] ? 0.3 : n <= q[1] ? 0.52 : n <= q[2] ? 0.76 : 1;
      body += o === null
        ? `<rect x="${x}" y="${yy}" width="${CELL}" height="${CELL}" rx="2" fill="${MUTE}" fill-opacity=".16"/>`
        : `<rect x="${x}" y="${yy}" width="${CELL}" height="${CELL}" rx="2" fill="${t.color}" fill-opacity="${o}"/>`;
    });
  });

  // legend
  const ly = H - 6;
  let legend = `<text x="${GX}" y="${ly}" ${F} font-size="9" fill="${MUTE}" fill-opacity=".8">Less</text>`;
  [0.16, 0.3, 0.52, 0.76, 1].forEach((o, i) => {
    legend += `<rect x="${GX + 26 + i * 12}" y="${ly - 8}" width="9" height="9" rx="2" fill="${MUTE}" fill-opacity="${o}"/>`;
  });
  legend += `<text x="${GX + 26 + 5 * 12 + 4}" y="${ly}" ${F} font-size="9" fill="${MUTE}" fill-opacity=".8">More</text>`;
  legend += `<text x="${W - PAD}" y="${ly}" ${F} font-size="9" text-anchor="end" fill="${MUTE}" fill-opacity=".7">shaded against each tool’s own busiest days</text>`;

  const grand = active.reduce((a, t) => a + [...t.counts.values()].reduce((x, y) => x + y, 0), 0);
  const span = `${MON[+all[0].slice(5, 7) - 1]} ${all[0].slice(0, 4)} — ${MON[+all[all.length - 1].slice(5, 7) - 1]} ${all[all.length - 1].slice(0, 4)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="AI coding tool activity: ${nf(grand)} messages across ${active.map((t) => t.name).join(", ")}">
  <title>AI coding tools — ${nf(grand)} messages, ${span}</title>
  <text x="${PAD}" y="26" ${F} font-size="11" font-weight="700" letter-spacing="1.6" fill="${MUTE}">AI CODING TOOLS · MESSAGES PER DAY</text>
  <text x="${W - PAD}" y="26" ${F} font-size="10" text-anchor="end" fill="${MUTE}" fill-opacity=".7">${span}</text>
  <line x1="${PAD}" y1="38" x2="${W - PAD}" y2="38" stroke="${MUTE}" stroke-opacity=".2" stroke-width="1"/>
${axis}${body}
${legend}
</svg>
`;
}

// -------------------------------------------------------------------- main
const [cc, cx, cu] = [await claudeCode(), await codex(), cursor()];
const tools = [
  { name: "Claude Code", color: "#E4002B", ...cc },
  { name: "Cursor",      color: "#2F81F7", ...cu },
  { name: "Codex",       color: "#3FB950", ...cx },
];

const svg = render(tools);
mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT}  ${svg.length}B`);
for (const t of tools) {
  const total = [...t.counts.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${t.name.padEnd(12)} ${nf(total).padStart(9)} msgs  ${
    String(t.counts.size).padStart(3)} days  ${String(t.sessions).padStart(5)} sessions`);
}
