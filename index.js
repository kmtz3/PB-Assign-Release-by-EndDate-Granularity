import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ type: "*/*" })); // PB sends application/json

// --- Config ---
const PB_BASE = "https://api.productboard.com/v2";
const PB_TOKEN = process.env.PRODUCTBOARD_API_TOKEN;
const WEBHOOK_AUTH = process.env.PB_WEBHOOK_AUTH; // PB will send this in Authorization
const RG_IDS = {
  weekly: process.env.RELEASE_GROUP_WEEKLY_ID,
  monthly: process.env.RELEASE_GROUP_MONTHLY_ID,
  quarterly: process.env.RELEASE_GROUP_QUARTERLY_ID,
  yearly: process.env.RELEASE_GROUP_YEARLY_ID,
};

const COMMON_HEADERS = {
  Authorization: `Bearer ${PB_TOKEN}`,
  "X-Version": "2",
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

/** Returns true if a release with the exact same [start,end] exists in the group */
function releaseWithTimeframeExists(existingReleases, start, end) {
  const s = toYMDUTC(start);
  const e = toYMDUTC(end);
  return existingReleases.some(r =>
    toYMDUTC(r.timeframe?.startDate || r.timeframe?.start) === s &&
    toYMDUTC(r.timeframe?.endDate || r.timeframe?.end) === e
  );
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

/** Seed Yearly periods from start to end (inclusive by day) */
function buildYearlyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // Start from the beginning of the year containing rangeStart
  let year = rangeStart.getUTCFullYear();
  const lastYear = rangeEnd.getUTCFullYear();

  while (year <= lastYear) {
    const start = startOfDayUTC(atUTC(year, 0, 1)); // Jan 1
    const end = startOfDayUTC(atUTC(year, 11, 31)); // Dec 31
    const name = `${year}`;
    periods.push({ name, start, end });
    year++;
  }
  return periods;
}

/** Ensure seed for a group, creating missing [start,end] periods only */
async function ensureSeedForGroup(groupId, periods, existingReleases, createdAccumulator, granularity) {
  for (const p of periods) {
    if (releaseWithTimeframeExists(existingReleases, p.start, p.end)) {
      log.info(`♻️  Exists: ${p.name} (${p.start.toISOString()} – ${p.end.toISOString()})`);
      continue;
    }
    const created = await createRelease({ name: p.name, groupId, start: p.start, end: p.end, granularity });
    // Ensure name is set even if API doesn't return it
    if (!created.name) created.name = p.name;
    createdAccumulator.push(created);
    const tfStart = created.timeframe?.startDate || isoString(p.start);
    const tfEnd = created.timeframe?.endDate || isoString(p.end);
    log.info(`✅ Created: ${created.name} → [${tfStart} … ${tfEnd}]`);
  }
}

/** Ensure exactly one assignment within a group based on feature.timeframe.end (day-only semantics) */
async function upsertAssignmentForGroup(feature, groupLabel, cache) {
  const featureEnd = parseIsoDate(feature.timeframe?.endDate || feature.timeframe?.end);
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
    isWithinClosedDay(featureEnd, r.timeframe?.startDate || r.timeframe?.start, r.timeframe?.endDate || r.timeframe?.end)
  );

  if (!target) {
    log.warn(`🎯 ${groupLabel}: no matching release for end=${feature.timeframe?.endDate || feature.timeframe?.end}`);
    return;
  }

  await setFeatureAssignment(feature.id, target.id, true, groupId);
  log.info(`✅ Assigned to ${groupLabel} → ${target.name} (${target.id})`);

  for (const rls of releases.filter(r => r.id !== target.id)) {
    try {
      await setFeatureAssignment(feature.id, rls.id, false, groupId);
    } catch (e) {
      log.warn(`🧹 Unassign ${groupLabel}/${rls.name} skipped: ${e.message}`);
    }
  }
}

// --- API Functions ---

