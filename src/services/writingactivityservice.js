// src/services/writingActivityService.js
//
// Single source of truth for "did this writer write today, and how much."
// Written to from four places:
//   - draftPlanService.logProgress()            → recordLogActivity()
//   - draftPlanService.logBonusQuestProgress()  → recordBonusQuestActivity()
//   - draftService.updateDraft()                → recordDraftActivity()
//   - sprintService.checkinSprint()              → recordSprintActivity()
//
// Streaks are built ONLY from hasSprintActivity / hasLogActivity /
// hasBonusQuestActivity — all three are writers actively choosing to log
// something, unlike a draft autosave which can fire on its own. History/
// output stats fold in drafts+sprints+log for the real `words` total;
// Bonus Quest words are tracked separately (wordsFromBonusQuest /
// bonusQuestWords) so they never inflate real story-output numbers.

const prisma = require("../config/prismaClient");
const { toMidnightUTC, todayInTimezone } = require("../utilis/timezone");

// ─── WRITE SIDE ────────────────────────────────────────────────────────────

// Called from draftPlanService.logProgress() after it resolves the day's
// countLogged for a plan. `date` should be the same midnight-UTC Date
// logProgress already resolved (its `today` var) so both tables agree on
// which calendar day this is. `newTodayCount` is the day's CURRENT total for
// that plan (not a delta) — mirrors DraftProgressLog's own convention.
async function recordLogActivity(userId, date, goalType, newTodayCount) {
  const day = toMidnightUTC(date);
  const safeCount = Math.max(newTodayCount, 0);

  const field =
    goalType === "CHAPTERS" ? "chaptersFromLog" :
    goalType === "SCENES"   ? "scenesFromLog"   :
    "wordsFromLog"; // WORDS, or DURATION-typed plans (rare) fall back here

  await prisma.dailyWritingActivity.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      [field]: safeCount,
      hasLogActivity: safeCount > 0,
    },
    update: {
      [field]: safeCount,
      hasLogActivity: safeCount > 0,
    },
  });
}

// Called from draftPlanService.logBonusQuestProgress() after it resolves the
// day's countLogged for a Bonus Quest. `newTodayCount` is the quest's
// CURRENT total for that day (not a delta), same convention as
// recordLogActivity. Deliberately writes to its OWN field
// (wordsFromBonusQuest / hasBonusQuestActivity) instead of
// wordsFromLog/hasLogActivity — Bonus Quest words aren't real story output,
// so they must never bleed into getHistory's `words` sum or
// totalWordsAcrossDrafts. They DO count toward streaks and "wrote today",
// via hasBonusQuestActivity below — showing up unprompted should count for
// something, just not for the book.
async function recordBonusQuestActivity(userId, date, newTodayCount) {
  const day = toMidnightUTC(date);
  const safeCount = Math.max(newTodayCount, 0);

  await prisma.dailyWritingActivity.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      wordsFromBonusQuest: safeCount,
      hasBonusQuestActivity: safeCount > 0,
    },
    update: {
      wordsFromBonusQuest: safeCount,
      hasBonusQuestActivity: safeCount > 0,
    },
  });
}

// Called from wherever a Sprint is finalized (checkout / auto-end). Pass the
// timezone-resolved calendar date, the words written in that sprint, and the
// minutes actually spent on it — both accumulate, since a writer can run
// several sprints in one day. minutesSpent feeds the per-sprint WPM shown in
// Community "Writing today" (wordsFromSprints / minutesFromSprints for the
// day), so it's the writer's real elapsed time, not the sprint's planned
// duration — a 20-minute sprint checked in after 12 minutes should read as
// 12 minutes, not 20.
async function recordSprintActivity(userId, date, wordsWritten, minutesSpent = 0) {
  if (!wordsWritten || wordsWritten <= 0) return;
  const day = toMidnightUTC(date);
  const safeMinutes = Math.max(0, Math.round(minutesSpent) || 0);

  await prisma.dailyWritingActivity.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      wordsFromSprints: wordsWritten,
      minutesFromSprints: safeMinutes,
      sprintCount: 1,
      hasSprintActivity: true,
    },
    update: {
      wordsFromSprints: { increment: wordsWritten },
      minutesFromSprints: { increment: safeMinutes },
      sprintCount: { increment: 1 },
      hasSprintActivity: true,
    },
  });
}

