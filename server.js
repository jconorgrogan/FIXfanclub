const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const START = Date.UTC(2024, 0, 1) / 1000;
const END_PAD_DAYS = 2;
const CACHE_MS = 24 * 60 * 60 * 1000;

let chartCache = null;

const seriesConfig = [
  ["FIX", "FIX", "#0f7f73", 6],
  ["BTC-USD", "BTC - Bitcoin", "#f7931a", 4.5],
  ["^GSPC", "S&P 500", "#56616c", 4],
  ["SOL-USD", "SOLANA", "#7c3aed", 4.5],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dateLabel(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function fetchSeries(symbol) {
  const period2 = Math.floor(Date.now() / 1000) + END_PAD_DAYS * 86400;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(START));
  url.searchParams.set("period2", String(period2));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 FIXfanclub/1.0" } });
  if (!response.ok) throw new Error(`${symbol} ${response.status}`);
  const data = await response.json();
  const result = data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error(`No chart result for ${symbol}`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators.quote[0].close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (!Number.isFinite(close)) continue;
    points.push([new Date(timestamps[i] * 1000), Number(close)]);
  }
  if (!points.length) throw new Error(`No closes for ${symbol}`);
  const base = points[0][1];
  return points.map(([date, close]) => [date, (close / base) * 100]);
}

async function buildChartSvg() {
  const fetched = {};
  for (const [symbol, label, color, width] of seriesConfig) {
    const points = await fetchSeries(symbol);
    fetched[label] = { symbol, label, color, width, points, last: points.at(-1)[1] };
  }

  const minDate = new Date(Math.min(...Object.values(fetched).map((s) => s.points[0][0].getTime())));
  const maxDate = new Date(Math.max(...Object.values(fetched).map((s) => s.points.at(-1)[0].getTime())));
  const days = Math.max(1, (maxDate - minDate) / 86400000);
  const left = 88;
  const right = 1554;
  const top = 42;
  const bottom = 306;
  const yMax = 1000;
  const xFor = (date) => left + ((date - minDate) / 86400000 / days) * (right - left);
  const yFor = (value) => bottom - (Math.max(0, Math.min(value, yMax)) / yMax) * (bottom - top);
  const poly = (points) => points.map(([date, value]) => `${xFor(date).toFixed(1)},${yFor(value).toFixed(1)}`).join(" ");

  const yTicks = [1000, 750, 500, 250, 0];
  const monthMarks = [
    [new Date(Date.UTC(2024, 0, 1)), "Jan 2024"],
    [new Date(Date.UTC(2024, 6, 1)), "Jul 2024"],
    [new Date(Date.UTC(2025, 0, 1)), "Jan 2025"],
    [new Date(Date.UTC(2025, 6, 1)), "Jul 2025"],
    [new Date(Date.UTC(2026, 0, 1)), "Jan 2026"],
    [new Date(Date.UTC(2026, 4, 1)), "May 2026"],
  ];

  let peak = -Infinity;
  let lastKept = -Infinity;
  const athDots = [];
  for (const [date, value] of fetched.FIX.points) {
    if (value <= peak) continue;
    peak = value;
    if (!athDots.length || value - lastKept >= 12) {
      athDots.push([date, value]);
      lastKept = value;
    }
  }
  const finalAth = fetched.FIX.points.reduce((best, point) => (point[1] > best[1] ? point : best), fetched.FIX.points[0]);
  if (athDots.at(-1)?.[0].getTime() !== finalAth[0].getTime()) athDots.push(finalAth);

  const legend = seriesConfig.map(([, label, color], index) => {
    const x = left + index * 245;
    return `<g transform="translate(${x} 27)"><line x1="0" x2="34" y1="0" y2="0" stroke="${color}" stroke-width="6" stroke-linecap="round"/><text x="44" y="5" class="chart-legend">${escapeHtml(label)} ${fetched[label].last.toFixed(0)}</text></g>`;
  }).join("");

  const polylines = ["S&P 500", "SOLANA", "BTC - Bitcoin", "FIX"].map((label) => {
    const item = fetched[label];
    const opacity = label === "S&P 500" ? ' opacity=".78"' : label === "SOLANA" ? ' opacity=".9"' : "";
    return `<polyline points="${poly(item.points)}" fill="none" stroke="${item.color}" stroke-width="${item.width}" stroke-linejoin="round" stroke-linecap="round"${opacity}/>`;
  }).join("");

  const dots = athDots.map(([date, value], index) => `<g class="ath-dot" tabindex="0" role="button" aria-label="${dateLabel(date)} FIX all-time high" data-index="${index}" transform="translate(${xFor(date).toFixed(1)} ${yFor(value).toFixed(1)})">
      <circle r="11" class="ath-hit"/>
      <circle r="5.4" class="ath-core"/>
      <circle r="9" class="ath-ring"/>
    </g>`).join("");

  return `<svg class="fix-chart" viewBox="0 0 1600 345" preserveAspectRatio="xMidYMid meet" role="img" aria-label="FIX versus BTC - Bitcoin, SOLANA, and S&amp;P 500 since January 2024">
  <rect width="1600" height="345" fill="#fbfbf7"/>
  <g class="chart-grid">${yTicks.map((tick) => `<line x1="${left}" x2="${right}" y1="${yFor(tick).toFixed(1)}" y2="${yFor(tick).toFixed(1)}"/>`).join("")}${monthMarks.map(([date]) => `<line x1="${xFor(date).toFixed(1)}" x2="${xFor(date).toFixed(1)}" y1="${top}" y2="${bottom}"/>`).join("")}</g>
  <g class="chart-axis">
    <line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/><line x1="${left}" x2="${left}" y1="${top}" y2="${bottom}"/>
    ${yTicks.map((tick) => `<text x="${left - 18}" y="${(yFor(tick) + 5).toFixed(1)}" text-anchor="end">${tick}</text>`).join("")}
  </g>
  ${legend}
  ${polylines}
  <g class="ath-layer">${dots}</g>
  ${monthMarks.map(([date, label]) => `<text x="${xFor(date).toFixed(1)}" y="333" text-anchor="middle" class="chart-year">${label}</text>`).join("")}
</svg>`;
}

async function chartSvg() {
  const now = Date.now();
  if (chartCache && now - chartCache.createdAt < CACHE_MS) return chartCache.svg;
  const svg = await buildChartSvg();
  chartCache = { createdAt: now, svg };
  return svg;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveFile(req, res) {
  let requestPath = decodeURIComponent(req.url.split("?")[0]);
  if (requestPath === "/") requestPath = fs.existsSync(path.join(ROOT, "index.html")) ? "/index.html" : "/bob_hvac_media_ride.html";
  const resolved = path.resolve(ROOT, `.${requestPath}`);
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(resolved), "Cache-Control": "public, max-age=300" });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/chart.svg")) {
    try {
      const svg = await chartSvg();
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
      res.end(svg);
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`chart unavailable: ${error.message}`);
    }
    return;
  }
  serveFile(req, res);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`FIXfanclub listening on ${PORT}`);
});
