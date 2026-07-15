// Garmin performance heatmaps — an Übersicht widget.
// Reads ~/.garmin_heatmap/data.json (written by garmin_fetch.py) and draws:
//   * a Daily Wellness Score headline (evidence-based, personal-baseline z-scores)
//   * one GitHub-style contribution grid per metric (brighter = better day)
//   * click any row to drill into trend / rolling avg / weekday pattern / score share
//   * a settings panel (gear) to choose which metrics show and switch light/dark
//
// Interactivity uses Übersicht's built-in state API (initialState / updateState /
// dispatch) so UI state survives the periodic data refresh; user *preferences*
// (theme + which metrics are shown) are additionally persisted to localStorage so
// they survive an app restart.
//
// Install: put this file at
//   ~/Library/Application Support/Übersicht/widgets/garmin-heatmap.widget/index.jsx

// -------- config you might tweak --------
const WEEKS = 26;          // columns of heatmap history (~6 months)
const CELL = 10;           // px per day cell
const GAP = 2.5;           // px between cells
const DETAIL_DAYS = 90;    // how much history the drill-down charts show

// Distinct hue per axis. Brightness encodes "goodness" (the data file already
// inverts low-is-better metrics for coloring, so a calm/low day still lights up).
// Bright hues for the dark theme (they glow on black).
const COLORS = {
  "Wellness":     [190, 242, 100],
  "Sleep":        [140, 150, 248],
  "Body Battery": [251, 191,  36],
  "Stress":       [ 96, 165, 250],
  "Steps":        [ 52, 211, 153],
  "Exercise":     [167, 139, 250],
  "HRV":          [ 45, 212, 191],
  "Resting HR":   [248, 113, 113],
  "Readiness":    [ 74, 222, 128],
};
// Deeper, more saturated variants for the light theme. High-luminance hues (lime,
// amber, emerald) are nearly as bright as white, so on a light card no opacity
// level makes them legible — these keep the same hue but drop the lightness so
// they actually read. Roughly Tailwind 600/700 tones.
const COLORS_LIGHT = {
  "Wellness":     [ 77, 145,  20],
  "Sleep":        [ 79,  91, 216],
  "Body Battery": [180, 123,   8],
  "Stress":       [ 37, 120, 220],
  "Steps":        [ 13, 148,  98],
  "Exercise":     [124,  92, 232],
  "HRV":          [ 13, 148, 136],
  "Resting HR":   [220,  60,  60],
  "Readiness":    [ 22, 150,  70],
};
// Display order. Any metric can be shown or hidden from the ⚙ panel; the three
// physiological extras are hidden by default to keep the first view clean.
const ORDER = ["Wellness", "Sleep", "Body Battery", "Stress", "Steps", "Exercise", "HRV", "Resting HR", "Readiness"];
const DEFAULT_HIDDEN = { "HRV": true, "Resting HR": true, "Readiness": true };

const LABEL_W = 116;   // roomy enough for the widest label ("Body Battery") in mono
const CHIP_W = 68;
const GOOD = "rgba(74,222,128,0.9)";
const BAD = "rgba(248,113,113,0.85)";

// ---- typography -------------------------------------------------------------
// The whole widget is set in a monospaced "instrument" face: every glyph is the
// same width, so numbers, axis labels and the heatmap grid lock into one rhythm —
// a telemetry-panel feel that suits a dense metrics dashboard. SF Mono ships with
// macOS (no install needed); swap UI_FONT to SANS, or to another mono if you have
// it, in one place here.
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", sans-serif';
const MONO = '"SF Mono", "JetBrains Mono", "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const UI_FONT = MONO;

