const prisma = require("../config/prismaClient");

function throwHttp(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

// ─── Local-time helpers ───────────────────────────────────────────────────────
// DraftProgressLog.logDate / DaysChallengeCheckIn.checkInDate are already
// stored as the writer's own local calendar date (as midnight UTC of that
// date) — the app computes the date string from the browser's local clock
// before saving, not the server's. So date-column comparisons below don't
// need timezone math. Sprint.startedAt/completedAt, however, are real
// timestamps, so those DO need to be bucketed into the writer's local
// calendar date using User.timezone.

// Returns { dateStr: "YYYY-MM-DD", weekday: 0-6 (0=Sun) } for `at` in `timezone`.
function getLocalDateInfo(timezone, at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(at);
  } catch (e) {
    // Bad/unknown timezone string on the user record — fall back to UTC
    // rather than throwing, since this is called from read paths.
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    }).formatToParts(at);
  }
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    weekday: weekdayMap[map.weekday],
  };
}

// Midnight-UTC Date object for the Monday on/before the given "YYYY-MM-DD".
function mondayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1;
  dt.setUTCDate(dt.getUTCDate() - diff);
  return dt;
}

function addDays(date, days) {
  const dt = new Date(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt;
}

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// ─── Template CRUD (admin) ────────────────────────────────────────────────────

async function listTemplates({ includeInactive = false } = {}) {
  return prisma.miniChallengeTemplate.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: { rotationOrder: "asc" },
  });
}

async function getTemplate(id) {
  return prisma.miniChallengeTemplate.findUnique({ where: { id } });
}

async function createTemplate({ title, description, type, targetValue, badgeName, badgeIcon, rotationOrder }) {
  return prisma.miniChallengeTemplate.create({
    data: { title, description, type, targetValue, badgeName, badgeIcon, rotationOrder },
  });
}

async function updateTemplate(id, { title, description, type, targetValue, badgeName, badgeIcon, rotationOrder, isActive }) {
  const existing = await prisma.miniChallengeTemplate.findUnique({ where: { id } });
  if (!existing) throwHttp(404, "Template not found.");

  return prisma.miniChallengeTemplate.update({
    where: { id },
    data: {
      ...(title         !== undefined && { title }),
      ...(description   !== undefined && { description }),
      ...(type          !== undefined && { type }),
      ...(targetValue   !== undefined && { targetValue }),
      ...(badgeName     !== undefined && { badgeName }),
      ...(badgeIcon     !== undefined && { badgeIcon }),
      ...(rotationOrder !== undefined && { rotationOrder }),
      ...(isActive      !== undefined && { isActive }),
    },
  });
}

// Convenience wrapper for the admin "pause/resume" toggle.
async function setTemplateActive(id, isActive) {
  return updateTemplate(id, { isActive });
}

// ─── Rotation resolver ────────────────────────────────────────────────────────
// Which template is "live" for a given week is locked in the first time
// it's resolved (see MiniChallengeWeekAssignment) — so adding, pausing, or
// enabling a template later can only affect weeks that haven't happened
// yet, never one already in progress. If the assigned template gets paused
// mid-week, we fall back to picking fresh from the currently-active pool
// rather than serving a paused challenge.
async function getLiveTemplate(weekStart) {
  const existing = await prisma.miniChallengeWeekAssignment.findUnique({
    where: { weekStart },
    include: { template: true },
  });
  if (existing && existing.template.isActive) {
    return existing.template;
  }

  const templates = await listTemplates({ includeInactive: false });
  if (!templates.length) return null;
  const weekNum = isoWeekNumber(weekStart);
  const chosen = templates[weekNum % templates.length];

  // Lock it in. Upsert so concurrent requests resolving the same
  // not-yet-assigned week can't race into a duplicate-key error — and so
  // re-resolving after a pause (the `existing` branch above skipped)
  // correctly overwrites the stale assignment.
  await prisma.miniChallengeWeekAssignment.upsert({
    where: { weekStart },
    update: { templateId: chosen.id },
    create: { weekStart, templateId: chosen.id },
  });

  return chosen;
}

