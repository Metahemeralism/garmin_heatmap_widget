#!/usr/bin/env python3
"""
garmin_fetch.py
Pulls daily physical-performance metrics from Garmin Connect and writes a single
JSON file that the Ubersicht widget renders as GitHub-style heatmaps.

Runs incrementally: it reads the existing JSON and only fetches dates it is
missing, so the daily background run only pulls the last day or two.

Setup (one time):
    python3 -m venv ~/.garmin_heatmap/venv
    source ~/.garmin_heatmap/venv/bin/activate
    pip install garminconnect curl_cffi ua-generator

    export GARMIN_EMAIL="you@example.com"
    export GARMIN_PASSWORD="your-password"
    python3 garmin_fetch.py          # first run: may prompt once for your MFA code

After the first successful login, tokens are cached in ~/.garmin_heatmap/tokens
and later runs resume silently (no password / MFA needed) until they expire.
"""

import os
import sys
import json
import datetime as dt
from pathlib import Path

# ----------------------------------------------------------------------------
# CONFIG  -- edit these
# ----------------------------------------------------------------------------
DAYS_BACK = 365          # how much history to keep in the file
DATA_DIR  = Path.home() / ".garmin_heatmap"
TOKEN_DIR = DATA_DIR / "tokens"
OUT_FILE  = DATA_DIR / "data.json"

# Toggle metrics on/off here. "direction" tells the widget which end is "good":
#   high -> larger value is greener   (sleep, body battery, HRV, steps, readiness)
#   low  -> smaller value is greener  (resting HR, stress)
# "group": "primary" shows in the main view; "secondary" hides under the widget's
#   "more" toggle (HRV / Resting HR / Readiness — still collected, just tucked away).
METRICS = {
    "Sleep":         {"enabled": True,  "direction": "high", "unit": "",    "group": "primary"},
    "Body Battery":  {"enabled": True,  "direction": "high", "unit": "",    "group": "primary"},
    "Stress":        {"enabled": True,  "direction": "low",  "unit": "",    "group": "primary"},
    "Steps":         {"enabled": True,  "direction": "high", "unit": "",    "group": "primary"},
    "Exercise":      {"enabled": True,  "direction": "high", "unit": "/wk", "group": "primary"},
    "HRV":           {"enabled": True,  "direction": "high", "unit": "ms",  "group": "secondary"},
    "Resting HR":    {"enabled": True,  "direction": "low",  "unit": "bpm", "group": "secondary"},
    "Readiness":     {"enabled": True,  "direction": "high", "unit": "",    "group": "secondary"},
}

# Weighted intensity minutes (moderate + 2*vigorous) at/above which a day with no
# logged activity still counts as one inferred exercise session.
INFER_DOSE = 20.0

# --- Daily Wellness Score -----------------------------------------------------
# A single evidence-based 0-100 number per day. Each sub-metric is normalized
# against YOUR OWN trailing baseline (personal z-score), so "good" means "good
# for you", then squashed to 0-100 via a logistic and combined with the weights
# below. Recovery signals (sleep + body battery + calm) carry ~75% of the weight,
# mirroring validated readiness models (Garmin Training Readiness, Oura, WHOOP)
# while staying fully transparent and tunable.
WELLNESS = {
    "baseline_days": 42,       # trailing window for the personal mean/SD (~6 weeks)
    "min_baseline":  14,       # need at least this many prior points to score a metric
    "min_coverage":  0.50,     # skip a day's score unless >=50% of the weight is present
                               #   (stops garbage scores on partial current days before
                               #    sleep / body battery have synced)
    "dose_target":   21.0,     # weighted intensity min/day for full exercise credit (150/wk WHO)
    # weight, and how each sub-metric maps to "better":
    #   "z"    -> personal z-score, higher raw value is better
    #   "z_inv"-> personal z-score, LOWER raw value is better (stress)
    #   "dose" -> bounded positive: rest days are neutral (~50), never penalized
    "components": {
        "Sleep":        {"weight": 0.30, "mode": "z"},
        "Body Battery": {"weight": 0.25, "mode": "z"},
        "Stress":       {"weight": 0.20, "mode": "z_inv"},
        "Steps":        {"weight": 0.10, "mode": "z"},
        "Exercise":     {"weight": 0.15, "mode": "dose"},  # uses intensity minutes, not the count
    },
}
# ----------------------------------------------------------------------------


