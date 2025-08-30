import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ type: "*/*" })); // PB sends application/json

// --- Config ---
const PB_BASE = "https://api.productboard.com";
const PB_TOKEN = process.env.PRODUCTBOARD_API_TOKEN;
const WEBHOOK_AUTH = process.env.PB_WEBHOOK_AUTH; // PB will send this in Authorization
const RG_IDS = {
  weekly: process.env.RELEASE_GROUP_WEEKLY_ID,
  monthly: process.env.RELEASE_GROUP_MONTHLY_ID,
  quarterly: process.env.RELEASE_GROUP_QUARTERLY_ID,
};

const COMMON_HEADERS = {
  Authorization: `Bearer ${PB_TOKEN}`,
  "X-Version": "1",
  Accept: "application/json",
  "Content-Type": "application/json",
};

// --- Logging (quick-skim friendly) ---
const log = {
  info: (...a) => console.log("🟢", ...a),
  link: (...a) => console.log("🔗", ...a),
  warn: (...a) => console.warn("❗", ...a),
  err:  (...a) => console.error("❌", ...a),
};
const DEBUG = process.env.PB_DEBUG === "1";
const dbg = (...a) => DEBUG && console.log("🐞", ...a);

// --- Helpers ---
const parseIsoDate = (s) => (s ? new Date(s) : undefined);

/** UTC helpers (we normalize to UTC and compare by date-only, so no TZ drift) */
function startOfDayUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return dt;
}
function endOfDayUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  return dt;
}
function atUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}
function addDays(d, days) {
  const dt = new Date(d.getTime());
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt;
}
function addMonths(d, months) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  return dt;
}
function isoString(dt) {
  return dt.toISOString(); // PB accepts ISO8601
}
function monthLong(dt) {
  return dt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}