// ─── Activity aggregation ─────────────────────────────────────────────────────

async function getUnionActiveDateSet(userId, sinceDate) {
  const [logs, checkIns] = await Promise.all([
    prisma.draftProgressLog.findMany({
      where: { userId, logDate: { gte: sinceDate } },
      select: { logDate: true },
    }),
    prisma.daysChallengeCheckIn.findMany({
      where: { userId, checkInDate: { gte: sinceDate } },
      select: { checkInDate: true },
    }),
  ]);
  const dates = new Set();
  for (const l of logs) dates.add(toDateStr(l.logDate));
  for (const c of checkIns) dates.add(toDateStr(c.checkInDate));
  return dates;
}

// Distinct days with either a DraftPlan log or a DaysChallenge check-in,
// counted within [weekStart, weekEnd).
async function countSessionDaysInWeek(userId, weekStart, weekEnd) {
  const dates = await getUnionActiveDateSet(userId, weekStart);
  const weekStartStr = toDateStr(weekStart);
  const weekEndStr = toDateStr(weekEnd);
  let count = 0;
  for (const d of dates) {
    if (d >= weekStartStr && d < weekEndStr) count++;
  }
  return count;
}

// Sum of DraftProgressLog.countLogged in [weekStart, weekEnd), vs the
// writer's own DraftPlan.weeklyGoal.
async function getWeeklyGoalProgress(userId, weekStart, weekEnd) {
  const [plan, agg] = await Promise.all([
    prisma.draftPlan.findUnique({ where: { userId }, select: { weeklyGoal: true } }),
    prisma.draftProgressLog.aggregate({
      where: { userId, logDate: { gte: weekStart, lt: weekEnd } },
      _sum: { countLogged: true },
    }),
  ]);
  return {
    achieved: agg._sum.countLogged || 0,
    target: plan ? plan.weeklyGoal : null,
  };
}

// Completed Sprints whose *local* calendar date (per user.timezone) falls
// inside [weekStart, weekEnd). Pads the raw query window by a day on each
// side to cover timezone offsets, then filters precisely in JS.
async function countSprintsInWeek(user, weekStart, weekEnd) {
  const paddedStart = addDays(weekStart, -1);
  const paddedEnd = addDays(weekEnd, 1);
  const sprints = await prisma.sprint.findMany({
    where: {
      userId: user.id,
      completedAt: { gte: paddedStart, lt: paddedEnd, not: null },
    },
    select: { completedAt: true },
  });
  const weekStartStr = toDateStr(weekStart);
  const weekEndStr = toDateStr(weekEnd);
  return sprints.filter((s) => {
    const { dateStr } = getLocalDateInfo(user.timezone, s.completedAt);
    return dateStr >= weekStartStr && dateStr < weekEndStr;
  }).length;
}

// Set of local calendar dates (per user.timezone) within [weekStart, weekEnd)
// on which the user completed at least one Sprint. Same padding trick as
// countSprintsInWeek, just returning the date set instead of a count.
async function getSprintActiveDateSetInWeek(user, weekStart, weekEnd) {
  const paddedStart = addDays(weekStart, -1);
  const paddedEnd = addDays(weekEnd, 1);
  const sprints = await prisma.sprint.findMany({
    where: {
      userId: user.id,
      completedAt: { gte: paddedStart, lt: paddedEnd, not: null },
    },
    select: { completedAt: true },
  });
  const weekStartStr = toDateStr(weekStart);
  const weekEndStr = toDateStr(weekEnd);
  const dates = new Set();
  for (const s of sprints) {
    const { dateStr } = getLocalDateInfo(user.timezone, s.completedAt);
    if (dateStr >= weekStartStr && dateStr < weekEndStr) dates.add(dateStr);
  }
  return dates;
}