def log(*a):
    print("[garmin_fetch]", *a, file=sys.stderr)


def connect():
    """Log in, resuming from cached tokens when possible.

    In the installed garminconnect API, a single ``login(tokenstore)`` call does
    the right thing for both cases:
      * if valid token files exist in ``tokenstore`` it resumes silently;
      * otherwise it performs a full credential login and *automatically writes*
        the tokens back to ``tokenstore`` (via the client's internal ``dump``).
    So we pass the credentials up front and let one call cover both paths, rather
    than the old two-step dance that relied on ``g.garth.dump`` / ``g.dump_tokens``
    (neither of which exists in this version — which is why tokens were never
    being saved and every run re-authenticated).
    """
    from garminconnect import Garmin

    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    tokenstore = str(TOKEN_DIR)

    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")

    # Interactive MFA callback: only invoked when Garmin actually demands a code
    # (first login on a 2FA-enabled account). With cached tokens present it is
    # never called, so scheduled/unattended runs never block on input().
    def prompt_mfa():
        return input("Garmin MFA code: ").strip()

    # Credentials may be absent on resume-only runs; that's fine as long as
    # valid tokens exist. If neither tokens nor credentials work, login() raises.
    g = Garmin(
        email=email or None,
        password=password or None,
        prompt_mfa=prompt_mfa,
    )

    # This version persists a single JSON token file; detect any *.json so the
    # check stays correct regardless of the exact filename the library uses.
    def _has_tokens():
        return any(TOKEN_DIR.glob("*token*.json")) or any(TOKEN_DIR.glob("*.json"))

    had_tokens = _has_tokens()
    try:
        g.login(tokenstore)   # resume if cached, else full login + auto-save tokens
    except Exception as e:
        log(f"ERROR: login failed ({type(e).__name__}): {e}")
        if not (email and password):
            log("no cached tokens and no GARMIN_EMAIL/GARMIN_PASSWORD set")
        sys.exit(1)

    saved = _has_tokens()
    log("resumed session from cached tokens" if had_tokens
        else f"logged in; tokens {'saved' if saved else 'NOT saved'} to {tokenstore}")
    return g


# --- extractors: each takes the raw Garmin payloads for one day, returns a
#     number or None. Wrapped so a missing metric never crashes the run. -------

def _safe(fn):
    try:
        v = fn()
        return None if v in (None, "", 0) and fn.__name__ != "steps" else v
    except Exception:
        return None


