#!/usr/bin/env node
// Renders the "GitHub at a glance" card from live GitHub data.
//
// The card is deliberately theme-neutral: transparent background, accent-
// coloured numerals and hairline rules that stay legible on both the light
// and the dark GitHub themes. README <picture> + prefers-color-scheme is not
// used, because on GitHub that media query follows the visitor's OS setting
// rather than their GitHub theme, so a dark-theme reader on a light-theme OS
// gets served the light asset on a dark page.

import { writeFileSync, mkdirSync } from "node:fs";

const LOGIN = process.env.STATS_LOGIN || "zii144";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.STATS_OUT || "dist";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const C = {
  accent: "#E4002B", // brand red — legible on white and on #0d1117
  blue: "#2F81F7", // brand navy, lifted for dark-theme contrast
  muted: "#7D8590", // GitHub's own neutral; ~3.5:1 light, ~5.4:1 dark
  rule: "#7D8590",
};

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "zii144-profile-stats",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const QUERY = `
query($login:String!, $cursor:String) {
  user(login:$login) {
    followers { totalCount }
    pubRepos:  repositories(ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC)  { totalCount }
    privRepos: repositories(ownerAffiliations:OWNER, isFork:false, privacy:PRIVATE) { totalCount }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
    repositories(first:100, after:$cursor, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        pushedAt
        stargazerCount
        languages(first:12, orderBy:{field:SIZE, direction:DESC}) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

async function collect() {
  let cursor = null;
  let user = null;
  const repos = [];
  do {
    const data = await gql(QUERY, { login: LOGIN, cursor });
    user = data.user;
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage
      ? user.repositories.pageInfo.endCursor
      : null;
  } while (cursor);
  return { user, repos };
}

// Longest / current run of consecutive days with at least one contribution.
// A gap on today alone does not break the current streak — the day is still
// in progress — so the walk back starts at the last day that has activity.
function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  let i = days.length - 1;
  while (i >= 0 && days[i].count === 0) {
    // only forgive the trailing in-progress day
    if (i < days.length - 1) break;
    i--;
  }
  let current = 0;
  for (; i >= 0 && days[i].count > 0; i--) current++;
  return { longest, current };
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])
  );

// Catmull-Rom -> cubic Bezier, so the sparkline reads as a curve rather than
// a polyline without pulling the path off its data points.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function render({ stats, weeks, langs, generated }) {
  const W = 900;
  const H = 322;
  const PAD = 26;
  const F = `font-family="ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"`;

  // ---- stat columns -------------------------------------------------------
  const cells = [
    { n: stats.contributions.toLocaleString("en-US"), l: "Contributions", s: "past year", c: C.blue },
    { n: String(stats.current), l: "Day streak", s: "current", c: C.accent },
    { n: String(stats.active), l: "Repos shipped", s: "last 90 days", c: C.blue },
    // A token that cannot see private repos reports zero of them. Rather than
    // print "0 private" as if it were the truth, fall back to the public-only
    // wording — see the STATS_TOKEN note in .github/workflows/profile-assets.yml.
    stats.private > 0
      ? { n: String(stats.reposAll), l: "Repositories", s: `${stats.repos} public · ${stats.private} private`, c: C.blue }
      : { n: String(stats.repos), l: "Public repos", s: "sources, no forks", c: C.blue },
  ];
  const colW = (W - PAD * 2) / cells.length;
  const statsSvg = cells
    .map((c, i) => {
      const x = PAD + colW * i;
      const divider =
        i > 0
          ? `<line x1="${x - 14}" y1="52" x2="${x - 14}" y2="104" stroke="${C.rule}" stroke-opacity=".25" stroke-width="1"/>`
          : "";
      return `${divider}
    <text x="${x}" y="86" ${F} font-size="32" font-weight="700" fill="${c.c}">${esc(c.n)}</text>
    <text x="${x}" y="103" ${F} font-size="11.5" font-weight="600" fill="${C.muted}">${esc(c.l)}</text>
    <text x="${x + 1}" y="118" ${F} font-size="10.5" fill="${C.muted}" fill-opacity=".75">${esc(c.s)}</text>`;
    })
    .join("\n");

  // ---- contribution sparkline --------------------------------------------
  const gx = PAD;
  const gw = W - PAD * 2;
  const gTop = 150;
  const gh = 62;
  const max = Math.max(1, ...weeks);
  const pts = weeks.map((v, i) => [
    gx + (gw * i) / Math.max(1, weeks.length - 1),
    gTop + gh - (v / max) * gh,
  ]);
  const line = smoothPath(pts);
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${gTop + gh} L ${pts[0][0]} ${gTop + gh} Z`;
  const peak = pts[weeks.indexOf(max)];

  // ---- language bar -------------------------------------------------------
  const barY = 262;
  const barH = 9;
  let cx = PAD;
  const segs = langs
    .map((l, i) => {
      const w = (gw * l.pct) / 100;
      const r = i === 0 ? `rx="${barH / 2}"` : i === langs.length - 1 ? `rx="${barH / 2}"` : "";
      // Rounded ends only: inner segments square, overlapped to hide the radius.
      const seg = `<rect x="${cx.toFixed(1)}" y="${barY}" width="${Math.max(w, 2).toFixed(1)}" height="${barH}" fill="${l.color}" ${r}/>`;
      cx += w;
      return seg;
    })
    .join("");

  let lx = PAD;
  const legend = langs
    .map((l) => {
      const label = `${l.name} ${l.pct.toFixed(1)}%`;
      const chip = `<circle cx="${lx + 4}" cy="${barY + 34}" r="4" fill="${l.color}"/>
    <text x="${lx + 14}" y="${barY + 38}" ${F} font-size="11.5" fill="${C.muted}">${esc(label)}</text>`;
      lx += 26 + label.length * 6.1;
      return chip;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="GitHub activity for ${esc(LOGIN)}">
  <title>${esc(LOGIN)} — ${stats.contributions.toLocaleString("en-US")} contributions in the past year, ${stats.current}-day current streak</title>
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity=".38"/>
      <stop offset="100%" stop-color="${C.accent}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <text x="${PAD}" y="34" ${F} font-size="11" font-weight="700" letter-spacing="1.6" fill="${C.muted}">GITHUB AT A GLANCE</text>
  <text x="${W - PAD}" y="34" ${F} font-size="10.5" text-anchor="end" fill="${C.muted}" fill-opacity=".7">${esc(generated)}</text>
  <line x1="${PAD}" y1="44" x2="${W - PAD}" y2="44" stroke="${C.rule}" stroke-opacity=".2" stroke-width="1"/>

${statsSvg}

  <line x1="${PAD}" y1="136" x2="${W - PAD}" y2="136" stroke="${C.rule}" stroke-opacity=".2" stroke-width="1"/>
  <text x="${PAD}" y="${gTop - 8}" ${F} font-size="10" font-weight="700" letter-spacing="1.4" fill="${C.muted}">CONTRIBUTIONS PER WEEK</text>
  <path d="${area}" fill="url(#fade)"/>
  <path d="${line}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${peak[0].toFixed(1)}" cy="${peak[1].toFixed(1)}" r="3.2" fill="${C.accent}"/>
  <text x="${W - PAD}" y="${gTop + gh + 15}" ${F} font-size="10" text-anchor="end" fill="${C.muted}" fill-opacity=".8">peak ${max} in a week</text>
  <line x1="${PAD}" y1="${gTop + gh}" x2="${W - PAD}" y2="${gTop + gh}" stroke="${C.rule}" stroke-opacity=".2" stroke-width="1"/>

  <text x="${PAD}" y="${barY - 10}" ${F} font-size="10" font-weight="700" letter-spacing="1.4" fill="${C.muted}">TOP LANGUAGES BY CODE</text>
  ${segs}
${legend}
</svg>
`;
}

const { user, repos } = await collect();

const days = user.contributionsCollection.contributionCalendar.weeks.flatMap((w) =>
  w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount }))
);
const weekTotals = user.contributionsCollection.contributionCalendar.weeks.map((w) =>
  w.contributionDays.reduce((a, d) => a + d.contributionCount, 0)
);
const { current, longest } = streaks(days);

const byLang = new Map();
for (const r of repos) {
  for (const e of r.languages.edges) {
    const k = e.node.name;
    const prev = byLang.get(k) || { size: 0, color: e.node.color || C.muted };
    byLang.set(k, { size: prev.size + e.size, color: prev.color });
  }
}
const total = [...byLang.values()].reduce((a, v) => a + v.size, 0) || 1;
const ranked = [...byLang.entries()]
  .map(([name, v]) => ({ name, color: v.color, pct: (v.size / total) * 100 }))
  .sort((a, b) => b.pct - a.pct);
const top = ranked.slice(0, 5);
const restPct = ranked.slice(5).reduce((a, l) => a + l.pct, 0);
if (restPct > 0.05) top.push({ name: "Other", color: "#7D8590", pct: restPct });

const cutoff = Date.now() - 90 * 864e5;
const stats = {
  contributions: user.contributionsCollection.contributionCalendar.totalContributions,
  current,
  longest,
  active: repos.filter((r) => new Date(r.pushedAt).getTime() >= cutoff).length,
  repos: user.pubRepos.totalCount,
  private: user.privRepos.totalCount,
  reposAll: user.pubRepos.totalCount + user.privRepos.totalCount,
  stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
};

const generated = `updated ${days[days.length - 1].date}`;
const svg = render({ stats, weeks: weekTotals, langs: top, generated });

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/github-stats.svg`, svg);

console.log(
  `wrote ${OUT_DIR}/github-stats.svg  ${svg.length}B\n` +
    `  contributions=${stats.contributions} current=${current} longest=${longest} ` +
    `active90d=${stats.active} public=${stats.repos} private=${stats.private} ` +
    `${stats.private ? "" : "(token cannot see private repos) "}stars=${stats.stars}\n` +
    `  languages=${top.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(", ")}`
);