// Longest run of consecutive calendar days *within [weekStart, weekEnd)*
// that appear in `activeDates` — not anchored to any particular end date,
// and never reaches outside the week. This is what both CONSECUTIVE_DAYS
// and CONSECUTIVE_SPRINT_DAYS are built on; only the source of
// `activeDates` differs (session activity vs. completed sprints).
function longestConsecutiveRunInWeek(activeDates, weekStart, weekEnd) {
  let best = 0;
  let current = 0;
  let cursor = new Date(weekStart);
  const weekEndStr = toDateStr(weekEnd);
  while (toDateStr(cursor) < weekEndStr) {
    if (activeDates.has(toDateStr(cursor))) {
      current++;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
    cursor = addDays(cursor, 1);
  }
  return best;
}

/**
 * Computes { achieved, target } for one user against one template, for the
 * week [weekStart, weekStart+7days). This is read-only — it does not write
 * a MiniChallengeResult row, so it's safe to call anytime mid-week to show
 * live "3/5 this week" progress.
 */
async function computeProgress(user, template, weekStart) {
  const weekEnd = addDays(weekStart, 7);

  switch (template.type) {
    case "SESSION_COUNT": {
      const achieved = await countSessionDaysInWeek(user.id, weekStart, weekEnd);
      return { achieved, target: template.targetValue };
    }
    case "WEEKLY_GOAL": {
      return getWeeklyGoalProgress(user.id, weekStart, weekEnd);
    }
    case "SPRINT_COUNT": {
      const achieved = await countSprintsInWeek(user, weekStart, weekEnd);
      return { achieved, target: template.targetValue };
    }
    case "CONSECUTIVE_DAYS": {
      const activeDates = await getUnionActiveDateSet(user.id, weekStart);
      const achieved = longestConsecutiveRunInWeek(activeDates, weekStart, weekEnd);
      return { achieved, target: template.targetValue };
    }
    case "CONSECUTIVE_SPRINT_DAYS": {
      const activeDates = await getSprintActiveDateSetInWeek(user, weekStart, weekEnd);
      const achieved = longestConsecutiveRunInWeek(activeDates, weekStart, weekEnd);
      return { achieved, target: template.targetValue };
    }
    default:
      return { achieved: 0, target: template.targetValue };
  }
}

// ─── Member-facing progress fetch ─────────────────────────────────────────────

/**
 * Everything the frontend needs to render "this week's challenge" +
 * progress bar for one user, computed live (not from a stored result row,
 * which only exists once the week has actually closed for that person).
 */
async function getMyWeeklyProgress(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, timezone: true },
  });
  if (!user) throwHttp(404, "User not found.");

  const { dateStr } = getLocalDateInfo(user.timezone);
  const weekStart = mondayOfWeek(dateStr);

  const template = await getLiveTemplate(weekStart);
  if (!template) {
    return { template: null, message: "No active mini-challenge right now." };
  }

  const [{ achieved, target }, existingResult] = await Promise.all([
    computeProgress(user, template, weekStart),
    prisma.miniChallengeResult.findUnique({
      where: { weekStart_userId: { weekStart, userId } },
    }),
  ]);

  const completed = target != null ? achieved >= target : false;

  return {
    template: {
      id: template.id,
      title: template.title,
      description: template.description,
      type: template.type,
      badgeName: template.badgeName,
      badgeIcon: template.badgeIcon,
    },
    weekStart,
    achievedValue: achieved,
    targetValue: target,
    remaining: target != null ? Math.max(target - achieved, 0) : null,
    completed,
    // True once the week has actually closed and been recorded — the live
    // numbers above may still tick upward until then.
    recorded: !!existingResult,
  };
}

/**
 * Same shape as getMyWeeklyProgress, but for any user id — used for an
 * admin/leaderboard-style view of everyone's current progress.
 */
async function getWeeklyProgressForUsers(userIds) {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, avatar: true, timezone: true },
  });

  // Different users can be in different local weeks near a boundary, so the
  // live template is resolved per-user rather than once for the batch.
  const results = await Promise.all(
    users.map(async (user) => {
      const { dateStr } = getLocalDateInfo(user.timezone);
      const weekStart = mondayOfWeek(dateStr);
      const template = await getLiveTemplate(weekStart);
      if (!template) return { user: { id: user.id, username: user.username, avatar: user.avatar }, template: null };

      const { achieved, target } = await computeProgress(user, template, weekStart);
      const completed = target != null ? achieved >= target : false;

      return {
        user: { id: user.id, username: user.username, avatar: user.avatar },
        template: { id: template.id, title: template.title, type: template.type },
        achievedValue: achieved,
        targetValue: target,
        remaining: target != null ? Math.max(target - achieved, 0) : null,
        completed,
      };
    })
  );

  return results;
}