def fetch_day(g, date_str):
    """Return {metric_name: value_or_None} for one YYYY-MM-DD date."""
    out = {}
    need = {k for k, v in METRICS.items() if v["enabled"]}

    # Pull the daily summary once (covers steps, resting HR, stress, body battery).
    stats = {}
    if need & {"Steps", "Resting HR", "Stress", "Body Battery"}:
        try:
            stats = g.get_stats(date_str) or {}
        except Exception:
            stats = {}

    def first(d, *keys):
        for k in keys:
            if isinstance(d, dict) and d.get(k) not in (None, ""):
                return d[k]
        return None

    if "Steps" in need:
        out["Steps"] = first(stats, "totalSteps", "steps")
    if "Resting HR" in need:
        out["Resting HR"] = first(stats, "restingHeartRate")
    if "Stress" in need:
        # Garmin returns -1 (sometimes -2) as a "no valid reading" sentinel; those
        # must become None, not a real low-stress day (which would wrongly light up
        # a "low is better" cell as the calmest day ever).
        s = first(stats, "averageStressLevel", "avgStressLevel")
        out["Stress"] = s if (isinstance(s, (int, float)) and s >= 0) else None
    if "Body Battery" in need:
        out["Body Battery"] = first(
            stats, "bodyBatteryHighestValue", "bodyBatteryMostRecentValue",
            "bodyBatteryChargedValue"
        )

    if "Sleep" in need:
        try:
            sd = g.get_sleep_data(date_str) or {}
            scores = (sd.get("dailySleepDTO") or {}).get("sleepScores") or {}
            out["Sleep"] = (scores.get("overall") or {}).get("value")
        except Exception:
            out["Sleep"] = None

    if "HRV" in need:
        try:
            hd = g.get_hrv_data(date_str) or {}
            summary = hd.get("hrvSummary") or {}
            out["HRV"] = first(summary, "lastNightAvg", "weeklyAvg")
        except Exception:
            out["HRV"] = None

    if "Readiness" in need:
        try:
            tr = g.get_training_readiness(date_str) or []
            if isinstance(tr, list) and tr:
                out["Readiness"] = (tr[0] or {}).get("score")
            elif isinstance(tr, dict):
                out["Readiness"] = tr.get("score")
        except Exception:
            out["Readiness"] = None

    if "Exercise" in need:
        # Two sources, matching "logged OR inferred":
        #   count  = number of activities you explicitly recorded that day
        #   dose   = Garmin's intensity minutes (moderate + 2*vigorous, WHO weighting)
        #            which it infers from HR/motion even with no logged activity.
        count, dose = 0, 0.0
        try:
            acts = g.get_activities_by_date(date_str, date_str)
            if isinstance(acts, list):
                count = len(acts)
        except Exception:
            pass
        try:
            im = g.get_intensity_minutes_data(date_str) or {}
            mod = im.get("moderateMinutes") or 0
            vig = im.get("vigorousMinutes") or 0
            dose = float(mod) + 2.0 * float(vig)
        except Exception:
            pass
        # No logged activity but Garmin still saw a real dose -> an inferred session.
        if count == 0 and dose >= INFER_DOSE:
            count = 1
        out["Exercise"] = count
        out["_intensity"] = dose   # not displayed; feeds the wellness "dose" sub-score

    return out


def load_existing():
    if OUT_FILE.exists():
        try:
            return json.loads(OUT_FILE.read_text())
        except Exception:
            pass
    return {"updated": None, "metrics": {}}


def _logistic(z):
    """Squash a z-score to 0-100. z=0 -> 50, z=+1 -> ~73, z=-1 -> ~27.
    Clamped to avoid overflow on extreme days."""
    import math
    return 100.0 / (1.0 + math.exp(-max(-6.0, min(6.0, z))))


