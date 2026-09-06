/**
 * Constellation contribution graph — v3
 *
 * Upgrades over v2:
 * - Recency coloring now spans the FULL year (Jan → Dec / full 365-day
 *   window), not just the last 90 days — warm (recent) to cool (old)
 *   across the entire timeline, so the color itself tells a year-long story.
 * - Size still driven purely by commit count (unchanged) — color and size
 *   are fully decoupled: size = "how much", color = "how recent".
 * - Twinkle reserved for truly high-commit days only (raised threshold
 *   from 0.55 -> 0.8 of maxCount), so only the standout days pulse.
 * - Streak lines are now soft curved glowing arcs (quadratic bezier +
 *   blurred glow pass), colored as a blend of the two stars they connect,
 *   instead of straight thin spreadsheet-style connectors.
 * - Year/timeframe label rendered top-right.
 * - Caption now reports longest streak, current streak, and most active
 *   month, in addition to total contributions.
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

// Parse an "rgb(r,g,b)" string back into components, for blending line colors
function parseRgbString(s) {
  const m = s.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return { r: 128, g: 128, b: 128 };
  return { r: +m[1], g: +m[2], b: +m[3] };
}

function blendRgbStrings(a, b) {
  const pa = parseRgbString(a);
  const pb = parseRgbString(b);
  return `rgb(${Math.round((pa.r + pb.r) / 2)},${Math.round(
    (pa.g + pb.g) / 2
  )},${Math.round((pa.b + pb.b) / 2)})`;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatMonthYear(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

// Compute longest streak, current streak (ending on the last day with
// data), and the most active calendar month across the whole dataset.
function computeStats(sortedDays) {
  let longest = 0;
  let running = 0;
  let current = 0;

  for (const d of sortedDays) {
    if (d.count > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  // Current streak: walk backwards from the most recent day.
  for (let i = sortedDays.length - 1; i >= 0; i--) {
    if (sortedDays[i].count > 0) {
      current += 1;
    } else {
      break;
    }
  }

  const monthTotals = new Map(); // "YYYY-M" -> { total, date }
  for (const d of sortedDays) {
    const dt = new Date(d.date);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    const entry = monthTotals.get(key) || { total: 0, date: dt };
    entry.total += d.count;
    monthTotals.set(key, entry);
  }

  let mostActiveMonth = null;
  let mostActiveTotal = -1;
  for (const { total, date } of monthTotals.values()) {
    if (total > mostActiveTotal) {
      mostActiveTotal = total;
      mostActiveMonth = date;
    }
  }

  return { longest, current, mostActiveMonth, mostActiveTotal };
}

function buildSvg(weeks, theme) {
  const { bg, starDim, lineGlow, textColor, recentColor, oldColor } = theme;

  const cellSize = 12;
  const paddingX = 30;
  const paddingY = 26;
  const monthLabelHeight = 18;
  const captionHeight = 42; // two lines of caption text now
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

  // Recency-based color spans the FULL year: index 0 (oldest) -> oldColor,
  // last index (most recent) -> recentColor. Zero-count days stay dim/neutral
  // regardless of recency (no point coloring empty space).
  function starColor(day, index) {
    if (day.count === 0) return starDim;
    const t = totalDays > 1 ? index / (totalDays - 1) : 1; // 0=oldest, 1=newest
    // t=1 (most recent) -> recentColor, t=0 (oldest) -> oldColor
    return lerpColor(oldColor, recentColor, t);
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
  const colors = new Map();
  allDays.forEach((d, i) => {
    positions.set(d.date, jitteredPos(d));
    colors.set(d.date, starColor(d, i));
  });

  const sortedDays = [...allDays].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Build curved, glowing streak connectors between consecutive active days.
  const curves = [];
  let prevActive = null;
  for (const d of sortedDays) {
    if (d.count > 0) {
      if (prevActive) {
        const gapDays =
          (new Date(d.date) - new Date(prevActive.date)) / (1000 * 60 * 60 * 24);
        if (gapDays <= 1) {
          const p1 = positions.get(prevActive.date);
          const p2 = positions.get(d.date);
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const perpX = -dy / len;
          const perpY = dx / len;
          const rnd = seededRandom(prevActive.date + d.date);
          const sign = rnd() > 0.5 ? 1 : -1;
          const bow = sign * (1.5 + rnd() * 2.5); // gentle arc, not a sharp bend
          const mx = (p1.x + p2.x) / 2 + perpX * bow;
          const my = (p1.y + p2.y) / 2 + perpY * bow;
          const strokeColor = blendRgbStrings(
            colors.get(prevActive.date),
            colors.get(d.date)
          );
          curves.push({
            d: `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Q ${mx.toFixed(
              2
            )} ${my.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
            color: strokeColor,
          });
        }
      }
      prevActive = d;
    }
  }

  const stats = computeStats(sortedDays);
  const totalContributions = allDays.reduce((s, d) => s + d.count, 0);

  const startDate = new Date(sortedDays[0].date);
  const endDate = new Date(sortedDays[sortedDays.length - 1].date);
  const timeframeLabel =
    startDate.getFullYear() === endDate.getFullYear()
      ? `${startDate.getFullYear()}`
      : `${formatMonthYear(startDate)} – ${formatMonthYear(endDate)}`;

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

  const yearLabelSvg = `<text x="${width - paddingX}" y="${monthLabelHeight}" text-anchor="end" font-family="Fira Code, monospace" font-size="9" fill="${textColor}" opacity="0.6">${timeframeLabel}</text>`;

  // Curved glow lines: a wide blurred pass underneath, a crisp thin pass on top.
  let glowLinesSvg = "";
  let crispLinesSvg = "";
  curves.forEach((c) => {
    glowLinesSvg += `<path d="${c.d}" fill="none" stroke="${c.color}" stroke-width="2.4" opacity="0.35" stroke-linecap="round" filter="url(#streak-glow)" />`;
    crispLinesSvg += `<path d="${c.d}" fill="none" stroke="${c.color}" stroke-width="0.7" opacity="0.55" stroke-linecap="round" />`;
  });

  // Stars: dim/static first (background layer), then bright/animated
  // (foreground layer) so twinkle glows aren't occluded by static dots.
  // Twinkle is now reserved for only the truly high-commit days.
  const TWINKLE_THRESHOLD = 0.8;
  let dimStarsSvg = "";
  let brightStarsSvg = "";

  allDays.forEach((d, i) => {
    const pos = positions.get(d.date);
    const r = starRadius(d.count);
    const o = starOpacity(d.count);
    const fill = colors.get(d.date);
    const isBright = d.count > 0 && d.count >= maxCount * TWINKLE_THRESHOLD;

    const title = `<title>${d.date}: ${d.count} contribution${
      d.count === 1 ? "" : "s"
    }</title>`;

    if (isBright) {
      // Soft glow halo
      brightStarsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
        2
      )}" r="${(r * 2.2).toFixed(2)}" fill="${fill}" opacity="${(
        o * 0.15
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
    } else {
      dimStarsSvg += `<circle cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(
        2
      )}" r="${r.toFixed(2)}" fill="${fill}" opacity="${o.toFixed(
        2
      )}">${title}</circle>`;
    }
  });

  const captionLine1 = `${totalContributions.toLocaleString()} contributions mapped as stars`;
  const mostActiveLabel = stats.mostActiveMonth
    ? formatMonthYear(stats.mostActiveMonth)
    : "—";
  const captionLine2 = `Longest streak ${stats.longest}d  ·  Current streak ${stats.current}d  ·  Busiest month ${mostActiveLabel}`;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="streak-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.6" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <style>
    @keyframes tw { 0%, 100% { opacity: var(--o, 1); } 50% { opacity: calc(var(--o, 1) * 0.35); } }
    .tw { animation-name: tw; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
  </style>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" />
  <g>${monthLabelsSvg}${yearLabelSvg}</g>
  <g>${glowLinesSvg}</g>
  <g>${crispLinesSvg}</g>
  <g>${dimStarsSvg}</g>
  <g>${brightStarsSvg}</g>
  <text x="${width / 2}" y="${height - 26}" text-anchor="middle" font-family="Fira Code, monospace" font-size="10" fill="${textColor}" opacity="0.65">${captionLine1}</text>
  <text x="${width / 2}" y="${height - 10}" text-anchor="middle" font-family="Fira Code, monospace" font-size="9" fill="${textColor}" opacity="0.5">${captionLine2}</text>
</svg>`;
}

async function main() {
  const result = await graphqlRequest(query, { userName: GITHUB_USER });
  const weeks =
    result.data.user.contributionsCollection.contributionCalendar.weeks;

  const darkSvg = buildSvg(weeks, {
    bg: "#0d1117",
    starDim: "#30363d",
    lineGlow: "#8b8b8b",
    textColor: "#c9d1d9",
    recentColor: "#ffb454", // warm amber = recent activity
    oldColor: "#5b8fd6", // cool blue = older activity
  });

  const lightSvg = buildSvg(weeks, {
    bg: "#ffffff",
    starDim: "#e0e0e0",
    lineGlow: "#555555",
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