// ─── Leaderboard (public "who's making progress" view) ───────────────────────
// There's no MiniChallengeParticipant table to query — "who's in this week's
// challenge" is really just "who's had any writing activity recently", so we
// pull distinct userIds off the three raw activity tables, then reuse
// computeProgress per user (same math as getMyWeeklyProgress) against each
// user's own live template. Lookback is padded past 7 days so it still
// catches everyone's current local week near a UTC day boundary.

const LEADERBOARD_LOOKBACK_DAYS = 8;
const LEADERBOARD_MAX_ENTRIES = 20;

async function getRecentlyActiveUserIds(sinceDate) {
  const [logs, checkIns, sprints] = await Promise.all([
    prisma.draftProgressLog.findMany({
      where: { logDate: { gte: sinceDate } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.daysChallengeCheckIn.findMany({
      where: { checkInDate: { gte: sinceDate } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.sprint.findMany({
      where: { completedAt: { gte: sinceDate, not: null } },
      select: { userId: true },
      distinct: ["userId"],
    }),
  ]);
  const ids = new Set();
  for (const l of logs) ids.add(l.userId);
  for (const c of checkIns) ids.add(c.userId);
  for (const s of sprints) ids.add(s.userId);
  return [...ids];
}

/**
 * Public leaderboard: recently-active writers' live progress toward this
 * week's mini-challenge, most-progressed first. Each user's progress is
 * computed against the template live in *their own* local week (mirrors
 * getMyWeeklyProgress), so someone a few hours into Monday in one timezone
 * is compared fairly against someone still finishing Sunday in another.
 */
async function getWeeklyLeaderboard({ limit = LEADERBOARD_MAX_ENTRIES } = {}) {
  const since = addDays(new Date(), -LEADERBOARD_LOOKBACK_DAYS);
  const activeUserIds = await getRecentlyActiveUserIds(since);

  // Header template: what most visitors will consider "this week's
  // challenge" — resolved off UTC as a stand-in for the general case.
  const { dateStr } = getLocalDateInfo("UTC");
  const headerTemplate = await getLiveTemplate(mondayOfWeek(dateStr));

  if (!activeUserIds.length) {
    return { template: headerTemplate ? { id: headerTemplate.id, title: headerTemplate.title, badgeIcon: headerTemplate.badgeIcon } : null, entries: [] };
  }

  const users = await prisma.user.findMany({
    where: { id: { in: activeUserIds }, isDeleted: false },
    select: { id: true, username: true, avatar: true, timezone: true },
  });

  const rawEntries = await Promise.all(
    users.map(async (user) => {
      const { dateStr: userDateStr } = getLocalDateInfo(user.timezone);
      const weekStart = mondayOfWeek(userDateStr);
      const template = await getLiveTemplate(weekStart);
      if (!template) return null;

      const { achieved, target } = await computeProgress(user, template, weekStart);
      if (achieved <= 0) return null; // no real progress yet — leave off the board

      const completed = target != null ? achieved >= target : false;
      return {
        user: { id: user.id, username: user.username, avatar: user.avatar },
        achievedValue: achieved,
        targetValue: target,
        remaining: target != null ? Math.max(target - achieved, 0) : null,
        completed,
      };
    })
  );

  const entries = rawEntries
    .filter(Boolean)
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? -1 : 1;
      return b.achievedValue - a.achievedValue;
    })
    .slice(0, limit);

  return {
    template: headerTemplate ? { id: headerTemplate.id, title: headerTemplate.title, badgeIcon: headerTemplate.badgeIcon } : null,
    entries,
  };
}

// ─── Evaluation + recording (run by jobs/minichallengecron.js) ───────────────

/**
 * Evaluates one user's just-closed local week against that week's template,
 * upserts the MiniChallengeResult (idempotent via @@unique([weekStart,
 * userId])), and — if they cleared the bar and haven't already been
 * granted this exact weekly badge — creates an unclaimed UserBadge.
 */
async function evaluateAndRecordWeek(userId, weekStart) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, timezone: true },
  });
  if (!user) throwHttp(404, "User not found.");

  const template = await getLiveTemplate(weekStart);
  if (!template) return null;

  const { achieved, target } = await computeProgress(user, template, weekStart);
  const completed = target != null ? achieved >= target : false;

  const result = await prisma.miniChallengeResult.upsert({
    where: { weekStart_userId: { weekStart, userId } },
    update: { achievedValue: achieved, targetValue: target, completed },
    create: {
      templateId: template.id,
      userId,
      weekStart,
      achievedValue: achieved,
      targetValue: target,
      completed,
    },
  });

  let isNewBadge = false;
  if (completed) {
    // update:{} is a no-op on an existing row, so earnedAt only ever gets
    // set by the create branch — comparing against `before` tells the
    // caller (the cron) whether this call is the one that just granted the
    // badge, vs. an idempotent re-run of a week already recorded.
    const before = new Date();
    const badge = await prisma.userBadge.upsert({
      where: {
        userId_sourceType_sourceId_weekStart: {
          userId,
          sourceType: "MINI_CHALLENGE",
          sourceId: template.id,
          weekStart,
        },
      },
      update: {},
      create: {
        userId,
        name: template.badgeName,
        icon: template.badgeIcon,
        sourceType: "MINI_CHALLENGE",
        sourceId: template.id,
        weekStart,
      },
    });
    isNewBadge = badge.earnedAt >= before;
  }

  return { ...result, isNewBadge, template };
}