def compute_wellness(metrics, all_dates):
    """Derive the 0-100 Daily Wellness Score for each date from already-stored
    values, using a trailing PERSONAL baseline per component (z-score vs your own
    recent norm), then a weighted mean. Also stores each day's component sub-scores
    and the weight table so the widget can show 'why' on drill-down.

    Deterministic and reproducible: identical inputs always give the identical
    score (which is exactly why this is arithmetic, not an LLM)."""
    import statistics as st
    cfg, comps = WELLNESS, WELLNESS["components"]

    W = metrics.setdefault("Wellness", {})
    W.update({"direction": "high", "unit": "", "group": "score",
              "weights": {k: v["weight"] for k, v in comps.items()},
              "baseline_days": cfg["baseline_days"]})

    # date->value series for each component ("Exercise" uses its intensity dose).
    series = {}
    for name in comps:
        if name == "Exercise":
            series[name] = (metrics.get("Exercise") or {}).get("intensity", {})
        else:
            series[name] = (metrics.get(name) or {}).get("values", {})

    values, components = {}, {}
    for d in all_dates:
        subs, wts = {}, {}
        for name, c in comps.items():
            s = series.get(name, {})
            v = s.get(d)
            if v is None:
                continue
            if c["mode"] == "dose":
                # Bounded & positive: a rest day is neutral (50), never penalized;
                # hitting the daily dose target earns full credit (100).
                sub = min(100.0, 50.0 + 50.0 * (float(v) / cfg["dose_target"]))
            else:
                # Trailing baseline: the `baseline_days` before d, excluding d
                # itself so today never contaminates its own norm (no leakage).
                lo = (dt.date.fromisoformat(d)
                      - dt.timedelta(days=cfg["baseline_days"])).isoformat()
                hist = [float(s[k]) for k in s if lo <= k < d]
                if len(hist) < cfg["min_baseline"]:
                    continue  # not enough personal history yet to judge this metric
                mu = st.fmean(hist)
                sd = st.pstdev(hist) or 1e-6   # guard divide-by-zero on flat series
                z = (float(v) - mu) / sd
                if c["mode"] == "z_inv":       # lower-is-better (stress): flip sign
                    z = -z
                sub = _logistic(z)
            subs[name] = round(sub, 1)
            wts[name] = c["weight"]
        tot = sum(wts.values())
        if subs and tot >= cfg["min_coverage"]:
            # Renormalize over whatever components were present so a missing metric
            # doesn't drag the score toward zero.
            values[d] = round(sum(subs[n] * wts[n] for n in subs) / tot)
            components[d] = subs

    W["values"] = values
    W["components"] = components


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data = load_existing()
    metrics = data.get("metrics", {})

    # Ensure a container exists for every enabled metric.
    for name, cfg in METRICS.items():
        if not cfg["enabled"]:
            continue
        metrics.setdefault(name, {"direction": cfg["direction"],
                                  "unit": cfg["unit"], "values": {}})
        metrics[name]["direction"] = cfg["direction"]
        metrics[name]["unit"] = cfg["unit"]
        metrics[name]["group"] = cfg["group"]
    # Exercise keeps a parallel daily-dose series (intensity minutes) for the score.
    if METRICS.get("Exercise", {}).get("enabled"):
        metrics["Exercise"].setdefault("intensity", {})

    today = dt.date.today()
    start = today - dt.timedelta(days=DAYS_BACK - 1)

    # Which dates are missing for at least one enabled metric?
    all_dates = [(start + dt.timedelta(days=i)).isoformat()
                 for i in range((today - start).days + 1)]
    enabled = [k for k, v in METRICS.items() if v["enabled"]]
    missing = [d for d in all_dates
               if any(d not in metrics[m]["values"] for m in enabled)]

    if not missing:
        log("nothing to fetch; file already current")
    else:
        log(f"fetching {len(missing)} day(s)...")
        g = connect()
        for i, d in enumerate(missing, 1):
            day = fetch_day(g, d)
            for m in enabled:
                v = day.get(m)
                if v is not None:
                    metrics[m]["values"][d] = v
            # Stash the exercise dose (intensity minutes) alongside the count.
            if "Exercise" in enabled and day.get("_intensity") is not None:
                metrics["Exercise"]["intensity"][d] = day["_intensity"]
            if i % 20 == 0:
                log(f"  {i}/{len(missing)}")

    # Trim every date-keyed sub-series to the retention window.
    cutoff = start.isoformat()
    for m in metrics.values():
        for key in ("values", "intensity", "components"):
            if isinstance(m.get(key), dict):
                m[key] = {k: v for k, v in m[key].items() if k >= cutoff}

    # Strip sentinel/garbage negatives left in the file by earlier runs (Garmin's
    # -1 "no data" for stress). None of these metrics is ever legitimately < 0, and
    # a fresh None won't overwrite a previously stored -1, so clean them here so
    # they don't skew coloring or the wellness score.
    for m in metrics.values():
        if isinstance(m.get("values"), dict):
            m["values"] = {k: v for k, v in m["values"].items()
                           if not (isinstance(v, (int, float)) and v < 0)}

    # Derive the Daily Wellness Score from the (now current, cleaned) stored series.
    compute_wellness(metrics, all_dates)

    data["metrics"] = metrics
    data["updated"] = dt.datetime.now().isoformat(timespec="seconds")
    OUT_FILE.write_text(json.dumps(data))
    log(f"wrote {OUT_FILE}")


if __name__ == "__main__":
    main()