/** Get feature by ID */
async function getFeatureV2(id) {
  const r = await fetch(`${PB_BASE}/entities/${id}`, { headers: COMMON_HEADERS });
  if (!r.ok) throw new Error(`GET /entities/${id} -> ${r.status} ${await r.text()}`);
  const data = (await r.json()).data;
  // Flatten fields to top level for convenience
  return {
    id: data.id,
    type: data.type,
    name: data.fields?.name,
    timeframe: data.fields?.timeframe,
    status: data.fields?.status,
    owner: data.fields?.owner,
    links: data.links,
    ...data
  };
}

/** Create a PB release in a group */
async function createReleaseV2({ name, groupId, start, end, granularity }) {
  const r = await fetch(`${PB_BASE}/entities`, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify({
      data: {
        type: "release",
        fields: {
          name,
          description: "",
          timeframe: {
            startDate: isoString(start),
            endDate: isoString(end),
            granularity: granularity || "day"
          }
        },
        relationships: [
          {
            type: "parent",
            target: {
              id: groupId
            }
          }
        ]
      }
    })
  });
  if (!r.ok) throw new Error(`POST /entities -> ${r.status} ${await r.text()}`);
  const created = (await r.json()).data;

  // Flatten fields to top level for convenience
  return {
    ...created,
    name: created.fields?.name,
    timeframe: created.fields?.timeframe
  };
}