// Users who could plausibly need this week's evaluation run — i.e. anyone
// not deleted. We intentionally don't filter to "recently active" here:
// unlike the leaderboard (a live snapshot that's fine to skip quiet users
// on), the cron is the one place a completed week gets permanently
// recorded, so it must not silently miss someone who did all their writing
// early in the week and then went quiet.
async function getUsersForWeeklyEvaluation() {
  return prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true, timezone: true },
  });
}

// ─── Badges ────────────────────────────────────────────────────────────────────

async function getMyBadges(userId) {
  const badges = await prisma.userBadge.findMany({
    where: { userId },
    orderBy: { earnedAt: "desc" },
  });
  return {
    unclaimed: badges.filter((b) => !b.claimedAt),
    claimed: badges.filter((b) => !!b.claimedAt),
  };
}

async function claimBadge(userId, badgeId) {
  const badge = await prisma.userBadge.findUnique({ where: { id: badgeId } });
  if (!badge) throwHttp(404, "Badge not found.");
  if (badge.userId !== userId) throwHttp(403, "This badge doesn't belong to you.");
  if (badge.claimedAt) return badge; // already claimed — no-op

  return prisma.userBadge.update({
    where: { id: badgeId },
    data: { claimedAt: new Date() },
  });
}

/**
 * Resolves just the live template for "what's this week's challenge"
 * previews — timezone-aware if a userId is given, UTC otherwise.
 */
async function getCurrentTemplateForUser(userId) {
  let timezone = "UTC";
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    if (user) timezone = user.timezone;
  }
  const { dateStr } = getLocalDateInfo(timezone);
  const weekStart = mondayOfWeek(dateStr);
  return getLiveTemplate(weekStart);
}

module.exports = {
  // templates
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  setTemplateActive,
  // rotation / progress
  getLiveTemplate,
  getCurrentTemplateForUser,
  computeProgress,
  getMyWeeklyProgress,
  getWeeklyProgressForUsers,
  getWeeklyLeaderboard,
  // evaluation (for the cron)
  evaluateAndRecordWeek,
  getUsersForWeeklyEvaluation,
  // badges
  getMyBadges,
  claimBadge,
  // exported for the cron / tests
  getLocalDateInfo,
  mondayOfWeek,
};