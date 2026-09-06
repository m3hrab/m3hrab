/**
 * Generates a "constellation" style GitHub contribution graph.
 * Each day becomes a star; brightness/size scales with contribution count.
 * Consecutive active days (streaks) are joined with thin constellation lines.
 *
 * Usage: GITHUB_TOKEN=xxx GITHUB_USER=m3hrab node generate.js
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

// Deterministic pseudo-random jitter based on a string seed, so the layout
// is stable across regenerations (doesn't jump around every run).
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

function buildSvg(weeks, { bg, star, starDim, line, textColor }) {
  const cellSize = 12;
  const paddingX = 30;
  const paddingY = 30;
  const width = weeks.length * cellSize + paddingX * 2;
  const height = 7 * cellSize + paddingY * 2 + 30; // extra for caption

  // Flatten all days with computed grid position
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

  function jitteredPos(day) {
    const rnd = seededRandom(day.date);
    const jx = (rnd() - 0.5) * cellSize * 0.85;
    const jy = (rnd() - 0.5) * cellSize * 0.85;
    const x = paddingX + day.col * cellSize + cellSize / 2 + jx;
    const y = paddingY + day.row * cellSize + cellSize / 2 + jy;
    return { x, y };
  }

  const positions = new Map();
  allDays.forEach((d) => positions.set(d.date, jitteredPos(d)));

  // Build connecting lines between consecutive active days (streaks)
  const lines = [];
  let prevActive = null;
  const sortedDays = [...allDays].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of sortedDays) {
    if (d.count > 0) {
      if (prevActive) {
        const p1 = positions.get(prevActive.date);
        const p2 = positions.get(d.date);
        // Only connect if reasonably close (avoid long lines across big gaps
        // if streak spans week boundary awkwardly) — allow up to 3 days gap
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

  let starsSvg = "";
  allDays.forEach((d) => {
    const pos = positions.get(d.date);
    const r = starRadius(d.count);
    const o = starOpacity(d.count);
    const fill = d.count > 0 ? star : starDim;
    // Add a soft glow for high-activity days using a blurred larger circle
    if (d.count > 0 && d.count >= maxCount * 0.7) {
      starsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
        2
      )}" r="${(r * 1.7).toFixed(2)}" fill="${star}" opacity="${(
        o * 0.1
      ).toFixed(2)}" />`;
    }
    starsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
      2
    )}" r="${r.toFixed(2)}" fill="${fill}" opacity="${o.toFixed(2)}">`;
    starsSvg += `<title>${d.date}: ${d.count} contribution${
      d.count === 1 ? "" : "s"
    }</title>`;
    starsSvg += `</circle>`;
  });

  let linesSvg = "";
  lines.forEach((l) => {
    linesSvg += `<line x1="${l.x1.toFixed(2)}" y1="${l.y1.toFixed(
      2
    )}" x2="${l.x2.toFixed(2)}" y2="${l.y2.toFixed(2)}" stroke="${line}" stroke-width="0.6" opacity="0.35" />`;
  });

  const caption = `${totalContributions.toLocaleString()} contributions mapped as stars`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" />
  <g>${linesSvg}</g>
  <g>${starsSvg}</g>
  <text x="${width / 2}" y="${height - 10}" text-anchor="middle" font-family="Fira Code, monospace" font-size="10" fill="${textColor}" opacity="0.6">${caption}</text>
</svg>`;
}

async function main() {
  const result = await graphqlRequest(query, { userName: GITHUB_USER });
  const weeks =
    result.data.user.contributionsCollection.contributionCalendar.weeks;

  const darkSvg = buildSvg(weeks, {
    bg: "#0d1117",
    star: "#ffffff",
    starDim: "#30363d",
    line: "#8b8b8b",
    textColor: "#c9d1d9",
  });

  const lightSvg = buildSvg(weeks, {
    bg: "#ffffff",
    star: "#111111",
    starDim: "#e0e0e0",
    line: "#555555",
    textColor: "#444444",
  });

  // process.cwd() is the repo root when run via `node .github/scripts/...`
  // from the GitHub Actions checkout — writing there (not __dirname) so the
  // workflow's build_dir: dist step can find it.
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