/** List all releases in a group */
async function listReleasesForGroupV2(groupId) {
  const out = [];
  let cursor = null;
  do {
    const url = cursor ? `${PB_BASE}/entities/search?cursor=${cursor}` : `${PB_BASE}/entities/search`;
    const r = await fetch(url, {
      method: "POST",
      headers: COMMON_HEADERS,
      body: JSON.stringify({
        data: {
          type: "release",
          parent: { id: groupId }
        }
      })
    });
    if (!r.ok) throw new Error(`POST /entities/search -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    const releases = (j.data ?? []).map(rel => ({
      id: rel.id,
      name: rel.fields?.name,
      timeframe: rel.fields?.timeframe,
      ...rel
    }));
    out.push(...releases);
    cursor = j.pagination?.next;
  } while (cursor);
  return out;
}

/** Assign or unassign a feature to a release */
async function setFeatureAssignmentV2(featureId, releaseId, assigned, groupId) {
  if (assigned) {
    // First, remove any existing release links in this group
    const existingRels = await fetch(`${PB_BASE}/entities/${featureId}/relationships?type=link`, {
      headers: COMMON_HEADERS
    });
    if (existingRels.ok) {
      const rels = (await existingRels.json()).data || [];
      // Get all releases in this group to identify which relationships to remove
      const groupReleases = await listReleasesForGroupV2(groupId);
      const groupReleaseIds = new Set(groupReleases.map(r => r.id));

      for (const rel of rels) {
        if (groupReleaseIds.has(rel.target.id) && rel.target.id !== releaseId) {
          await fetch(`${PB_BASE}/entities/${featureId}/relationships/link/${rel.target.id}`, {
            method: "DELETE",
            headers: COMMON_HEADERS
          });
        }
      }
    }

    // Create new link
    const r = await fetch(`${PB_BASE}/entities/${featureId}/relationships`, {
      method: "POST",
      headers: COMMON_HEADERS,
      body: JSON.stringify({
        data: {
          type: "link",
          target: { id: releaseId }
        }
      })
    });
    if (!r.ok) throw new Error(`POST relationships -> ${r.status} ${await r.text()}`);
    return (await r.json()).data;
  } else {
    // Delete link
    const r = await fetch(`${PB_BASE}/entities/${featureId}/relationships/link/${releaseId}`, {
      method: "DELETE",
      headers: COMMON_HEADERS
    });
    if (!r.ok && r.status !== 404) throw new Error(`DELETE relationship -> ${r.status} ${await r.text()}`);
    return { deleted: true };
  }
}

// --- API Wrapper Functions ---

async function getFeature(id) {
  return getFeatureV2(id);
}

async function createRelease(params) {
  return createReleaseV2(params);
}

async function listReleasesForGroup(groupId) {
  return listReleasesForGroupV2(groupId);
}

async function setFeatureAssignment(featureId, releaseId, assigned, groupId) {
  return setFeatureAssignmentV2(featureId, releaseId, assigned, groupId);
}

// --- Webhook receiver ---
app.post("/pb-webhook", async (req, res) => {
  const t0 = Date.now();
  try {
    // 1) Auth check (PB sends exactly the value you configured)
    const auth = req.get("authorization") || "";
    const expectedAuth = WEBHOOK_AUTH.startsWith("Bearer ") ? WEBHOOK_AUTH : `Bearer ${WEBHOOK_AUTH}`;
    if (auth !== expectedAuth && auth !== WEBHOOK_AUTH) {
      log.warn("Unauthorized webhook call", { got: auth ? auth.slice(0, 12) + "…" : "<empty>" });
      return res.status(401).send("unauthorized");
    }

    // 2) Basic intake logs (size + top-level fields)
    const body = req.body || {};
    const size = Number(req.get("content-length") || 0);
    dbg("📥 Webhook received", { size, keys: Object.keys(body) });

    // 3) Event & entity extraction (covering multiple payload shapes)
    const eventType = body?.data?.eventType || body?.data?.type || body?.type;
    const featureId =
      body?.data?.id ||
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

    // 4b) Prevent feedback loop: only process if timeframe was actually updated
    // When we assign features to releases, it triggers another webhook but without timeframe changes
    const updatedAttributes = body?.data?.updatedAttributes || [];
    if (eventType === "feature.updated" && Array.isArray(updatedAttributes)) {
      // Check if timeframe was actually updated (or if it's a create, always process)
      const isTimeframeUpdate = updatedAttributes.includes("timeframe");
      if (!isTimeframeUpdate) {
        dbg("Ignoring update without timeframe change", { updatedAttributes });
        return res.status(204).send("no timeframe update");
      }
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
    await upsertAssignmentForGroup(feature, "yearly", cache);

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
 * Admin: seed weekly, monthly, quarterly, and yearly releases from "today".
 * - Weekly, monthly, quarterly: 1 year ahead
 * - Yearly: 5 years ahead
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
    const rangeEnd5Years = endOfDayUTC(addDays(atUTC(now.getUTCFullYear() + 5, now.getUTCMonth(), now.getUTCDate()), 0));

    const anchorMonthEnv = process.env.QUARTER_START_MONTH || "1"; // e.g., set to "8" to match Aug–Oct pattern

    // Fetch once per group
    const [weeklyReleases, monthlyReleases, quarterlyReleases, yearlyReleases] = await Promise.all([
      listReleasesForGroup(RG_IDS.weekly),
      listReleasesForGroup(RG_IDS.monthly),
      listReleasesForGroup(RG_IDS.quarterly),
      listReleasesForGroup(RG_IDS.yearly),
    ]);

    const created = [];

    // Build periods
    const weekly = buildWeeklyPeriods(rangeStart, rangeEnd);
    const monthly = buildMonthlyPeriods(rangeStart, rangeEnd);
    const quarterly = buildQuarterlyPeriods(rangeStart, rangeEnd, anchorMonthEnv);
    const yearly = buildYearlyPeriods(rangeStart, rangeEnd5Years);

    await ensureSeedForGroup(RG_IDS.weekly, [...weekly].reverse(), weeklyReleases, created, "day");
    await ensureSeedForGroup(RG_IDS.monthly, [...monthly].reverse(), monthlyReleases, created, "month");
    await ensureSeedForGroup(RG_IDS.quarterly, [...quarterly].reverse(), quarterlyReleases, created, "quarter");
    await ensureSeedForGroup(RG_IDS.yearly, [...yearly].reverse(), yearlyReleases, created, "year");

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