const TYPE = {
  // uppercase tracked labels (section headers). Mono is already wide, so lighter tracking.
  eyebrow:  { fontSize: 10,   fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" },
  // metric names / primary row labels
  name:     { fontSize: 11,   fontWeight: 500, letterSpacing: "0" },
  // captions and secondary text
  caption:  { fontSize: 10.5, fontWeight: 500, letterSpacing: "0" },
  small:    { fontSize: 10,   fontWeight: 450, letterSpacing: "0" },
  micro:    { fontSize: 9,    fontWeight: 500, letterSpacing: "0.01em" },
  // numeric readouts
  chipBig:  { fontSize: 14.5, fontWeight: 600, lineHeight: 1 },
  chipSub:  { fontSize: 9.5,  fontWeight: 500, letterSpacing: "0" },
  scoreNum: { fontSize: 26,   fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1 },
};
// ----------------------------------------

export const refreshFrequency = 15 * 60 * 1000; // widget re-reads the file; data refreshed by launchd

export const command =
  'cat "$HOME/.garmin_heatmap/data.json" 2>/dev/null || echo "{}"';

// className only positions the widget; font + color are set per-theme on the card.
export const className = `
  top: 26px;
  left: 26px;
`;

// ---- theme -----------------------------------------------------------------
function themeVars(theme) {
  if (theme === "light") {
    return {
      fg: "#141821", name: "rgba(20,24,33,0.92)", dim: "rgba(20,24,33,0.6)",
      faint: "rgba(20,24,33,0.42)",
      // near-opaque card so a busy wallpaper can't bleed through and kill contrast
      cardBg: "rgba(247,248,250,0.95)", cardBorder: "rgba(0,0,0,0.12)",
      empty: "rgba(20,24,33,0.11)", rowSel: "rgba(0,0,0,0.055)", rowSelBorder: "rgba(0,0,0,0.12)",
      panelBg: "rgba(20,24,33,0.045)", panelBorder: "rgba(0,0,0,0.09)",
      track: "rgba(20,24,33,0.10)", shadow: "0 12px 40px rgba(0,0,0,0.22)",
      // higher opacity floor: on a light card, low-opacity fills wash out to white,
      // so even the lowest level needs to stay clearly colored.
      alpha: [0.55, 0.72, 0.86, 1.0],
      colors: COLORS_LIGHT,
    };
  }
  return {
    fg: "#e7e9ee", name: "rgba(231,233,238,0.84)", dim: "rgba(231,233,238,0.44)",
    faint: "rgba(231,233,238,0.28)",
    cardBg: "rgba(17,19,26,0.72)", cardBorder: "rgba(255,255,255,0.08)",
    empty: "rgba(255,255,255,0.055)", rowSel: "rgba(255,255,255,0.05)", rowSelBorder: "rgba(255,255,255,0.08)",
    panelBg: "rgba(255,255,255,0.035)", panelBorder: "rgba(255,255,255,0.06)",
    track: "rgba(255,255,255,0.06)", shadow: "0 12px 40px rgba(0,0,0,0.45)",
    alpha: [0.30, 0.50, 0.72, 1.0],
    colors: COLORS,
  };
}

// ---- preference persistence (safe on node/SSR where window is absent) --------
const PREFS_KEY = "garminHeatmapPrefs";
function loadPrefs() {
  try {
    const item = (typeof window !== "undefined" && window.localStorage)
      ? window.localStorage.getItem(PREFS_KEY) : null;
    if (item == null) return { theme: "dark", hidden: { ...DEFAULT_HIDDEN } };
    const p = JSON.parse(item);
    return {
      theme: p.theme === "light" ? "light" : "dark",
      hidden: p.hidden && typeof p.hidden === "object" ? p.hidden : { ...DEFAULT_HIDDEN },
    };
  } catch (e) {
    return { theme: "dark", hidden: { ...DEFAULT_HIDDEN } };
  }
}
function savePrefs(state) {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(PREFS_KEY,
        JSON.stringify({ theme: state.theme, hidden: state.hidden }));
    }
  } catch (e) { /* ignore */ }
}

// ---- Übersicht state API ----------------------------------------------------
export const initialState = (() => {
  const p = loadPrefs();
  return { output: "", error: null, selected: null, settingsOpen: false, theme: p.theme, hidden: p.hidden };
})();

