/**
 * Constellation contribution graph — v2
 *
 * Design upgrades over v1:
 * - Native SVG/CSS @keyframes: brightest stars gently twinkle (opacity pulse)
 * - Color maps to RECENCY, not just intensity: recent activity glows warm
 *   (amber/coral), older activity cools toward blue/white — so the graph
 *   tells a story (trending up vs quiet lately), not just decoration
 * - Month labels along the bottom, like the native contribution graph,
 *   so the timeline has context instead of feeling abstract
 * - Deterministic jitter (unchanged from v1) keeps layout stable day-to-day
 * - <title> tooltips retain exact date + count per star
 *
 * Usage: GITHUB_TOKEN=xxx GITHUB_USER=m3hrab node generate-constellation.js
 * Outputs: dist/constellation.svg, dist/constellation-dark.svg
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const GITHUB_USER = process.env.GITHUB_USER || "m3hrab";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error("Missing GITHUB_TOKEN env var");
  process.exit(1);
}

const query = `
query($userName: String!) {
  user(login: $userName) {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

function graphqlRequest(query, variables) {
  const data = JSON.stringify({ query, variables });
  const options = {
    hostname: "api.github.com",
    path: "/graphql",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `bearer ${GITHUB_TOKEN}`,
      "User-Agent": "constellation-generator",
      "Content-Length": Buffer.byteLength(data),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.errors) {
            reject(new Error(JSON.stringify(parsed.errors)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  return function () {
    h = (h * 9301 + 49297) % 233280;
    return h / 233280;
  };
}

// Interpolate between two hex colors. t=0 -> a, t=1 -> b
function lerpColor(a, b, t) {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * t);
  const g = Math.round(pa.g + (pb.g - pa.g) * t);
  const bch = Math.round(pa.b + (pb.b - pa.b) * t);
  return `rgb(${r},${g},${bch})`;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function buildSvg(weeks, theme) {
  const { bg, starDim, line, textColor, recentColor, oldColor, coldest } = theme;

  const cellSize = 12;
  const paddingX = 30;
  const paddingY = 26;
  const monthLabelHeight = 18;
  const captionHeight = 28;
  const width = weeks.length * cellSize + paddingX * 2;
  const height =
    monthLabelHeight + 7 * cellSize + paddingY * 2 + captionHeight;

  const allDays = [];
  weeks.forEach((week, wi) => {
    week.contributionDays.forEach((day, di) => {
      allDays.push({
        date: day.date,
        count: day.contributionCount,
        col: wi,
        row: di,
      });
    });
  });

  const maxCount = Math.max(...allDays.map((d) => d.count), 1);
  const totalDays = allDays.length;

  function starRadius(count) {
    if (count === 0) return 0.6;
    const scale = Math.sqrt(count / maxCount);
    return 1.2 + scale * 2.8;
  }

  function starOpacity(count) {
    if (count === 0) return 0.15;
    const scale = Math.sqrt(count / maxCount);
    return 0.45 + scale * 0.55;
  }

  // Recency-based color: most recent ~90 days trend warm (recentColor),
  // older days cool toward oldColor. Zero-count days stay dim/neutral
  // regardless of recency (no point coloring empty space).
  function starColor(day, index) {
    if (day.count === 0) return starDim;
    const recencyWindow = Math.min(90, totalDays);
    const distanceFromEnd = totalDays - 1 - index;
    const t = Math.min(1, distanceFromEnd / recencyWindow);
    // t=0 (most recent) -> recentColor, t=1 (older) -> oldColor
    return lerpColor(recentColor, oldColor, t);
  }

  function jitteredPos(day) {
    const rnd = seededRandom(day.date);
    const jx = (rnd() - 0.5) * cellSize * 0.85;
    const jy = (rnd() - 0.5) * cellSize * 0.85;
    const x = paddingX + day.col * cellSize + cellSize / 2 + jx;
    const y =
      monthLabelHeight + paddingY + day.row * cellSize + cellSize / 2 + jy;
    return { x, y };
  }

  const positions = new Map();
  allDays.forEach((d) => positions.set(d.date, jitteredPos(d)));

  const lines = [];
  let prevActive = null;
  const sortedDays = [...allDays].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of sortedDays) {
    if (d.count > 0) {
      if (prevActive) {
        const p1 = positions.get(prevActive.date);
        const p2 = positions.get(d.date);
        const gapDays =
          (new Date(d.date) - new Date(prevActive.date)) / (1000 * 60 * 60 * 24);
        if (gapDays <= 1) {
          lines.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
        }
      }
      prevActive = d;
    }
  }

  const totalContributions = allDays.reduce((s, d) => s + d.count, 0);

  // Month labels: mark the first week-column where a new month starts
  const monthLabels = [];
  let lastMonth = null;
  weeks.forEach((week, wi) => {
    const firstDay = week.contributionDays[0];
    if (!firstDay) return;
    const month = new Date(firstDay.date).getMonth();
    if (month !== lastMonth) {
      monthLabels.push({
        label: MONTH_NAMES[month],
        x: paddingX + wi * cellSize,
      });
      lastMonth = month;
    }
  });

  let monthLabelsSvg = "";
  monthLabels.forEach((m) => {
    monthLabelsSvg += `<text x="${m.x.toFixed(
      2
    )}" y="${monthLabelHeight}" font-family="Fira Code, monospace" font-size="9" fill="${textColor}" opacity="0.5">${m.label}</text>`;
  });

  // Stars: dim/static first (background layer), then bright/animated
  // (foreground layer) so twinkle glows aren't occluded by static dots.
  let dimStarsSvg = "";
  let brightStarsSvg = "";
  let twinkleDefs = "";
  let twinkleIndex = 0;

  allDays.forEach((d, i) => {
    const pos = positions.get(d.date);
    const r = starRadius(d.count);
    const o = starOpacity(d.count);
    const fill = starColor(d, i);
    const isBright = d.count > 0 && d.count >= maxCount * 0.55;

    const title = `<title>${d.date}: ${d.count} contribution${
      d.count === 1 ? "" : "s"
    }</title>`;

    if (isBright) {
      // Soft glow halo
      brightStarsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
        2
      )}" r="${(r * 2).toFixed(2)}" fill="${fill}" opacity="${(
        o * 0.12
      ).toFixed(2)}" />`;

      // Twinkling star: unique animation-delay per star via inline style,
      // staggered so stars don't pulse in unison.
      const delay = (seededRandom(d.date + "-delay")() * 4).toFixed(2);
      const duration = (2.4 + seededRandom(d.date + "-dur")() * 1.6).toFixed(
        2
      );
      brightStarsSvg += `<circle class="tw" style="--o:${o.toFixed(
        2
      )};animation-delay:${delay}s;animation-duration:${duration}s" cx="${pos.x.toFixed(
        2
      )}" cy="${pos.y.toFixed(2)}" r="${r.toFixed(
        2
      )}" fill="${fill}" opacity="${o.toFixed(2)}">${title}</circle>`;
      twinkleIndex++;
    } else {
      dimStarsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
        2
      )}" r="${r.toFixed(2)}" fill="${fill}" opacity="${o.toFixed(
        2
      )}">${title}</circle>`;
    }
  });

  let linesSvg = "";
  lines.forEach((l) => {
    linesSvg += `<line x1="${l.x1.toFixed(2)}" y1="${l.y1.toFixed(
      2
    )}" x2="${l.x2.toFixed(2)}" y2="${l.y2.toFixed(2)}" stroke="${line}" stroke-width="0.6" opacity="0.35" />`;
  });

  const caption = `${totalContributions.toLocaleString()} contributions mapped as stars`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    @keyframes tw { 0%, 100% { opacity: var(--o, 1); } 50% { opacity: calc(var(--o, 1) * 0.35); } }
    .tw { animation-name: tw; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" />
  <g>${monthLabelsSvg}</g>
  <g>${linesSvg}</g>
  <g>${dimStarsSvg}</g>
  <g>${brightStarsSvg}</g>
  <text x="${width / 2}" y="${height - 10}" text-anchor="middle" font-family="Fira Code, monospace" font-size="10" fill="${textColor}" opacity="0.6">${caption}</text>
</svg>`;
}

async function main() {
  const result = await graphqlRequest(query, { userName: GITHUB_USER });
  const weeks =
    result.data.user.contributionsCollection.contributionCalendar.weeks;

  const darkSvg = buildSvg(weeks, {
    bg: "#0d1117",
    starDim: "#30363d",
    line: "#8b8b8b",
    textColor: "#c9d1d9",
    recentColor: "#ffb454", // warm amber = recent activity
    oldColor: "#5b8fd6", // cool blue = older activity
  });

  const lightSvg = buildSvg(weeks, {
    bg: "#ffffff",
    starDim: "#e0e0e0",
    line: "#555555",
    textColor: "#444444",
    recentColor: "#d85a1e", // warm coral-amber, readable on white
    oldColor: "#2a5ea8", // cool blue, readable on white
  });

  const outDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "constellation-dark.svg"), darkSvg);
  fs.writeFileSync(path.join(outDir, "constellation.svg"), lightSvg);

  console.log("Generated constellation SVGs in", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