// Called from draftService.updateDraft() with the net positive word delta
// for a plain (non-sprint) save. Negative/zero deltas (edits, trims) are
// ignored — this tracks output, not churn. Does NOT touch the streak fields.
async function recordDraftActivity(userId, date, wordDelta) {
  if (!wordDelta || wordDelta <= 0) return;
  const day = toMidnightUTC(date);

  await prisma.dailyWritingActivity.upsert({
    where: { userId_date: { userId, date: day } },
    create: {
      userId,
      date: day,
      wordsFromDrafts: wordDelta,
    },
    update: {
      wordsFromDrafts: { increment: wordDelta },
    },
  });
}

// ─── READ SIDE ─────────────────────────────────────────────────────────────

// Current + longest streak, in the writer's own timezone. "Current" stays
// intact through today even if today has no activity yet — it only breaks
// once a full calendar day passes with nothing logged.
async function getStreaks(userId, timezone = "UTC") {
  const rows = await prisma.dailyWritingActivity.findMany({
    where: {
      userId,
      OR: [{ hasSprintActivity: true }, { hasLogActivity: true }, { hasBonusQuestActivity: true }],
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });

  if (rows.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const dayMs = 24 * 60 * 60 * 1000;
  const dates = rows.map((r) => r.date.getTime());

  // Longest streak — walk sorted ascending dates, track longest run of
  // consecutive calendar days.
  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    const diffDays = Math.round((dates[i] - dates[i - 1]) / dayMs);
    if (diffDays === 1) {
      run += 1;
    } else if (diffDays > 1) {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
  }

  // Current streak — walk backwards from today (writer's timezone). If
  // today has no activity, allow starting from yesterday (streak not yet
  // broken, just not extended today).
  const today = todayInTimezone(timezone).getTime();
  const dateSet = new Set(dates);

  let anchor = dateSet.has(today) ? today : today - dayMs;
  let currentStreak = 0;
  while (dateSet.has(anchor)) {
    currentStreak += 1;
    anchor -= dayMs;
  }

  return { currentStreak, longestStreak };
}

// 7/15/30-day history, bucketed by type. Only returns a type
// (words/chapters/scenes) if the writer has any nonzero activity in it
// across the fetched window — per-type sparse response, not zero-padded.
async function getHistory(userId, timezone = "UTC") {
  const today = todayInTimezone(timezone);
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - 29); // fetch max window once (30d), slice for 7/15

  const rows = await prisma.dailyWritingActivity.findMany({
    where: { userId, date: { gte: windowStart, lte: today } },
    orderBy: { date: "asc" },
  });

  function sumWindow(days) {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
    const inWindow = rows.filter((r) => r.date >= cutoff);

    const words    = inWindow.reduce((a, r) => a + r.wordsFromDrafts + r.wordsFromSprints + r.wordsFromLog, 0);
    const chapters = inWindow.reduce((a, r) => a + r.chaptersFromLog, 0);
    const scenes   = inWindow.reduce((a, r) => a + r.scenesFromLog, 0);
    // Kept OUT of `words` on purpose — Bonus Quest words aren't real story
    // output, so mixing them into the same total would quietly inflate a
    // writer's "words written" history with prompt/sandbox/fun-fact text.
    // Returned separately so a caller that wants to show it can, without
    // it silently padding the real number everywhere else.
    const bonusQuestWords = inWindow.reduce((a, r) => a + r.wordsFromBonusQuest, 0);
    const daysActive = inWindow.filter(
      (r) => r.hasSprintActivity || r.hasLogActivity || r.hasBonusQuestActivity || r.wordsFromDrafts > 0
    ).length;

    return { words, chapters, scenes, bonusQuestWords, daysActive };
  }

  const buckets = { last7: sumWindow(7), last15: sumWindow(15), last30: sumWindow(30) };

  // Which types this writer actually has activity in, across the full 30d
  // window fetched — used by callers to decide which stat blocks to send.
  const totals30 = buckets.last30;
  const activeTypes = [];
  if (totals30.words    > 0) activeTypes.push("WORDS");
  if (totals30.chapters > 0) activeTypes.push("CHAPTERS");
  if (totals30.scenes   > 0) activeTypes.push("SCENES");

  return { ...buckets, activeTypes };
}

// Did this writer have ANY activity (draft edit, sprint, or log) today, in
// their own timezone? Used by workspaceService to decide draftplan-feed vs
// workspace-feed placement.
async function wroteToday(userId, timezone = "UTC") {
  const today = todayInTimezone(timezone);
  const row = await prisma.dailyWritingActivity.findUnique({
    where: { userId_date: { userId, date: today } },
  });
  if (!row) return false;
  return row.wordsFromDrafts > 0 || row.hasSprintActivity || row.hasLogActivity || row.hasBonusQuestActivity;
}

// Did this writer have sprint, log, or Bonus Quest activity specifically
// today, in their own timezone? Deliberately narrower than "any writing
// activity" — plain draft edits don't count here, same reasoning as the
// streak fields: sprints, log-progress, and Bonus Quests are all a writer
// actively choosing to log something, a draft autosave isn't. A completed
// Bonus Quest counts here too — showing up on an off day and finishing a
// quest is still "written today" for workspace purposes, even though it's
// not story progress. Used by workspaceService to split the weekly-target
// list into "written today" vs "not yet."
async function hasSprintOrLogActivityToday(userId, timezone = "UTC") {
  const today = todayInTimezone(timezone);
  const row = await prisma.dailyWritingActivity.findUnique({
    where: { userId_date: { userId, date: today } },
  });
  if (!row) return false;
  return row.hasSprintActivity || row.hasLogActivity || row.hasBonusQuestActivity;
}

// Today's raw activity row for one writer, in their own timezone — the
// per-type breakdown (log words/chapters/scenes vs. sprint words/minutes)
// that hasSprintOrLogActivityToday deliberately collapses to a boolean.
// Used by workspaceService to show what a writer actually did today in
// Community "Writing today" (e.g. "sprinted 812 words in 25m · 32.5 wpm"
// vs. "logged 400 words"), rather than just flagging that they showed up.
async function getTodayActivity(userId, timezone = "UTC") {
  const today = todayInTimezone(timezone);
  return prisma.dailyWritingActivity.findUnique({
    where: { userId_date: { userId, date: today } },
  });
}

// Day-by-day series for the workspace activity graph — the one thing
// getHistory() above deliberately doesn't return (it only sums windows).
// Returns one row per calendar day in the trailing `days` window, zero-
// filled for days with no activity at all, so the chart never has to guess
// which dates are "missing" vs. genuinely a 0-word day. `words` folds in
// drafts+sprints+log same as getHistory's own total (Bonus Quest words
// deliberately excluded — see the file header note).
async function getDailySeries(userId, timezone = "UTC", days = 30) {
  const today = todayInTimezone(timezone);
  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - (days - 1));

  const rows = await prisma.dailyWritingActivity.findMany({
    where: { userId, date: { gte: windowStart, lte: today } },
    orderBy: { date: "asc" },
  });
  const byDate = new Map(rows.map((r) => [r.date.getTime(), r]));

  const series = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = windowStart.getTime(); t <= today.getTime(); t += dayMs) {
    const r = byDate.get(t);
    series.push({
      date: new Date(t).toISOString(),
      words: r ? r.wordsFromDrafts + r.wordsFromSprints + r.wordsFromLog : 0,
      chapters: r ? r.chaptersFromLog : 0,
      scenes: r ? r.scenesFromLog : 0,
    });
  }
  return series;
}

module.exports = {
  recordLogActivity,
  recordSprintActivity,
  recordDraftActivity,
  recordBonusQuestActivity,
  getStreaks,
  getHistory,
  getDailySeries,
  getTodayActivity,
  wroteToday,
  hasSprintOrLogActivityToday,
};

// ─────────────────────────────────────────────────────────────────────────────
// Sprint hook status
//
// recordSprintActivity() is now wired into sprintService.checkinSprint() —
// see the normal solo-sprint checkout path there. That's the only place a
// Sprint gets finalized in this repo as provided.
//
// If an auto-end-stale-sprints cron job exists elsewhere (referenced in
// sprintService's comments but not included here), it still needs the same
// call added wherever it finalizes a sprint:
//
//   const { recordSprintActivity } = require("./writingActivityService");
//   const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
//   const minutesSpent = Math.round((completedAt - sprint.startedAt) / 60000);
//   await recordSprintActivity(userId, todayInTimezone(user?.timezone ?? "UTC"), sprint.wordsWritten, minutesSpent);
// ─────────────────────────────────────────────────────────────────────────────