function monthShort(dt) {
  return dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

/** Date-only (UTC) helpers for day-granular comparisons */
function toYMDUTC(x) {
  const d = (x instanceof Date) ? x : new Date(x);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
/** Closed interval on day granularity: start_ymd <= d_ymd <= end_ymd */
function isWithinClosedDay(d, start, end) {
  if (!start || !end) return false;
  const dy = toYMDUTC(d);
  const sy = toYMDUTC(start);
  const ey = toYMDUTC(end);
  return sy <= dy && dy <= ey;
}

/** Create a PB release in a group */
async function createRelease({ name, groupId, start, end }) {
  const r = await fetch(`${PB_BASE}/releases`, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify({
      data: {
        name,
        releaseGroup: { id: groupId },
        timeframe: { start: isoString(start), end: isoString(end) }
      }
    })
  });
  if (!r.ok) throw new Error(`POST /releases -> ${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

/** Returns true if a release with the exact same [start,end] exists in the group */
function releaseWithTimeframeExists(existingReleases, start, end) {
  const s = toYMDUTC(start);
  const e = toYMDUTC(end);
  return existingReleases.some(r => toYMDUTC(r.timeframe?.start) === s && toYMDUTC(r.timeframe?.end) === e);
}

/** Seed Monthly periods from start to end (inclusive by day) */
function buildMonthlyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // iterate months starting from the 1st of rangeStart.month
  let cursor = atUTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), 1);
  const last = atUTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), 1);
  while (cursor <= last) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const start = startOfDayUTC(atUTC(y, m, 1));
    const nextMonth = addMonths(cursor, 1);
    const end = startOfDayUTC(addDays(nextMonth, -1));
    const name = `${monthLong(start)} ${y}`;
    periods.push({ name, start, end });
    cursor = nextMonth;
  }
  return periods;
}

/** Seed Weekly periods (Mon–Sun) from rangeStart to rangeEnd */
function buildWeeklyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // find Monday on or before rangeStart
  const day = rangeStart.getUTCDay(); // 0=Sun,...6=Sat
  const deltaToMonday = (day === 0 ? -6 : 1 - day);
  let monday = startOfDayUTC(addDays(rangeStart, deltaToMonday));
  const endBoundary = endOfDayUTC(rangeEnd);

  while (monday <= endBoundary) {
    const sunday = startOfDayUTC(addDays(monday, 6));
    const monthIdxMonday = monday.getUTCMonth();
    // week number within the month (count Mondays)
    const firstOfMonth = atUTC(monday.getUTCFullYear(), monthIdxMonday, 1);
    const firstMonthDay = firstOfMonth.getUTCDay();
    const firstMondayDelta = (firstMonthDay === 0 ? 1 : (firstMonthDay <= 1 ? 0 : 8 - firstMonthDay));
    const firstMonday = startOfDayUTC(addDays(firstOfMonth, firstMondayDelta));
    const weekNum = Math.floor((monday - firstMonday) / (7 * 24 * 3600 * 1000)) + 1;
    const name = `${monthShort(monday)} week ${weekNum} ${monday.getUTCFullYear()}`;
    periods.push({ name, start: monday, end: sunday });
    monday = startOfDayUTC(addDays(monday, 7));
  }
  return periods;
}

/** Seed Quarterly periods; allow custom anchor month via ENV (1-12). Default Jan. */
function buildQuarterlyPeriods(rangeStart, rangeEnd, anchorMonth1to12) {
  const anchor = Math.max(1, Math.min(12, Number(anchorMonth1to12) || 1)) - 1; // 0-11
  // find the quarter start on or before rangeStart
  function quarterStartFor(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const offset = (12 + (m - anchor)) % 3; // months since last quarter start
    const qStartMonth = m - offset;
    const qYear = y + Math.floor((qStartMonth) / 12);
    const qMonth = (qStartMonth + 12) % 12;
    return atUTC(qYear, qMonth, 1);
  }
  function nextQuarterStart(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const next = atUTC(y, m + 3, 1);
    return next;
  }
  const periods = [];
  let qStart = quarterStartFor(rangeStart);
  const boundary = atUTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), 1);
  while (qStart <= boundary) {
    const qEnd = startOfDayUTC(addDays(nextQuarterStart(qStart), -1));
    // quarter index relative to anchor
    const totalMonths = (qStart.getUTCFullYear() - atUTC(0,0,1).getUTCFullYear()) * 12 + (qStart.getUTCMonth() - 0);
    const posWithinYear = (12 + (qStart.getUTCMonth() - anchor)) % 12;
    const qIndex = Math.floor(posWithinYear / 3) + 1; // 1..4
    const name = `Q${qIndex} ${qStart.getUTCFullYear()}`;
    periods.push({ name, start: qStart, end: qEnd });
    qStart = nextQuarterStart(qStart);
  }
  return periods;
}

/** Ensure seed for a group, creating missing [start,end] periods only */
async function ensureSeedForGroup(groupId, periods, existingReleases, createdAccumulator) {
  for (const p of periods) {
    if (releaseWithTimeframeExists(existingReleases, p.start, p.end)) {
      log.info(`♻️  Exists: ${p.name} (${p.start.toISOString()} – ${p.end.toISOString()})`);
      continue;
    }
    const created = await createRelease({ name: p.name, groupId, start: p.start, end: p.end });
    createdAccumulator.push(created);
    log.info(`✅ Created: ${created.name} → [${created.timeframe.start} … ${created.timeframe.end}]`);
  }
}

/** Ensure exactly one assignment within a group based on feature.timeframe.end (day-only semantics) */
async function upsertAssignmentForGroup(feature, groupLabel, cache) {
  const featureEnd = parseIsoDate(feature.timeframe?.end);
  if (!featureEnd) {
    log.warn(`🎯 ${groupLabel}: feature has no timeframe.end; skipping assignment`);
    return;
  }

  const groupId = RG_IDS[groupLabel];
  if (!groupId) throw new Error(`Missing ENV for ${groupLabel} release group`);

  let releases = cache[groupId];
  if (!releases) {
    releases = await listReleasesForGroup(groupId);
    cache[groupId] = releases;
  }

  const target = releases.find(r =>
    isWithinClosedDay(featureEnd, r.timeframe?.start, r.timeframe?.end)
  );

  if (!target) {
    log.warn(`🎯 ${groupLabel}: no matching release for end=${feature.timeframe?.end}`);
    return;
  }

  await setFeatureAssignment(feature.id, target.id, true);
  log.info(`✅ Assigned to ${groupLabel} → ${target.name} (${target.id})`);

  for (const rls of releases.filter(r => r.id !== target.id)) {
    try {
      await setFeatureAssignment(feature.id, rls.id, false);
    } catch (e) {
      log.warn(`🧹 Unassign ${groupLabel}/${rls.name} skipped: ${e.message}`);
    }
  }
}

async function getFeature(id) {
  const r = await fetch(`${PB_BASE}/features/${id}`, { headers: COMMON_HEADERS });
  if (!r.ok) throw new Error(`GET /features/${id} -> ${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

async function listReleasesForGroup(groupId) {
  const out = [];
  let next = `${PB_BASE}/releases?releaseGroup.id=${groupId}`;
  while (next) {
    const r = await fetch(next, { headers: COMMON_HEADERS });
    if (!r.ok) throw new Error(`GET /releases -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...(j.data ?? []));
    next = j.links?.next;
  }
  return out;
}

/** Assign or unassign a feature to a release (idempotent) */
async function setFeatureAssignment(featureId, releaseId, assigned) {
  const url = `${PB_BASE}/feature-release-assignments/assignment?release.id=${releaseId}&feature.id=${featureId}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: COMMON_HEADERS,
    body: JSON.stringify({ data: { assigned } }),
  });
  if (!r.ok) throw new Error(`PUT /feature-release-assignments -> ${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

// --- Webhook receiver ---
app.post("/pb-webhook", async (req, res) => {
  const t0 = Date.now();
  try {
    // 1) Auth check (PB sends exactly the value you configured)
    const auth = req.get("authorization") || "";
    if (auth !== `Bearer ${WEBHOOK_AUTH}`) {
      log.warn("Unauthorized webhook call", { got: auth ? auth.slice(0, 12) + "…" : "<empty>" });
      return res.status(401).send("unauthorized");
    }

    // 2) Basic intake logs (size + top-level fields)
    const body = req.body || {};
    const size = Number(req.get("content-length") || 0);
    dbg("📥 Webhook received", { size, keys: Object.keys(body) });

    // 3) Event & entity extraction (covering multiple payload shapes)
    const eventType = body?.data?.type || body?.type;
    const featureId =
      body?.data?.attributes?.entity?.feature?.id ||
      body?.data?.attributes?.entity?.id ||
      body?.data?.entity?.id ||
      body?.entity?.id;

    log.info(`📬 PB Webhook: type=${eventType ?? "<?>"} featureId=${featureId ?? "<?>"} size=${size}B`);

    // 4) Sanity: is it a feature change event?
    if (!eventType) {
      log.warn("No event type in payload, ignoring");
      return res.status(204).send("no event type");
    }
    if (!["feature.updated", "feature.created"].includes(eventType)) {
      dbg("Ignoring non-feature event", { eventType });
      return res.status(204).send("ignored event");
    }

    // 5) Need a feature id
    if (!featureId) {
      log.warn("No feature id in webhook payload", { snippet: JSON.stringify(body).slice(0, 400) });
      return res.status(400).send("bad payload (no feature id)");
    }

    // 6) Fetch latest feature (thin payloads)
    const feature = await getFeature(featureId);
    log.link(`🔗 Feature: ${feature.links?.html ?? feature.links?.self ?? feature.id}`);

    // 7) Assign within each group (day-only, closed interval)
    const cache = {};
    await upsertAssignmentForGroup(feature, "weekly", cache);
    await upsertAssignmentForGroup(feature, "monthly", cache);
    await upsertAssignmentForGroup(feature, "quarterly", cache);

    const dt = Date.now() - t0;
    log.info(`✅ Done in ${dt} ms`);
    return res.status(200).send("ok");
  } catch (err) {
    const dt = Date.now() - t0;
    log.err("Handler error:", err?.message, `(${dt} ms)`);
    return res.status(500).send("internal");
  }
});

/**
 * Admin: seed weekly, monthly, and quarterly releases one year ahead from "today".
 * - Uses inclusive day bounds (closed intervals).
 * - Skips creation if a release with identical [start,end] already exists in the group.
 * - Quarterly anchor month can be overridden via env QUARTER_START_MONTH (1-12). Default Jan (1).
 * - Stores timeframe at 00:00:00Z for both start and end (day-only canonical form).
 */
app.post("/admin/seed-releases", async (req, res) => {
  try {
    const now = new Date();
    const rangeStart = startOfDayUTC(now);
    const rangeEnd = endOfDayUTC(addDays(atUTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()), 0));

    const anchorMonthEnv = process.env.QUARTER_START_MONTH || "1"; // e.g., set to "8" to match Aug–Oct pattern

    // Fetch once per group
    const [weeklyReleases, monthlyReleases, quarterlyReleases] = await Promise.all([
      listReleasesForGroup(RG_IDS.weekly),
      listReleasesForGroup(RG_IDS.monthly),
      listReleasesForGroup(RG_IDS.quarterly),
    ]);

    const created = [];

    // Build periods
    const weekly = buildWeeklyPeriods(rangeStart, rangeEnd);
    const monthly = buildMonthlyPeriods(rangeStart, rangeEnd);
    const quarterly = buildQuarterlyPeriods(rangeStart, rangeEnd, anchorMonthEnv);

    await ensureSeedForGroup(RG_IDS.weekly, weekly, weeklyReleases, created);
    await ensureSeedForGroup(RG_IDS.monthly, monthly, monthlyReleases, created);
    await ensureSeedForGroup(RG_IDS.quarterly, quarterly, quarterlyReleases, created);

    res.status(200).json({
      rangeStart: isoString(rangeStart),
      rangeEnd: isoString(rangeEnd),
      createdCount: created.length,
      createdNames: created.map(c => c.name),
    });
  } catch (e) {
    log.err("Seeder failed:", e?.message);
    res.status(500).send("failed");
  }
});

// Bootstrap
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log.info(`🟢 Listening on :${PORT}`));