export const updateState = (event, prev) => {
  if (!event) return prev;
  switch (event.type) {
    case "UB/COMMAND_RAN":                       // data refresh: MUST fold in new output
      return { ...prev, output: event.output, error: event.error };
    case "select":
      return { ...prev, selected: prev.selected === event.name ? null : event.name };
    case "toggleSettings":
      return { ...prev, settingsOpen: !prev.settingsOpen };
    case "toggleTheme": {
      const next = { ...prev, theme: prev.theme === "light" ? "dark" : "light" };
      savePrefs(next); return next;
    }
    case "toggleMetric": {
      const hidden = { ...prev.hidden };
      if (hidden[event.name]) delete hidden[event.name];
      else hidden[event.name] = true;
      const next = { ...prev, hidden };
      savePrefs(next); return next;
    }
    default:
      return prev;
  }
};

// ---- date helpers -----------------------------------------------------------
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function buildGridDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // back to Sunday
  const cols = Math.ceil(((end - start) / 86400000 + 1) / 7);
  return { start, end, today, cols };
}

function entriesOf(metric) {
  const vals = (metric && metric.values) || {};
  return Object.keys(vals)
    .filter((k) => typeof vals[k] === "number")
    .sort()
    .map((k) => [k, vals[k]]);
}

function movingAvg(nums, k) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    const win = nums.slice(Math.max(0, i - k + 1), i + 1);
    out.push(win.reduce((a, b) => a + b, 0) / win.length);
  }
  return out;
}

// ---- heatmap coloring -------------------------------------------------------
function levelFor(value, min, max) {
  if (value == null || max == null || max === min) return value == null ? -1 : 2;
  const n = (value - min) / (max - min);
  return Math.min(3, Math.floor(n * 3.999));
}
function fill(base, level, empty, alpha) {
  if (level < 0) return empty;
  const [r, g, b] = base;
  return `rgba(${r},${g},${b},${alpha[level]})`;
}

// ---- small SVG sparkline (value line + rolling average) ---------------------
function Spark({ entries, base, w, h, avgK, T }) {
  const pts = entries.slice(-DETAIL_DAYS);
  if (pts.length < 2)
    return <div style={{ ...TYPE.small, color: T.dim }}>not enough history to chart</div>;
  const nums = pts.map(([, v]) => v);
  let min = Math.min(...nums), max = Math.max(...nums);
  if (max === min) { max += 1; min -= 1; }
  const n = pts.length;
  const X = (i) => (i / (n - 1)) * w;
  const Y = (v) => h - ((v - min) / (max - min)) * (h - 2) - 1;
  const mk = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const [r, g, b] = base;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <path d={mk(movingAvg(nums, avgK || 7))} fill="none" stroke={`rgba(${r},${g},${b},0.35)`} strokeWidth="2.5" />
      <path d={mk(nums)} fill="none" stroke={`rgba(${r},${g},${b},0.9)`} strokeWidth="1.5" />
      <circle cx={X(n - 1)} cy={Y(nums[n - 1])} r="2.4" fill={`rgb(${r},${g},${b})`} />
    </svg>
  );
}

// ---- weekday average bars ---------------------------------------------------
function WeekdayBars({ entries, base, T }) {
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  entries.slice(-DETAIL_DAYS).forEach(([d, v]) => {
    const wd = new Date(d + "T00:00:00").getDay();
    sums[wd] += v; counts[wd] += 1;
  });
  const avgs = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const max = Math.max(...avgs, 1);
  const [r, g, b] = base;
  const H = 36;
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "flex-end", width: "100%" }}>
      {avgs.map((a, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ height: H, display: "flex", alignItems: "flex-end", width: "100%" }}>
            <div style={{ width: "100%", height: Math.max(2, (a / max) * H),
                          background: `rgba(${r},${g},${b},0.65)`, borderRadius: 2 }} />
          </div>
          <div style={{ ...TYPE.micro, color: T.dim, marginTop: 4 }}>{WEEKDAYS[i][0]}</div>
        </div>
      ))}
    </div>
  );
}

