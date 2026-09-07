// src/services/workspaceService.js
const prisma = require("../config/prismaClient");
const { startOfWeekInTimezone } = require("../utilis/timezone");
const { getStreaks, getHistory, getDailySeries, getTodayActivity, hasSprintOrLogActivityToday } = require("./writingactivityservice");
const { getMostRecentlyActivePlan } = require("./draftplanservice");
const { notifyUser } = require("./notificationService");

// ─── WEEKLY TARGET — base list ──────────────────────────────────────────────
// Previously lived in draftPlanService. Moved here because "working toward
// weekly target" is the base list the whole workspace/draft-plan split is
// built from — everything below reads from this.
//
// "Working toward" means actively making progress toward it this week: not
// already finished (metWeeklyGoal), and not sitting at zero either
// (weekTotal > 0). A writer who hasn't logged anything yet this week hasn't
// started, so they don't belong on either the draft-plan feed or the
// workspace feed until they log something.
//
// There's no stored "week" state to reset — each writer's week is computed
// live via startOfWeekInTimezone(their own timezone) on every call, so the
// feed naturally rolls over the moment it becomes Sunday in that writer's
// local time.

// Shared by getWritersWorkingTowardWeeklyTarget (still short of goal) and
// getWeeklyGoalCompleters (already hit it) below — same base rows, two
// different filters over the same week's numbers.
async function buildWeeklyTargetRows(requestingUserId) {
  const plans = await prisma.draftPlan.findMany({
    where: { isCompleted: false },
    include: {
      user:         { select: { id: true, username: true, avatar: true, timezone: true } },
      progressLogs: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return plans.map((p) => {
    const timezone  = p.user.timezone ?? "UTC";
    const weekStart = startOfWeekInTimezone(timezone);
    const weekLogs  = p.progressLogs.filter((l) => new Date(l.logDate) >= weekStart);
    const weekTotal = weekLogs.reduce((a, l) => a + l.countLogged, 0);
    const metWeeklyGoal = p.weeklyGoal > 0 ? weekTotal >= p.weeklyGoal : false;
    const percentOfWeeklyGoal = p.weeklyGoal > 0
      ? Math.min(Math.round((weekTotal / p.weeklyGoal) * 100), 100)
      : 0;

    return {
      planId: p.id,
      userId: p.userId,
      username: p.user.username,
      avatar: p.user.avatar,
      timezone, // internal — stripped before these rows go out over the wire
      storyTitle: p.storyTitle,
      goalType: p.goalType,
      weeklyGoal: p.weeklyGoal,
      weekTotal,
      percentOfWeeklyGoal,
      metWeeklyGoal,
      isCurrentUser: p.userId === requestingUserId,
    };
  });
}

async function getWritersWorkingTowardWeeklyTarget(requestingUserId) {
  const rows = await buildWeeklyTargetRows(requestingUserId);
  return rows
    .filter((w) => !w.metWeeklyGoal && w.weekTotal > 0)
    .sort((a, b) => b.percentOfWeeklyGoal - a.percentOfWeeklyGoal)
    .map(stripInternal);
}

// ─── WEEKLY WINNERS — Sunday recap ─────────────────────────────────────────
// Writers who've already met their weekly target this week. The frontend
// only shows this on Sundays (see workspaceDashboard.jsx) — kept as a plain
// "current state" query rather than a stored snapshot, since each writer's
// week rolls over at a different moment anyway (startOfWeekInTimezone is
// per-writer, not global). Sorted by raw weekTotal since everyone here is
// already at 100% of their own (differently-sized) goal.

async function getWeeklyGoalCompleters(requestingUserId) {
  const rows = await buildWeeklyTargetRows(requestingUserId);
  return rows
    .filter((w) => w.metWeeklyGoal)
    .sort((a, b) => b.weekTotal - a.weekTotal)
    .map(stripInternal);
}

function stripInternal({ timezone, ...rest }) {
  return rest;
}

// ─── ALL ACTIVE WRITERS — base list for workspace membership ──────────────
// Every writer with a non-completed draft plan, no weekly-target filtering
// at all. This is what getWorkspaceMembers narrows down, independently of
// getWritersWorkingTowardWeeklyTarget above — workspace membership is about
// "did you write today," not "are you still short of your weekly goal."

async function getAllActiveWriters(requestingUserId) {
  const plans = await prisma.draftPlan.findMany({
    where: { isCompleted: false },
    include: { user: { select: { id: true, username: true, avatar: true, timezone: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return plans.map((p) => ({
    planId: p.id,
    userId: p.userId,
    username: p.user.username,
    avatar: p.user.avatar,
    timezone: p.user.timezone ?? "UTC", // internal — stripped before these rows go out
    storyTitle: p.storyTitle,
    goalType: p.goalType,
    isCurrentUser: p.userId === requestingUserId,
  }));
}

// ─── DRAFT PLAN FEED ────────────────────────────────────────────────────────
// Writers working toward their weekly target who have NOT had sprint or log
// activity today.

async function getDraftPlanFeed(requestingUserId) {
  const base = await getWritersWorkingTowardWeeklyTarget(requestingUserId);

  const flagged = await Promise.all(
    base.map(async (w) => ({ ...w, wroteToday: await hasSprintOrLogActivityToday(w.userId, w.timezone) }))
  );

  return flagged.filter((w) => !w.wroteToday).map(stripInternal);
}

// ─── WORKSPACE MEMBERS ──────────────────────────────────────────────────────
// ANY writer (active draft plan, regardless of weekly-target standing) who
// had sprint or log-progress activity specifically today. Independent of
// getWritersWorkingTowardWeeklyTarget — a writer who already hit their
// weekly goal, or hasn't started their week yet, still shows up here if
// they logged or sprinted today. Plain draft edits don't count (see
// hasSprintOrLogActivityToday). Deliberately lightweight — no per-member
// streaks/history/totals; use getMyWorkspaceStats() for the logged-in
// user's own numbers.

async function getWorkspaceMembers(requestingUserId) {
  const base = await getAllActiveWriters(requestingUserId);

  const flagged = await Promise.all(
    base.map(async (w) => {
      const wroteToday = await hasSprintOrLogActivityToday(w.userId, w.timezone);
      if (!wroteToday) return { ...w, wroteToday };

      // Only fetch the breakdown for writers who actually showed up today —
      // this is what lets Community "Writing today" show *what* someone did
      // (logged 400 words vs. sprinted 812 words in 25m at 32.5 wpm) instead
      // of just flagging that they did something.
      const today = await getTodayActivity(w.userId, w.timezone);
      return { ...w, wroteToday, todayActivity: summarizeTodayActivity(today) };
    })
  );

  return flagged.filter((w) => w.wroteToday).map(stripInternal);
}

// Turns a raw DailyWritingActivity row into the small shape the frontend
// wants for Community "Writing today". A writer can have both log and
// sprint entries on the same day, so this returns both when present rather
// than picking one — the card renders whichever keys exist.
function summarizeTodayActivity(row) {
  if (!row) return null;

  const summary = {};

  if (row.hasLogActivity) {
    summary.log = {
      words: row.wordsFromLog,
      chapters: row.chaptersFromLog,
      scenes: row.scenesFromLog,
    };
  }

  if (row.hasSprintActivity) {
    const words = row.wordsFromSprints;
    const minutes = row.minutesFromSprints;
    summary.sprint = {
      count: row.sprintCount || 1,
      words,
      minutes,
      wpm: minutes > 0 ? Math.round((words / minutes) * 10) / 10 : 0,
    };
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// ─── OWN STATS (logged-in user only) ───────────────────────────────────────
// Streaks, 7/15/30-day history, total words across drafts, total logged
// progress — all the "heavy" stats, computed for exactly one user: whoever
// is asking. Never batch-computed across the workspace list.

async function getMyWorkspaceStats(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";

  const [streaks, history, totalWordsAgg, spotlightPlan] = await Promise.all([
    getStreaks(userId, timezone),
    getHistory(userId, timezone),
    prisma.writingDraft.aggregate({ where: { userId }, _sum: { wordCount: true } }),
    getMyWeeklyGoalPlan(userId),
  ]);

  return {
    streaks,                          // { currentStreak, longestStreak }
    history,                          // { last7, last15, last30, activeTypes }
    totalWordsAcrossDrafts: totalWordsAgg._sum.wordCount ?? 0,
    totalLoggedProgress: spotlightPlan
      ? { goalType: spotlightPlan.goalType, total: spotlightPlan.totalLogged }
      : null,
    // The single plan to spotlight on the workspace dashboard's weekly-goal
    // widget — see getMyWeeklyGoalPlan below. A writer can have several
    // active plans; the dashboard only ever shows one at a time (the one
    // they most recently logged progress on), with a "Draft Plans" button
    // elsewhere in the workspace to browse/switch to the rest.
    weeklyGoalPlan: spotlightPlan,
  };
}

// ─── WEEKLY-GOAL SPOTLIGHT PLAN (workspace dashboard) ──────────────────────
// A writer can have multiple active draft plans (see draftPlanService —
// DraftPlan.userId is no longer unique). The workspace dashboard's weekly
// target ring only has room for one at a time, so this picks a single plan
// to spotlight: whichever one the writer most recently logged progress on.
// If they've never logged anything yet, falls back to their most recently
// created active plan. Returns null if they have no plans at all.

async function getMyWeeklyGoalPlan(userId) {
  const plan = await getMostRecentlyActivePlan(userId);
  if (!plan) return null;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const tz = user?.timezone ?? "UTC";
  const weekStart = startOfWeekInTimezone(tz);

  const [weekLogsAgg, totalLoggedAgg] = await Promise.all([
    prisma.draftProgressLog.aggregate({
      where: { planId: plan.id, logDate: { gte: weekStart } },
      _sum: { countLogged: true },
    }),
    prisma.draftProgressLog.aggregate({
      where: { planId: plan.id },
      _sum: { countLogged: true },
    }),
  ]);

  const weekTotal = weekLogsAgg._sum.countLogged ?? 0;
  const totalLogged = totalLoggedAgg._sum.countLogged ?? 0;
  const totalSoFar = plan.wordsWrittenSoFar + totalLogged;

  return {
    planId: plan.id,
    storyTitle: plan.storyTitle,
    goalType: plan.goalType,
    weeklyGoal: plan.weeklyGoal,
    weekTotal,
    percentOfWeeklyGoal: plan.weeklyGoal > 0 ? Math.min(Math.round((weekTotal / plan.weeklyGoal) * 100), 100) : 0,
    metWeeklyGoal: plan.weeklyGoal > 0 ? weekTotal >= plan.weeklyGoal : false,
    totalSoFar,
    targetLength: plan.targetLength,
    totalLogged,
  };
}

// ─── FINISHED DRAFTS ────────────────────────────────────────────────────────
// Writers who've completed a draft plan recently — celebrated to the rest
// of the workspace regardless of day. `days` controls the recency window;
// 14 keeps it feeling current without the list going stale-empty on a slow
// week. A writer with several active plans can still show up more than
// once here if they finish more than one story in the window — that's
// intentional, each finish is its own thing worth celebrating.

async function getRecentlyFinishedDraftPlans(requestingUserId, days = 14) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const plans = await prisma.draftPlan.findMany({
    where: { isCompleted: true, completedAt: { gte: cutoff } },
    include: { user: { select: { id: true, username: true, avatar: true } } },
    orderBy: { completedAt: "desc" },
  });

  return plans.map((p) => ({
    planId: p.id,
    userId: p.userId,
    username: p.user.username,
    avatar: p.user.avatar,
    storyTitle: p.storyTitle,
    goalType: p.goalType,
    targetLength: p.targetLength,
    completedAt: p.completedAt,
    isCurrentUser: p.userId === requestingUserId,
  }));
}

// ─── TOP STREAKS ────────────────────────────────────────────────────────────
// Top 6 current streaks across the workspace, 6-day minimum before a writer
// qualifies to appear at all (avoids the leaderboard being "everyone who
// wrote yesterday twice"). Streak is a per-writer stat, not per-plan, so we
// dedupe active writers by userId first — a writer with several active
// plans should only occupy one leaderboard slot.

async function getTopStreakLeaderboard(requestingUserId) {
  const base = await getAllActiveWriters(requestingUserId);

  const byUser = new Map();
  for (const w of base) if (!byUser.has(w.userId)) byUser.set(w.userId, w);

  const withStreaks = await Promise.all(
    [...byUser.values()].map(async (w) => {
      const { currentStreak, longestStreak } = await getStreaks(w.userId, w.timezone);
      return {
        userId: w.userId,
        username: w.username,
        avatar: w.avatar,
        isCurrentUser: w.isCurrentUser,
        currentStreak,
        longestStreak,
      };
    })
  );

  return withStreaks
    .filter((w) => w.currentStreak >= 6)
    .sort((a, b) => b.currentStreak - a.currentStreak || b.longestStreak - a.longestStreak)
    .slice(0, 6);
}

// ─── WORKSPACE PROFILE (aspiration note) ───────────────────────────────────

async function getMyActivitySeries(userId, days = 30) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return getDailySeries(userId, user?.timezone ?? "UTC", Math.min(Math.max(Number(days) || 30, 7), 30));
}

// ─── ENCOURAGEMENT CARDS ────────────────────────────────────────────────────
// "Send card" on a workspace member who's already written today — a quick,
// low-effort way to cheer someone on. Piggybacks on the existing
// notification system (notifyUser) instead of a new table: the card IS the
// notification. No persistence beyond that — whether a card was "already
// sent today" to someone is tracked client-side per session, not enforced
// server-side (a writer can send more than one if they really want to).

const CARD_LABELS = { WELL_DONE: "Well done!", CONGRATS: "Congrats!" };

async function sendEncouragementCard(fromUser, toUserId, cardType) {
  const label = CARD_LABELS[cardType];
  if (!label) throw new Error("Unknown card type");
  if (Number(toUserId) === fromUser.id) throw new Error("You can't send yourself a card");

  const message = `${fromUser.username} sent you a "${label}" card for writing today!`;
  await notifyUser({ id: Number(toUserId) }, message, "/workspace", "workspace_card_sent", "GENERAL", {
    kind: "encouragement_card",
    cardType,
  });
  return { sent: true, cardType };
}

async function getWorkspaceProfile(userId) {
  const profile = await prisma.workspaceProfile.findUnique({ where: { userId } });
  return profile ?? { userId, aspiration: null };
}

async function updateWorkspaceProfile(userId, { aspiration }) {
  const clean = typeof aspiration === "string" ? aspiration.trim().slice(0, 1000) : null;

  return prisma.workspaceProfile.upsert({
    where: { userId },
    create: { userId, aspiration: clean },
    update: { aspiration: clean },
  });
}

module.exports = {
  getWritersWorkingTowardWeeklyTarget,
  getWeeklyGoalCompleters,
  getDraftPlanFeed,
  getWorkspaceMembers,
  getRecentlyFinishedDraftPlans,
  getTopStreakLeaderboard,
  getMyWorkspaceStats,
  getMyWeeklyGoalPlan,
  getMyActivitySeries,
  sendEncouragementCard,
  getWorkspaceProfile,
  updateWorkspaceProfile,
};