// ---- score contribution block (drill-down "why") ----------------------------
function ScoreLink({ name, metrics, T }) {
  const wellness = metrics["Wellness"];
  if (!wellness) return null;
  const compDates = Object.keys(wellness.components || {}).sort();
  const latestD = compDates[compDates.length - 1];
  const comps = latestD ? wellness.components[latestD] : {};
  const weights = wellness.weights || {};

  if (name === "Wellness") {
    return (
      <div>
        <div style={{ ...TYPE.small, color: T.dim, marginBottom: 7 }}>
          Today's score = weighted mean of your personal-baseline sub-scores
        </div>
        {Object.keys(weights).map((k) => {
          const sub = comps[k];
          const [r, g, b] = T.colors[k] || [148, 163, 184];
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ ...TYPE.small, width: 80, color: T.name, flex: "none" }}>{k}</div>
              <div style={{ flex: 1, minWidth: 40, height: 6, background: T.track, borderRadius: 3 }}>
                <div style={{ width: `${sub == null ? 0 : sub}%`, height: 6,
                              background: `rgba(${r},${g},${b},0.85)`, borderRadius: 3 }} />
              </div>
              <div style={{ ...TYPE.chipSub, width: 86, flex: "none", color: T.dim,
                            textAlign: "right", whiteSpace: "nowrap" }}>
                {sub == null ? "—" : Math.round(sub)}/100&nbsp;·&nbsp;{Math.round((weights[k] || 0) * 100)}%
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (weights[name] != null) {
    const sub = comps[name];
    return (
      <div style={{ ...TYPE.small, color: T.name, lineHeight: 1.5 }}>
        Contributes <b>{Math.round(weights[name] * 100)}%</b> of your Wellness Score ·
        today's sub-score <b>{sub == null ? "—" : Math.round(sub) + "/100"}</b>
        <div style={{ color: T.dim }}>
          (normalized vs your {wellness.baseline_days || 42}-day personal baseline)
        </div>
      </div>
    );
  }
  return null;
}

// ---- drill-down detail panel ------------------------------------------------
function DetailPanel({ name, metrics, T, innerW }) {
  const metric = metrics[name];
  const base = T.colors[name] || [148, 163, 184];
  const entries = entriesOf(metric);
  const recent = entries.slice(-DETAIL_DAYS);
  const nums = recent.map(([, v]) => v);
  const s = nums.length ? {
    min: Math.min(...nums), max: Math.max(...nums),
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
  } : null;
  const unit = metric.unit && metric.unit !== "/wk" ? " " + metric.unit : "";
  const PANEL_PAD = 14;                    // must match the panel's horizontal padding below
  const panelW = innerW - 2 * PANEL_PAD;   // true content width -> charts fill it exactly

  return (
    <div style={{ margin: "2px 0 12px", padding: `13px ${PANEL_PAD}px`,
                  background: T.panelBg, border: `1px solid ${T.panelBorder}`, borderRadius: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 9 }}>
        <div style={{ ...TYPE.eyebrow, color: T.name }}>
          {name} · last {Math.min(DETAIL_DAYS, recent.length)} days
        </div>
        {s && (
          <div style={{ ...TYPE.micro, color: T.dim }}>
            min {Math.round(s.min)}{unit} · avg {Math.round(s.avg)}{unit} · max {Math.round(s.max)}{unit}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ ...TYPE.micro, color: T.dim, marginBottom: 5 }}>trend + 7-day average</div>
        <Spark entries={entries} base={base} w={panelW} h={58} avgK={7} T={T} />
      </div>
      <div>
        <div style={{ ...TYPE.micro, color: T.dim, marginBottom: 5 }}>avg by weekday</div>
        <WeekdayBars entries={entries} base={base} T={T} />
      </div>
      <div style={{ marginTop: 12, paddingTop: 11, borderTop: `1px solid ${T.panelBorder}` }}>
        <ScoreLink name={name} metrics={metrics} T={T} />
      </div>
    </div>
  );
}

// ---- month strip ------------------------------------------------------------
function MonthStrip({ start, cols, T }) {
  const cellW = CELL + GAP;
  const labels = [];
  let last = -1;
  for (let c = 0; c < cols; c++) {
    const d = new Date(start);
    d.setDate(d.getDate() + c * 7);
    if (d.getMonth() !== last && d.getDate() <= 7) {
      last = d.getMonth();
      labels.push(
        <span key={c} style={{ ...TYPE.micro, position: "absolute", left: c * cellW, color: T.dim }}>
          {MONTHS[d.getMonth()]}
        </span>
      );
    }
  }
  return (
    <div style={{ position: "relative", height: 13, marginLeft: LABEL_W, width: cols * cellW }}>
      {labels}
    </div>
  );
}

// ---- chip (right-hand latest value) -----------------------------------------
function chipFor(name, metric, T) {
  const values = (metric && metric.values) || {};
  const present = Object.keys(values).filter((k) => typeof values[k] === "number").sort();
  const latestKey = present[present.length - 1];
  const prevKey = present[present.length - 2];
  const latest = latestKey != null ? values[latestKey] : null;
  const prev = prevKey != null ? values[prevKey] : null;

  if (name === "Exercise") {
    const cutoff = iso(new Date(Date.now() - 6 * 86400000));
    const week = present.filter((k) => k >= cutoff).reduce((a, k) => a + values[k], 0);
    return { big: String(week), sub: "this week", subColor: T.dim };
  }

  const low = metric && metric.direction === "low";
  let delta = null, good = null;
  if (latest != null && prev != null) {
    delta = latest - prev;
    good = delta === 0 ? "flat" : (delta > 0) === !low ? "up" : "down";
  }
  const arrow = delta == null ? "" : delta === 0 ? "→" : delta > 0 ? "▲" : "▼";
  const color = good === "up" ? GOOD : good === "down" ? BAD : T.dim;
  const unit = metric.unit && metric.unit !== "/wk" ? " " + metric.unit : "";
  return {
    big: latest == null ? "—" : String(latest),
    sub: delta == null ? "" : `${arrow} ${Math.abs(Math.round(delta * 10) / 10)}${unit}`,
    subColor: color,
  };
}

// ---- one heatmap row --------------------------------------------------------
function Row({ name, metric, grid, dispatch, selected, T }) {
  const { start, today, cols } = grid;
  const values = (metric && metric.values) || {};
  const nums = Object.values(values).filter((v) => typeof v === "number");
  const min = nums.length ? Math.min(...nums) : null;
  const rawMax = nums.length ? Math.max(...nums) : null;
  const low = metric && metric.direction === "low";
  const norm = (v) => (v == null ? null : low ? rawMax + min - v : v);

  const base = T.colors[name] || [148, 163, 184];
  const chip = chipFor(name, metric, T);
  const isSel = selected === name;

  const cols_ = [];
  for (let c = 0; c < cols; c++) {
    const cells = [];
    for (let r = 0; r < 7; r++) {
      const d = new Date(start);
      d.setDate(d.getDate() + c * 7 + r);
      if (d > today) { cells.push(<div key={r} style={{ width: CELL, height: CELL }} />); continue; }
      const v = values[iso(d)];
      const lvl = levelFor(norm(v), min, rawMax);
      cells.push(
        <div key={r}
          title={`${iso(d)} · ${v == null ? "—" : v}${metric.unit && metric.unit !== "/wk" ? " " + metric.unit : ""}`}
          style={{ width: CELL, height: CELL, borderRadius: 2, background: fill(base, lvl, T.empty, T.alpha) }} />
      );
    }
    cols_.push(
      <div key={c} style={{ display: "grid", gridTemplateRows: `repeat(7, ${CELL}px)`, gap: GAP }}>{cells}</div>
    );
  }

  const dot = `rgb(${base[0]},${base[1]},${base[2]})`;
  return (
    <div onClick={() => dispatch({ type: "select", name })}
      style={{ display: "flex", alignItems: "center", height: 7 * CELL + 6 * GAP, marginBottom: 8,
               cursor: "pointer", borderRadius: 6,
               background: isSel ? T.rowSel : "transparent",
               boxShadow: isSel ? `inset 0 0 0 1px ${T.rowSelBorder}` : "none" }}>
      <div style={{ width: LABEL_W, display: "flex", alignItems: "center", gap: 6, paddingLeft: 4 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: dot, display: "inline-block", flex: "none" }} />
        <span style={{ ...TYPE.name, color: T.name, fontWeight: name === "Wellness" ? 700 : 500,
                       whiteSpace: "nowrap" }}>{name}</span>
        <span style={{ ...TYPE.micro, color: T.faint, marginLeft: "auto" }}>{isSel ? "▾" : "▸"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, ${CELL}px)`, gap: GAP }}>{cols_}</div>
      <div style={{ width: CHIP_W, textAlign: "right", paddingLeft: 8 }}>
        <div style={{ ...TYPE.chipBig, color: T.fg }}>{chip.big}</div>
        <div style={{ ...TYPE.chipSub, color: chip.subColor, marginTop: 3 }}>{chip.sub}</div>
      </div>
    </div>
  );
}

// ---- Wellness headline ------------------------------------------------------
function Headline({ metrics, T }) {
  const w = metrics["Wellness"];
  if (!w) return null;
  const ent = entriesOf(w);
  if (!ent.length) return null;
  const latest = ent[ent.length - 1][1];
  const base = ent.slice(-(w.baseline_days || 42) - 1, -1).map(([, v]) => v);
  const baseMean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : null;
  const delta = baseMean == null ? null : latest - baseMean;
  const arrow = delta == null ? "" : delta > 0.5 ? "▲" : delta < -0.5 ? "▼" : "→";
  const dColor = delta == null ? T.dim : delta > 0.5 ? GOOD : delta < -0.5 ? BAD : T.dim;
  const [r, g, b] = T.colors["Wellness"];
  const band = latest >= 75 ? "strong" : latest >= 55 ? "steady" : latest >= 40 ? "low" : "depleted";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 15 }}>
      <div style={{ width: 58, height: 58, borderRadius: 14, flex: "none",
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    background: `rgba(${r},${g},${b},0.14)`, border: `1px solid rgba(${r},${g},${b},0.4)` }}>
        <div style={{ ...TYPE.scoreNum, color: `rgb(${r},${g},${b})` }}>{latest}</div>
        <div style={{ ...TYPE.micro, color: T.dim, marginTop: 3 }}>/ 100</div>
      </div>
      <div>
        <div style={{ ...TYPE.eyebrow, color: T.dim }}>Daily Wellness</div>
        <div style={{ ...TYPE.caption, color: T.name, marginTop: 4, textTransform: "capitalize" }}>
          {band}
          <span style={{ ...TYPE.chipSub, color: dColor, marginLeft: 8, textTransform: "none" }}>
            {arrow} {delta == null ? "" : Math.abs(Math.round(delta))} vs your norm
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- settings panel (metric picker + theme) ---------------------------------
function SettingsPanel({ metrics, hidden, theme, dispatch, T }) {
  const Check = ({ name }) => {
    const on = !hidden[name];
    const has = metrics[name] && metrics[name].values && Object.keys(metrics[name].values).length;
    const [r, g, b] = T.colors[name] || [148, 163, 184];
    return (
      <div onClick={() => dispatch({ type: "toggleMetric", name })}
        style={{ display: "flex", alignItems: "center", gap: 7, cursor: has ? "pointer" : "default",
                 padding: "4px 6px", borderRadius: 6, opacity: has ? 1 : 0.4, width: 132 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, flex: "none",
                       border: `1px solid ${on ? `rgb(${r},${g},${b})` : T.faint}`,
                       background: on ? `rgba(${r},${g},${b},0.9)` : "transparent",
                       display: "flex", alignItems: "center", justifyContent: "center",
                       fontSize: 9, color: theme === "light" ? "#fff" : "#0b0d12" }}>
          {on ? "✓" : ""}
        </span>
        <span style={{ ...TYPE.caption, color: T.name }}>{name}</span>
      </div>
    );
  };
  return (
    <div style={{ margin: "0 0 13px", padding: "11px 12px", background: T.panelBg,
                  border: `1px solid ${T.panelBorder}`, borderRadius: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
        <div style={{ ...TYPE.eyebrow, color: T.dim }}>Appearance</div>
        <div onClick={() => dispatch({ type: "toggleTheme" })}
          style={{ ...TYPE.caption, cursor: "pointer", color: T.name, display: "flex", alignItems: "center",
                   gap: 6, padding: "3px 9px", borderRadius: 6, border: `1px solid ${T.panelBorder}` }}>
          {theme === "light" ? "☀︎ Light" : "☾ Dark"}<span style={{ color: T.faint }}>· switch</span>
        </div>
      </div>
      <div style={{ ...TYPE.eyebrow, color: T.dim, margin: "6px 0 7px" }}>Show metrics</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        {ORDER.map((n) => <Check key={n} name={n} />)}
      </div>
    </div>
  );
}

// ---- root render ------------------------------------------------------------
export const render = (state, dispatch) => {
  const output = state.output;
  const selected = state.selected;
  const settingsOpen = !!state.settingsOpen;
  const theme = state.theme === "light" ? "light" : "dark";
  const hidden = state.hidden || {};
  const T = themeVars(theme);

  let data = { metrics: {}, updated: null };
  try { data = JSON.parse(output || "{}"); } catch (e) { data = { metrics: {}, updated: null }; }
  const metrics = data.metrics || {};
  const grid = buildGridDates();

  const has = (n) => metrics[n] && metrics[n].values && Object.keys(metrics[n].values).length;
  const shown = ORDER.filter((n) => has(n) && !hidden[n]);
  const anyData = ORDER.some(has);
  const wellnessShown = shown.indexOf("Wellness") !== -1;

  const cardW = LABEL_W + grid.cols * (CELL + GAP) + CHIP_W + 16;
  const innerW = cardW - 36;
  const card = {
    fontFamily: UI_FONT, fontFeatureSettings: '"tnum" 1', color: T.fg,
    background: T.cardBg, backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
    border: `1px solid ${T.cardBorder}`, borderRadius: 16,
    padding: "16px 18px 14px", boxShadow: T.shadow, width: cardW,
  };

  const gear = (
    <div onClick={() => dispatch({ type: "toggleSettings" })}
      style={{ cursor: "pointer", fontSize: 13, color: settingsOpen ? T.name : T.dim,
               padding: "0 2px", userSelect: "none" }} title="settings">⚙</div>
  );

  if (!anyData) {
    return (
      <div style={card}>
        <div style={{ ...TYPE.caption, color: T.name }}>
          No data yet — run <span style={{ fontFamily: MONO }}>garmin_fetch.py</span> to populate the heatmaps.
        </div>
      </div>
    );
  }

  const updated = data.updated
    ? new Date(data.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 13 }}>
        <div style={{ ...TYPE.eyebrow, color: T.dim }}>Performance</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {updated && <div style={{ ...TYPE.micro, color: T.dim }}>updated {updated}</div>}
          {gear}
        </div>
      </div>

      {settingsOpen && (
        <SettingsPanel metrics={metrics} hidden={hidden} theme={theme} dispatch={dispatch} T={T} />
      )}

      {wellnessShown && <Headline metrics={metrics} T={T} />}
      <MonthStrip start={grid.start} cols={grid.cols} T={T} />
      {shown.map((name) => (
        <div key={name}>
          <Row name={name} metric={metrics[name]} grid={grid} dispatch={dispatch} selected={selected} T={T} />
          {selected === name && <DetailPanel name={name} metrics={metrics} T={T} innerW={innerW} />}
        </div>
      ))}
    </div>
  );
};
