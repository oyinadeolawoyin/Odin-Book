// src/services/draftPlanService.js
const prisma = require("../config/prismaClient");
const {
  toMidnightUTC,
  todayInTimezone,
  localTimeToUTC: localTimeToUTCReliable, // see note below on the rename
  startOfWeekInTimezone,
} = require("../utilis/timezone");
const { recordLogActivity, recordBonusQuestActivity, getHistory } = require("./writingactivityservice");
const dictionaryService = require("./dictionaryservice");
const draftFolderService = require("./draftfolderservice");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const WEEKDAY_JS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const JS_TO_WEEKDAY_ENUM = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// Cap on premise / whyFinish — both are meant to be a line or two, not an
// essay, so keep them short enough to actually render nicely in the
// blockquote/callout styling on draftPlanPage.jsx.
const MAX_STORY_TEXT_LENGTH = 500;

// Writers can now hold multiple plans at once (see schema.prisma —
// DraftPlan.userId is no longer @unique). This caps how many NON-completed
// plans one writer can juggle at a time, purely so the workspace/dashboard
// UI doesn't have to render an unbounded list. Finished plans (isCompleted)
// don't count against the cap.
const MAX_ACTIVE_PLANS = 2;
//
// toMidnightUTC, todayInTimezone, localTimeToUTCReliable, and
// startOfWeekInTimezone now live in src/utils/timezone.js, shared with
// daysChallengeService.js, so the two services can't drift into two
// different timezone implementations.
//
// Renaming note: this file previously had TWO local-time converters —
// localTimeToUTC (an older .toLocaleString()-round-trip approach, fragile
// around some Intl edge cases) and localTimeToUTCReliable (the offset-
// parsing version actually called everywhere below). Only the reliable one
// was ever used; the plain one was dead code and has been dropped. The
// shared timezone.js module exports the reliable implementation under the
// name `localTimeToUTC` (no "Reliable" suffix, since there's only one now),
// so it's destructured and aliased back to `localTimeToUTCReliable` here —
// that way every call site below keeps working unchanged.
function calcDerivedFields(targetLength, wordsWrittenSoFar, dailyGoal, writingDaysCount) {
  const remaining          = Math.max(targetLength - wordsWrittenSoFar, 0);
  const estimatedSessions  = dailyGoal > 0 ? Math.ceil(remaining / dailyGoal) : 0; // # of writing days needed
  const safeWritingDays    = writingDaysCount > 0 ? writingDaysCount : 1;
  const estimatedWeeks     = Math.ceil(estimatedSessions / safeWritingDays);
  const estimatedDays      = estimatedWeeks * 7; // calendar days — matches schema's estimatedDays column
  const weeklyGoal         = dailyGoal * safeWritingDays;
  // estimatedSessions is returned too (not just estimatedDays/weeklyGoal) so
  // getPlanProgress can surface a stable "sessions total" stat — see
  // stats.sessionsTotal below.
  return { estimatedDays, weeklyGoal, estimatedSessions };
}

// Check if a JS Date's UTC day matches one of the writer's recurring
// WeekDay picks (the weekly pattern set up on the plan itself).
function isRecurringPickedDay(date, writingDays) {
  const jsDay     = date.getUTCDay(); // 0=Sun, 1=Mon...
  const pickedSet = new Set(writingDays.map((d) => WEEKDAY_JS[d.day]));
  return pickedSet.has(jsDay);
}

// ─── BONUS QUEST — type selection ─────────────────────────────────────────────
// Actual prompt content now lives in the seedable BonusQuestPrompt table
// (see prisma/seeds/bonusQuestPrompts.js) instead of being hardcoded here.
// The wheel still randomly picks WHICH TYPE a writer gets on a given bonus
// day; WHICH PROMPT within that type is resolved from DraftBonusQuestProgress
// below — never random, always the next one in line for that type.
const BONUS_QUEST_TYPES = ["PROMPT_WRITE", "SANDBOX_SCENE", "FUN_FACT"];

function pickRandomQuestType() {
  return BONUS_QUEST_TYPES[Math.floor(Math.random() * BONUS_QUEST_TYPES.length)];
}

// ─── OWNERSHIP HELPER ──────────────────────────────────────────────────────
// Every plan-scoped read/write goes through here now instead of
// `draftPlan.findUnique({ where: { userId } })` — a writer can own several
// plans, so every call site needs to say WHICH one, and prove they own it.
// Throws the same "Draft plan not found" a missing/foreign plan always
// threw before, so existing controller error-status mapping (404) still
// works unchanged for both "doesn't exist" and "not yours" cases — we don't
// leak which one it was.
async function resolvePlan(userId, planId, include) {
  const id = Number(planId);
  if (!id) throw new Error("Draft plan not found");
  const plan = await prisma.draftPlan.findFirst({
    where: { id, userId },
    ...(include ? { include } : {}),
  });
  if (!plan) throw new Error("Draft plan not found");
  return plan;
}

// Lightweight list of every plan a writer owns — used by the plan switcher
// and by workspaceService to figure out which plan to spotlight. Ordered
// active-first, most-recently-updated first.
async function getMyPlans(userId) {
  const plans = await prisma.draftPlan.findMany({
    where: { userId },
    orderBy: [{ isCompleted: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      storyTitle: true,
      premise: true,
      goalType: true,
      dailyGoal: true,
      weeklyGoal: true,
      targetLength: true,
      wordsWrittenSoFar: true,
      estimatedDays: true,
      isCompleted: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      progressLogs: { select: { countLogged: true } },
    },
  });

  return plans.map((p) => {
    const totalSoFar = p.wordsWrittenSoFar + p.progressLogs.reduce((a, l) => a + l.countLogged, 0);
    const estimatedEndDate = p.estimatedDays
      ? new Date(new Date(p.createdAt).getTime() + p.estimatedDays * 24 * 60 * 60 * 1000)
      : null;
    return {
      id: p.id,
      storyTitle: p.storyTitle,
      premise: p.premise || null,
      goalType: p.goalType,
      dailyGoal: p.dailyGoal,
      weeklyGoal: p.weeklyGoal,
      targetLength: p.targetLength,
      totalSoFar,
      percentComplete: p.targetLength > 0 ? Math.min(Math.round((totalSoFar / p.targetLength) * 100), 100) : 0,
      isCompleted: p.isCompleted,
      completedAt: p.completedAt,
      startedAt: p.createdAt,
      estimatedEndDate,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}

// The plan a writer most recently logged real progress on (any non-removal
// DraftProgressLog write touches `updatedAt` — see logProgress). Falls back
// to the most recently created active plan if nothing's ever been logged,
// and to null if the writer has no plans at all. Used by workspaceService
// to decide which single plan's weekly goal to show on the dashboard when a
// writer has more than one.
async function getMostRecentlyActivePlan(userId) {
  const mostRecentLog = await prisma.draftProgressLog.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { planId: true },
  });
  if (mostRecentLog) {
    const plan = await prisma.draftPlan.findUnique({ where: { id: mostRecentLog.planId } });
    if (plan) return plan;
  }

  return prisma.draftPlan.findFirst({
    where: { userId, isCompleted: false },
    orderBy: { createdAt: "desc" },
  });
}

// ─── PLAN ────────────────────────────────────────────────────────────────────

async function createPlan(userId, data) {
  const {
    // Step 1
    wordsWrittenSoFar,
    targetLength,
    goalType,
    dailyGoal,
    writingDays,       // [{ day: "MON", reminderTime: "20:00" }, ...]
    // Step 2 — simplified to a single "why" field
    whyFinish,
    moodboardImages,   // string[] ≤5 URLs
    // Step 3
    storyTitle,
    premise,
  } = data;

  // ── Validation ────────────────────────────────────────────────────────────
  // premise/whyFinish are intentionally NOT required here — the creation
  // wizard only asks the "math layer" questions (title, goal type, starting
  // count, target length, writing days, daily goal, reminder time). Writers
  // fill in the premise and their "why" afterward, nudged by the profile-
  // completion checklist on the plan page (see PremiseSection/WhyFinish in
  // draftPlanPage.jsx) — both are editable there via updatePlan, so leaving
  // them blank at creation is a fully supported state, not just a gap.
  if (!storyTitle?.trim())          throw new Error("Story title is required");
  if (!goalType)                    throw new Error("Goal type is required");
  if (premise !== undefined && premise.length > MAX_STORY_TEXT_LENGTH)
    throw new Error(`Premise must be ${MAX_STORY_TEXT_LENGTH} characters or fewer`);
  if (whyFinish !== undefined && whyFinish.length > MAX_STORY_TEXT_LENGTH)
    throw new Error(`Why you're writing this story must be ${MAX_STORY_TEXT_LENGTH} characters or fewer`);
  if (typeof dailyGoal !== "number" || dailyGoal < 1)
    throw new Error("Daily goal must be a positive number");
  if (typeof targetLength !== "number" || targetLength < 1)
    throw new Error("Target length must be a positive number");
  if (typeof wordsWrittenSoFar !== "number" || wordsWrittenSoFar < 0)
    throw new Error("Words written so far must be 0 or more");
  if (!Array.isArray(writingDays) || writingDays.length < 4)
    throw new Error("Pick at least four writing days");

  // Validate writing days shape
  const validDays = new Set(["MON","TUE","WED","THU","FRI","SAT","SUN"]);
  for (const wd of writingDays) {
    if (!validDays.has(wd.day))
      throw new Error(`Invalid day: ${wd.day}`);
    if (!wd.reminderTime || !/^\d{2}:\d{2}$/.test(wd.reminderTime))
      throw new Error(`Reminder time for ${wd.day} must be in HH:MM format`);
  }

  const images = Array.isArray(moodboardImages) ? moodboardImages.slice(0, 5) : [];

  // ── Active-plan cap ────────────────────────────────────────────────────────
  // Replaces the old "one plan per writer" @unique constraint. A writer can
  // hold several plans now, but we still don't want an unbounded list.
  const activeCount = await prisma.draftPlan.count({ where: { userId, isCompleted: false } });
  if (activeCount >= MAX_ACTIVE_PLANS) {
    throw new Error(
      `You can have up to ${MAX_ACTIVE_PLANS} active draft plans at once. Finish or archive one before starting another.`
    );
  }

  // ── Fetch user timezone ───────────────────────────────────────────────────
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone ?? "UTC";

  // ── Derived calculations ──────────────────────────────────────────────────
  const { estimatedDays, weeklyGoal } = calcDerivedFields(
    targetLength,
    wordsWrittenSoFar,
    dailyGoal,
    writingDays.length
  );

  // ── Create ────────────────────────────────────────────────────────────────
  const plan = await prisma.draftPlan.create({
    data: {
      userId,
      storyTitle:        storyTitle.trim(),
      premise:           (premise ?? "").trim(),
      wordsWrittenSoFar,
      targetLength,
      goalType,
      dailyGoal,
      weeklyGoal,
      estimatedDays,
      whyFinish:         (whyFinish ?? "").trim(),
      moodboardImages:   images,
      writingDays: {
        create: writingDays.map((wd) => ({
          day:             wd.day,
          reminderTime:    wd.reminderTime,
          reminderTimeUTC: localTimeToUTCReliable(wd.reminderTime, timezone),
        })),
      },
    },
    include: {
      writingDays:  true,
      progressLogs: true,
    },
  });

  // Every plan gets exactly one folder, created right alongside it — see
  // draftFolderService for why this can't be created/renamed/deleted by
  // the writer directly.
  await draftFolderService.createFolderForPlan(plan);

  return plan;
}

async function getMyPlan(userId, planId) {
  const plan = await resolvePlan(userId, planId, {
    writingDays:  true,
    progressLogs: { orderBy: { logDate: "desc" } },
  });
  return plan;
}

async function updatePlan(userId, planId, data) {
  const plan = await resolvePlan(userId, planId, { writingDays: true });

  const {
    storyTitle, premise, whyFinish,
    moodboardImages, dailyGoal, writingDays,
    targetLength, wordsWrittenSoFar,
  } = data;

  // Validate the goal-math fields, same rules as plan creation.
  if (targetLength !== undefined) {
    if (typeof targetLength !== "number" || targetLength < 1)
      throw new Error("Target length must be a positive number");
  }
  if (wordsWrittenSoFar !== undefined) {
    if (typeof wordsWrittenSoFar !== "number" || wordsWrittenSoFar < 0)
      throw new Error("Words written so far must be 0 or more");
  }
  if (premise !== undefined && premise.length > MAX_STORY_TEXT_LENGTH)
    throw new Error(`Premise must be ${MAX_STORY_TEXT_LENGTH} characters or fewer`);
  if (whyFinish !== undefined && whyFinish.length > MAX_STORY_TEXT_LENGTH)
    throw new Error(`Why you're writing this story must be ${MAX_STORY_TEXT_LENGTH} characters or fewer`);
  if (writingDays !== undefined) {
    if (!Array.isArray(writingDays) || writingDays.length < 4)
      throw new Error("Pick at least four writing days");
    const validDays = new Set(["MON","TUE","WED","THU","FRI","SAT","SUN"]);
    for (const wd of writingDays) {
      if (!validDays.has(wd.day))
        throw new Error(`Invalid day: ${wd.day}`);
      if (!wd.reminderTime || !/^\d{2}:\d{2}$/.test(wd.reminderTime))
        throw new Error(`Reminder time for ${wd.day} must be in HH:MM format`);
    }
  }

  // Recalculate derived fields whenever any input to that math changed —
  // dailyGoal/writingDays (existing behavior), or targetLength/
  // wordsWrittenSoFar. All four feed the same formula, so any one changing
  // means estimatedDays/weeklyGoal are stale.
  let recalcFields = {};
  let newTotalSoFar; // set below whenever we touch the goal math, used for isCompleted too
  if (
    dailyGoal !== undefined || writingDays !== undefined ||
    targetLength !== undefined || wordsWrittenSoFar !== undefined
  ) {
    const newDailyGoal       = dailyGoal          ?? plan.dailyGoal;
    const newDaysCount       = writingDays        ? writingDays.length : plan.writingDays.length;
    const newTargetLength    = targetLength       ?? plan.targetLength;
    const newWordsSoFarBase  = wordsWrittenSoFar   ?? plan.wordsWrittenSoFar;

    const totalLogged    = await prisma.draftProgressLog.aggregate({
      where: { planId: plan.id },
      _sum:  { countLogged: true },
    });
    const logged         = totalLogged._sum.countLogged ?? 0;
    newTotalSoFar         = newWordsSoFarBase + logged;

    recalcFields         = calcDerivedFields(
      newTargetLength,
      newTotalSoFar,
      newDailyGoal,
      newDaysCount
    );
    // calcDerivedFields also returns estimatedSessions (used elsewhere for
    // stats.sessionsTotal), but that's not a column on DraftPlan — only
    // estimatedDays/weeklyGoal are. Drop it here so it never gets spread
    // into the Prisma update() below.
    delete recalcFields.estimatedSessions;
  }

  // Rebuild writing days if provided — need timezone for UTC conversion
  if (writingDays) {
    const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const timezone = user?.timezone ?? "UTC";
    await prisma.draftWritingDay.deleteMany({ where: { planId: plan.id } });
    await prisma.draftWritingDay.createMany({
      data: writingDays.map((wd) => ({
        planId:          plan.id,
        day:             wd.day,
        reminderTime:    wd.reminderTime,
        reminderTimeUTC: localTimeToUTCReliable(wd.reminderTime, timezone),
      })),
    });
  }

  // Keep isCompleted accurate whenever the goal math changed — same
  // "newTotal >= targetLength" rule logProgress() uses, so editing these
  // fields can flip the plan in or out of "completed" immediately rather
  // than waiting for the next logged session to notice the mismatch.
  let completionFields = {};
  if (newTotalSoFar !== undefined) {
    const newTargetLength = targetLength ?? plan.targetLength;
    const isDraftDone     = newTotalSoFar >= newTargetLength;
    if (isDraftDone && !plan.isCompleted) {
      completionFields = { isCompleted: true, completedAt: new Date() };
    } else if (!isDraftDone && plan.isCompleted) {
      completionFields = { isCompleted: false, completedAt: null };
    }
  }

  const updated = await prisma.draftPlan.update({
    where: { id: plan.id },
    data: {
      ...(storyTitle         !== undefined && { storyTitle:        storyTitle.trim() }),
      ...(premise            !== undefined && { premise:           premise.trim() }),
      ...(whyFinish          !== undefined && { whyFinish:         whyFinish.trim() }),
      ...(moodboardImages    !== undefined && { moodboardImages:   moodboardImages.slice(0, 5) }),
      ...(dailyGoal          !== undefined && { dailyGoal }),
      ...(targetLength       !== undefined && { targetLength }),
      ...(wordsWrittenSoFar  !== undefined && { wordsWrittenSoFar }),
      ...recalcFields,
      ...completionFields,
    },
    include: {
      writingDays:  true,
      progressLogs: { orderBy: { logDate: "desc" } },
    },
  });

  return updated;
}

async function deletePlan(userId, planId) {
  const plan = await resolvePlan(userId, planId);
  await prisma.draftPlan.delete({ where: { id: plan.id } });
  return { message: "Draft plan deleted" };
}

// ─── PROGRESS LOGGING ────────────────────────────────────────────────────────
// Logs an actual writing session (real words/chapters/scenes written today).
// `note` is optional — if passed, it's saved onto that day's row and shows
// up as the journal entry on that date in the timeline (getPlanTimeline
// reads DraftProgressLog live, so the timeline is automatically in sync
// the moment this runs — no separate step needed). Omitting `note` on a
// re-log leaves whatever note is already there untouched.
// For pre-planning a future date without writing yet — setting a chapter
// label, note, or toggling "planned writing day" ahead of time — use
// planDay() below instead.

async function logProgress(userId, planId, data) {
  const { countLogged, note, chapterLabel, logDate, direction, dictionaryEntries, bonusGoalOptIn, timeSpent } = data;

  if (timeSpent !== undefined && timeSpent !== null && (typeof timeSpent !== "number" || timeSpent < 0))
    throw new Error("Time spent must be a positive number of minutes");

  if (typeof countLogged !== "number" || countLogged < 1)
    throw new Error("Count logged must be a positive number");

  // "replace" (default) sets today's count to exactly countLogged,
  // overwriting whatever was already logged today. "add" stacks countLogged
  // on top of today's existing count instead; "remove" subtracts it — both
  // are opt-in via an explicit direction, for writers who want to build on
  // today's number rather than have a new entry replace it outright.
  const dir = direction === "add" ? "add" : direction === "remove" ? "remove" : "replace";

  const plan = await resolvePlan(userId, planId, {
    writingDays:  true,
    progressLogs: true,
  });
  if (plan.isCompleted && dir !== "remove") throw new Error("This draft has already been marked complete");

  // Sanity check for CHAPTERS/SCENES plans: a single day's count can never
  // exceed the whole book's target — you can't write more chapters in one
  // session than the entire draft has. WORDS plans skip this (a single big
  // session logging thousands of words is completely normal), but for
  // CHAPTERS/SCENES it almost always means a typo or a words count typed
  // into the wrong field, and left unchecked it quietly wrecks totalSoFar,
  // percentComplete, and avgPace (a single bad entry can make "average
  // chapters per session" read higher than the whole book has chapters).
  if ((plan.goalType === "CHAPTERS" || plan.goalType === "SCENES") && countLogged > plan.targetLength) {
    const unitWord = plan.goalType === "CHAPTERS" ? "chapters" : "scenes";
    throw new Error(
      `That's more ${unitWord} than your whole draft target (${plan.targetLength}). Double-check the number and try again.`
    );
  }

  const user       = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone   = user?.timezone ?? "UTC";

  // If the caller passed an explicit logDate, treat it as already meaningful
  // (e.g. backfilling a specific day) — otherwise resolve "today" in the
  // writer's own timezone, not the server's.
  const today      = logDate ? toMidnightUTC(logDate) : todayInTimezone(timezone);

  const existing   = await prisma.draftProgressLog.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });

  // isPickedDay for this date: honor an existing per-date override if one
  // was already set (e.g. via planDay()), otherwise fall back to the
  // recurring weekly pattern.
  const pickedDay  = existing ? existing.isPickedDay : isRecurringPickedDay(today, plan.writingDays);

  // Running total — subtract existing today log if re-logging
  const totalLogged    = plan.progressLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const prevToday       = existing?.countLogged ?? 0;
  let newTodayCount;
  if (dir === "add") {
    newTodayCount = prevToday + countLogged;
  } else if (dir === "remove") {
    // Today's stored count can itself go negative (a pure correction day),
    // but the overall project total never drops below 0 (handled below).
    newTodayCount = prevToday - countLogged;
  } else {
    // replace — the new entry stands on its own, ignoring whatever was
    // logged for today before.
    newTodayCount = countLogged;
  }
  const newTotal        = Math.max(plan.wordsWrittenSoFar + totalLogged - prevToday + newTodayCount, 0);

  // metGoal applies any day the daily goal amount is hit — picked writing
  // day OR a bonus day — as long as it's a real addition, not a removal.
  // A replaced entry counts here too: if the number the writer just set for
  // today clears the bar, that's still a goal-met day.
  const metGoal    = dir !== "remove" && newTodayCount >= plan.dailyGoal;
  const isDraftDone = newTotal >= plan.targetLength;

  const log = await prisma.draftProgressLog.upsert({
    where:  { planId_logDate: { planId: plan.id, logDate: today } },
    create: {
      planId:       plan.id,
      userId,
      logDate:      today,
      countLogged:  newTodayCount,
      isPickedDay:  pickedDay,
      isBonusDayGoalOptIn: bonusGoalOptIn === true,
      metDailyGoal: metGoal,
      totalSoFar:   newTotal,
      chapterLabel: chapterLabel?.trim() || null,
      note:         note?.trim() || null,
      timeSpent:    timeSpent ?? null,
    },
    update: {
      countLogged:  newTodayCount,
      isPickedDay:  pickedDay,
      metDailyGoal: metGoal,
      totalSoFar:   newTotal,
      // Only touch chapterLabel/note/isBonusDayGoalOptIn/timeSpent when the
      // caller actually sent one — otherwise a plain re-log (e.g. correcting
      // today's word count) would silently wipe out a note, chapter label,
      // logged time, or the "stuck with regular goal" opt-in set earlier via
      // planDay() or an earlier log call.
      ...(chapterLabel  !== undefined && { chapterLabel: chapterLabel?.trim() || null }),
      ...(note          !== undefined && { note:         note?.trim() || null }),
      ...(bonusGoalOptIn !== undefined && { isBonusDayGoalOptIn: bonusGoalOptIn === true }),
      ...(timeSpent      !== undefined && { timeSpent:    timeSpent ?? null }),
    },
  });

  // Workspace activity tracking — mirrors this day's countLogged (not a
  // delta), same idempotent convention as DraftProgressLog itself. This is
  // one of the two streak-eligible sources (the other is sprints).
  await recordLogActivity(userId, today, plan.goalType, newTodayCount);

  // Captured before either DB write below, so these reflect a genuine
  // *transition* this call caused — not just "is the plan currently done/
  // past halfway", which would otherwise be true on every subsequent log
  // and re-fire the "finished!"/"halfway!" follower notifications forever.
  const justCompleted = isDraftDone && !plan.isCompleted;
  const justReachedHalfway = dir !== "remove"
    && !plan.halfwayNotifiedAt
    && newTotal >= plan.targetLength / 2;

  if (isDraftDone && !plan.isCompleted) {
    await prisma.draftPlan.update({
      where: { id: plan.id },
      data:  { isCompleted: true, completedAt: new Date() },
    });
  }

  if (!isDraftDone && plan.isCompleted) {
    await prisma.draftPlan.update({
      where: { id: plan.id },
      data:  { isCompleted: false, completedAt: null },
    });
  }

  if (justReachedHalfway) {
    await prisma.draftPlan.update({
      where: { id: plan.id },
      data:  { halfwayNotifiedAt: new Date() },
    });
  }

  // Weekly goal check — every logged day counts now, picked or bonus,
  // opted in or not. Logging in the normal "today's session" flow is
  // enough; isBonusDayGoalOptIn no longer gates this. Same rule
  // getPlanProgress's stats.weekTotal uses, so this response's
  // metWeeklyGoal always agrees with what the dashboard ring shows.
  const weekStart      = startOfWeekInTimezone(timezone);
  const allLogs        = await prisma.draftProgressLog.findMany({
    where: { planId: plan.id, logDate: { gte: weekStart } },
  });
  const weekTotal      = allLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const metWeeklyGoal  = weekTotal >= plan.weeklyGoal;

  // ── Dictionary entries (optional) ─────────────────────────────────────
  // A writer often coins a new word/term mid-session — let them save it to
  // their dictionary in the same call instead of a separate trip. A bad or
  // duplicate word never fails the progress log itself; it's just skipped
  // and reported back so the frontend can flag it.
  const dictionary = { added: [], skipped: [] };
  if (Array.isArray(dictionaryEntries)) {
    for (const entry of dictionaryEntries) {
      try {
        const saved = await dictionaryService.addEntry(userId, entry);
        dictionary.added.push(saved);
      } catch (err) {
        dictionary.skipped.push({ word: entry?.word, reason: err.message });
      }
    }
  }

  return {
    log,
    direction: dir,
    isDraftDone,
    justCompleted,
    justReachedHalfway,
    isPickedDay: pickedDay,
    metDailyGoal: metGoal,
    metWeeklyGoal,
    newTotal,
    dictionary,
    plan: {
      id:          plan.id,
      userId:      plan.userId,
      storyTitle:  plan.storyTitle,
      targetLength: plan.targetLength,
      goalType:    plan.goalType,
    },
  };
}

// ─── BONUS QUEST (opt-in alternative to a normal log, off-days only) ──────────
// See DraftBonusQuest in schema.prisma for the full design rationale. Three
// entry points, mirroring the shape of logProgress/getMyPlan but scoped to
// the quest table instead of DraftProgressLog:
//   - openBonusQuest        → "spin the wheel" / open the mystery chest
//   - getTodaysBonusQuest   → read-only check, doesn't create anything
//   - logBonusQuestProgress → log words toward the day's quest

// Picks the two candidate BonusQuestPrompt rows to offer for a questType —
// the two lowest orderIndex prompts this plan hasn't PICKED yet (see
// DraftBonusQuestProgress.usedOrderIndexes doc comment in schema.prisma). A
// prompt that's been offered and passed over stays eligible; only a prompt
// that was actually chosen gets excluded. Must run inside the same
// transaction openBonusQuest uses, so a near-simultaneous double-tap can't
// read the same used-list twice and hand out the same pair.
async function pickCandidates(tx, planId, questType) {
  const totalForType = await tx.bonusQuestPrompt.count({ where: { questType } });
  if (totalForType === 0) {
    throw new Error(
      `No Bonus Quest prompts have been seeded for ${questType} yet — run the seed file first.`
    );
  }

  const progress = await tx.draftBonusQuestProgress.upsert({
    where:  { planId_questType: { planId, questType } },
    create: { planId, questType, usedOrderIndexes: [] },
    update: {},
  });

  const usedSet = new Set(progress.usedOrderIndexes);
  let pool = await tx.bonusQuestPrompt.findMany({
    where:   { questType, orderIndex: { notIn: [...usedSet] } },
    orderBy: { orderIndex: "asc" },
  });

  // Fewer than 2 left unused means the list's effectively been worked
  // through — reset and offer from the top again, same wrap-around the old
  // single-cursor version had.
  if (pool.length < 2) {
    if (totalForType < 2) {
      // Only one prompt exists for this type, period — nothing to choose
      // between. Offer it as both candidates so the pick step still works;
      // either button the writer taps resolves to the same prompt.
      pool = await tx.bonusQuestPrompt.findMany({ where: { questType }, orderBy: { orderIndex: "asc" } });
      return [pool[0], pool[0]];
    }
    await tx.draftBonusQuestProgress.update({
      where: { planId_questType: { planId, questType } },
      data:  { usedOrderIndexes: [] },
    });
    pool = await tx.bonusQuestPrompt.findMany({ where: { questType }, orderBy: { orderIndex: "asc" } });
  }

  return [pool[0], pool[1]];
}

// Opens (or re-fetches) today's Bonus Quest. Idempotent on purpose — opening
// the chest twice in one day returns the SAME quest (same two candidates)
// rather than rerolling, so a writer can't spin until the type/candidates
// they like show up. The quest starts in CHOOSING status — see
// pickBonusQuestPrompt for the step that actually assigns a prompt.
async function openBonusQuest(userId, planId, data = {}) {
  const plan = await resolvePlan(userId, planId, { writingDays: true });
  if (plan.isCompleted) throw new Error("This draft has already been marked complete");

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = data.logDate ? toMidnightUTC(data.logDate) : todayInTimezone(timezone);

  // A Bonus Quest only makes sense on a day that ISN'T already one of the
  // writer's planned writing days — same isPickedDay resolution logProgress
  // uses: honor a per-date override if one exists, otherwise fall back to
  // the recurring weekly pattern.
  const existingProgressLog = await prisma.draftProgressLog.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  const pickedDay = existingProgressLog
    ? existingProgressLog.isPickedDay
    : isRecurringPickedDay(today, plan.writingDays);

  if (pickedDay) {
    throw new Error(
      "Today's already one of your planned writing days — Bonus Quests are for the days you show up unplanned."
    );
  }

  const existingQuest = await prisma.draftBonusQuest.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  if (existingQuest) return existingQuest;

  const questType = pickRandomQuestType();

  // Everything below runs in one transaction so two near-simultaneous
  // "open the chest" calls (e.g. a double-tap) can't both read the same
  // used-list and hand out the same candidate pair twice.
  return prisma.$transaction(async (tx) => {
    const [candidateA, candidateB] = await pickCandidates(tx, plan.id, questType);

    return tx.draftBonusQuest.create({
      data: {
        planId:  plan.id,
        userId,
        logDate: today,
        questType,
        status:  "CHOOSING",
        candidateAOrderIndex:  candidateA.orderIndex,
        candidateAPrompt:      candidateA.prompt,
        candidateATargetCount: candidateA.targetCount,
        candidateBOrderIndex:  candidateB.orderIndex,
        candidateBPrompt:      candidateB.prompt,
        candidateBTargetCount: candidateB.targetCount,
      },
    });
  });
}

// Locks in whichever candidate the writer tapped. Idempotent the same way
// openBonusQuest is: picking again once a quest is already ACTIVE just
// returns it unchanged rather than erroring, so a double-tap on the pick
// button can't double-count the chosen index in usedOrderIndexes.
async function pickBonusQuestPrompt(userId, planId, data = {}) {
  const { choice } = data; // "A" | "B"
  if (choice !== "A" && choice !== "B") throw new Error("Choice must be 'A' or 'B'");

  const plan = await resolvePlan(userId, planId);

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = data.logDate ? toMidnightUTC(data.logDate) : todayInTimezone(timezone);

  const quest = await prisma.draftBonusQuest.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  if (!quest) throw new Error("Bonus quest not found for today — open the mystery chest first.");
  if (quest.status === "ACTIVE") return quest; // already picked — idempotent

  const orderIndex  = choice === "A" ? quest.candidateAOrderIndex  : quest.candidateBOrderIndex;
  const promptText  = choice === "A" ? quest.candidateAPrompt      : quest.candidateBPrompt;
  const targetCount = choice === "A" ? quest.candidateATargetCount : quest.candidateBTargetCount;

  return prisma.$transaction(async (tx) => {
    // Only the CHOSEN candidate ever gets marked used — the one passed over
    // stays eligible for a future spin (see pickCandidates doc comment).
    const progress = await tx.draftBonusQuestProgress.findUnique({
      where: { planId_questType: { planId: plan.id, questType: quest.questType } },
    });
    const usedOrderIndexes = [...new Set([...(progress?.usedOrderIndexes ?? []), orderIndex])];
    await tx.draftBonusQuestProgress.upsert({
      where:  { planId_questType: { planId: plan.id, questType: quest.questType } },
      create: { planId: plan.id, questType: quest.questType, usedOrderIndexes },
      update: { usedOrderIndexes },
    });

    return tx.draftBonusQuest.update({
      where: { id: quest.id },
      data: {
        status:           "ACTIVE",
        promptOrderIndex: orderIndex,
        prompt:           promptText,
        targetCount,
      },
    });
  });
}

// Read-only — returns today's quest if one has already been opened, or null
// if the chest hasn't been opened yet (or today isn't a bonus day at all,
// which the frontend already knows from getPlanProgress/getPlanTimeline).
async function getTodaysBonusQuest(userId, planId) {
  const plan = await resolvePlan(userId, planId);

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = todayInTimezone(timezone);

  return prisma.draftBonusQuest.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
}

// Logs words toward today's quest. Same replace/add/remove direction
// convention as logProgress, but writes to DraftBonusQuest.countLogged
// instead of DraftProgressLog — this NEVER touches plan.wordsWrittenSoFar/
// totalSoFar/targetLength. It still records to DailyWritingActivity (via
// recordBonusQuestActivity) so the day counts toward streaks and "wrote
// today", just under its own field, kept separate from real story words.
async function logBonusQuestProgress(userId, planId, data) {
  const { countLogged, logDate, direction, note, timeSpent } = data;

  if (typeof countLogged !== "number" || countLogged < 1)
    throw new Error("Count logged must be a positive number");
  if (timeSpent !== undefined && timeSpent !== null && (typeof timeSpent !== "number" || timeSpent < 0))
    throw new Error("Time spent must be a positive number of minutes");

  const dir = direction === "add" ? "add" : direction === "remove" ? "remove" : "replace";

  const plan = await resolvePlan(userId, planId);

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = logDate ? toMidnightUTC(logDate) : todayInTimezone(timezone);

  const quest = await prisma.draftBonusQuest.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  if (!quest) throw new Error("Bonus quest not found for today — open the mystery chest first.");
  if (quest.status !== "ACTIVE") throw new Error("Pick one of today's two prompts before logging words toward it.");

  const prevCount = quest.countLogged;
  let newCount;
  if (dir === "add") {
    newCount = prevCount + countLogged;
  } else if (dir === "remove") {
    newCount = Math.max(prevCount - countLogged, 0);
  } else {
    newCount = countLogged;
  }

  const isCompleted = newCount >= quest.targetCount;

  const updated = await prisma.draftBonusQuest.update({
    where: { id: quest.id },
    data: {
      countLogged: newCount,
      isCompleted,
      // Keep the original completedAt if it was already completed and the
      // writer just added more words on top — only clear it if a "remove"
      // has dropped them back below target.
      completedAt: isCompleted ? (quest.completedAt ?? new Date()) : null,
      // Only touch note/timeSpent when the caller actually sent one — a
      // plain word-count top-up shouldn't wipe out a note left on an
      // earlier log call for the same quest.
      ...(note      !== undefined && { note:      note?.trim() || null }),
      ...(timeSpent !== undefined && { timeSpent: timeSpent ?? null }),
    },
  });

  await recordBonusQuestActivity(userId, today, newCount);

  return {
    quest: updated,
    direction: dir,
    isCompleted,
  };
}

// Declines both of today's candidates. Terminal for the day — since the
// quest row is unique per plan+date, this just parks status at DECLINED
// and there's nothing left to spin; the next bonus day opens a fresh row.
// Idempotent like its siblings: declining an already-DECLINED quest just
// returns it. Declining an ACTIVE quest (already picked) is rejected —
// once a prompt is locked in, backing out of it isn't "declining", it's
// just... not logging words toward it.
async function declineBonusQuest(userId, planId, data = {}) {
  const plan = await resolvePlan(userId, planId);

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = data.logDate ? toMidnightUTC(data.logDate) : todayInTimezone(timezone);

  const quest = await prisma.draftBonusQuest.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  if (!quest) throw new Error("Bonus quest not found for today — open the mystery chest first.");
  if (quest.status === "DECLINED") return quest; // already declined — idempotent
  if (quest.status === "ACTIVE")
    throw new Error("You've already picked a prompt for today's quest.");

  return prisma.draftBonusQuest.update({
    where: { id: quest.id },
    data: { status: "DECLINED", declinedAt: new Date() },
  });
}

// ─── DAY PLANNING (pre-plan a date ahead of writing it) ───────────────────────
// Upserts a DraftProgressLog row for chapter/task + note + the per-date
// "planned writing day" toggle, WITHOUT requiring any words to be logged
// yet. This is what the timeline's day editor calls when a writer taps a
// future date and names the chapter they intend to write, or manually
// marks/unmarks that specific date as a planned writing day. If the date
// already has a logged session, its countLogged/metDailyGoal/totalSoFar are
// left untouched — only chapterLabel, note, and isPickedDay are updated.

async function planDay(userId, planId, data) {
  const { logDate, chapterLabel, note, isPickedDay: pickedOverride, isBonusDayGoalOptIn } = data;
  if (!logDate) throw new Error("logDate is required");

  const plan = await resolvePlan(userId, planId, { writingDays: true });

  const date = toMidnightUTC(logDate);
  const recurringPicked = isRecurringPickedDay(date, plan.writingDays);
  const pickedFlag = typeof pickedOverride === "boolean" ? pickedOverride : recurringPicked;

  const existing = await prisma.draftProgressLog.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: date } },
  });

  let totalSoFar = existing?.totalSoFar;
  if (totalSoFar === undefined) {
    const totalLogged = await prisma.draftProgressLog.aggregate({
      where: { planId: plan.id },
      _sum:  { countLogged: true },
    });
    totalSoFar = plan.wordsWrittenSoFar + (totalLogged._sum.countLogged ?? 0);
  }

  const entry = await prisma.draftProgressLog.upsert({
    where: { planId_logDate: { planId: plan.id, logDate: date } },
    create: {
      planId:       plan.id,
      userId,
      logDate:      date,
      countLogged:  0,
      isPickedDay:  pickedFlag,
      isBonusDayGoalOptIn: isBonusDayGoalOptIn === true,
      metDailyGoal: false,
      totalSoFar,
      chapterLabel: chapterLabel?.trim() || null,
      note:         note?.trim() || null,
    },
    update: {
      isPickedDay: pickedFlag,
      ...(chapterLabel !== undefined && { chapterLabel: chapterLabel?.trim() || null }),
      ...(note !== undefined && { note: note?.trim() || null }),
      ...(isBonusDayGoalOptIn !== undefined && { isBonusDayGoalOptIn: isBonusDayGoalOptIn === true }),
    },
  });

  return entry;
}

// Full plan + computed stats for the plan page
async function getPlanProgress(userId, planId) {
  const plan = await resolvePlan(userId, planId, {
    writingDays:  true,
    progressLogs: { orderBy: { logDate: "asc" } },
    bonusQuests:  { orderBy: { logDate: "asc" } },
  });

  const user      = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone  = user?.timezone ?? "UTC";

  // Bonus Quest stats — deliberately separate from totalSoFar/percentComplete
  // above (quest words never touch story math). bonusQuestsCompleted is what
  // the "bonus day, target met" framing on the timeline/graph is counting.
  const bonusQuestsTotal     = plan.bonusQuests.length;
  const bonusQuestsCompleted = plan.bonusQuests.filter((q) => q.isCompleted).length;

  const totalLogged       = plan.progressLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const totalSoFar        = plan.wordsWrittenSoFar + totalLogged;
  const remaining         = Math.max(plan.targetLength - totalSoFar, 0);
  // daysLogged = any day with a log row that has real words (countLogged>0).
  // sessionsDone = a real completed session: a picked writing day where the
  // daily goal was actually hit. This is what "sessions done" means
  // wherever it's shown in the UI — daysLogged is kept for anything that
  // still wants the raw "logged on X days" count.
  const daysLogged        = plan.progressLogs.filter((l) => l.countLogged > 0).length;
  // A "completed session" is any day the daily goal was actually hit —
  // picked writing day or bonus day alike. This used to require
  // isBonusDayGoalOptIn on a bonus day; that gate's gone now, so logging a
  // real session through the normal "today's session" flow always counts,
  // opted in or not.
  const countsAsSession    = (l) => l.metDailyGoal;
  const sessionsDone      = plan.progressLogs.filter(countsAsSession).length;
  const daysMetGoal       = sessionsDone; // kept as an alias for backward compatibility
  // Guard against a missing/zero dailyGoal so this never silently reads as
  // "0 sessions left" (which looks like "done") when the goal just wasn't set.
  const sessionsLeft      = plan.dailyGoal > 0 ? Math.ceil(remaining / plan.dailyGoal) : null;
  const weeksLeft         = plan.writingDays.length > 0
    ? Math.ceil((sessionsLeft ?? 0) / plan.writingDays.length)
    : (sessionsLeft ?? 0);
  const percentComplete   = plan.targetLength > 0
    ? Math.min(Math.round((totalSoFar / plan.targetLength) * 100), 100)
    : 0;

  // sessionsTotal — the original estimated number of writing sessions for
  // the whole project, e.g. "26 completed / 48 total". Deliberately
  // recomputed from the plan's ORIGINAL wordsWrittenSoFar/targetLength/
  // dailyGoal/writingDays (not the live totalSoFar), so it stays a stable
  // target that only moves if the writer actually edits the plan via
  // updatePlan — not every time they log progress.
  const { estimatedSessions: sessionsTotal } = calcDerivedFields(
    plan.targetLength,
    plan.wordsWrittenSoFar,
    plan.dailyGoal,
    plan.writingDays.length
  );

  // avgPace — average words (or chapters/scenes) per completed session,
  // e.g. "1,478 words / session". Summed from ONLY the log rows that
  // actually count as a completed session (isPickedDay && metDailyGoal,
  // same rows sessionsDone counts) — not the plan-wide totalLogged, which
  // also includes negative "remove" correction entries (see
  // draftPlanController's `direction !== "remove"` check). Mixing those
  // corrections into this average could drag it below zero even though no
  // single session was ever negative, e.g. "-1 chapters / session".
  const completedSessionTotal = plan.progressLogs
    .filter(countsAsSession)
    .reduce((acc, l) => acc + Math.max(l.countLogged, 0), 0);
  const avgPace = sessionsDone > 0 ? Math.max(Math.round(completedSessionTotal / sessionsDone), 0) : 0;

  // This week's progress — every logged day counts toward the weekly goal
  // now, picked or bonus, opted in or not: as long as the writer logged
  // real progress in today's session it counts. "This week" is anchored
  // to the writer's own timezone.
  const weekStart         = startOfWeekInTimezone(timezone);
  const weekLogs          = plan.progressLogs.filter((l) => new Date(l.logDate) >= weekStart);
  const weekTotal         = weekLogs.reduce((acc, l) => acc + l.countLogged, 0);
  // weekDaysActive — how many of this week's picked writing days actually
  // have logged progress so far, e.g. "4 of 5" days active this week.
  const weekDaysActive    = weekLogs.filter((l) => l.countLogged > 0).length;

  // bestDay — the single highest-output day so far THIS WEEK, across ALL of
  // this week's logs (picked days and bonus days alike — same set
  // weekTotal/weekDaysActive now draw from). Kept as its own pass since
  // it's asking a different question ("which day had the most words") than
  // a goal-progress sum. null when nothing's been logged yet this week.
  const weekLogsForBestDay = plan.progressLogs.filter((l) => new Date(l.logDate) >= weekStart);
  const bestDayLog = weekLogsForBestDay.reduce(
    (best, l) => (l.countLogged > (best?.countLogged ?? 0) ? l : best),
    null
  );
  const bestDay = bestDayLog && bestDayLog.countLogged > 0
    ? {
        date:        bestDayLog.logDate,
        countLogged: bestDayLog.countLogged,
        weekday:     JS_TO_WEEKDAY_ENUM[new Date(bestDayLog.logDate).getUTCDay()],
      }
    : null;

  return {
    plan,
    stats: {
      totalSoFar,
      remaining,
      daysLogged,
      sessionsDone,
      sessionsTotal,
      avgPace,
      daysMetGoal,
      sessionsLeft,
      weeksLeft,
      percentComplete,
      weekTotal,
      weekDaysActive,
      weeklyGoal: plan.weeklyGoal,
      bonusQuestsTotal,
      bonusQuestsCompleted,
      bestDay,
    },
  };
}

// ─── PLAN-SCOPED HISTORY (7/15/30 days) ───────────────────────────────────────
// Same 7/15/30-day bucketing as the workspace-wide history, but scoped ONLY
// to this plan's own DraftProgressLog rows — no sprint or plain-draft-edit
// data folded in. A plan only ever has one goalType, so this returns a
// single number series rather than a words/chapters/scenes breakdown.

async function getPlanHistory(userId, planId) {
  const plan = await resolvePlan(userId, planId);

  const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone = user?.timezone ?? "UTC";
  const today    = todayInTimezone(timezone);

  const windowStart = new Date(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - 29);

  const logs = await prisma.draftProgressLog.findMany({
    where:  { planId: plan.id, logDate: { gte: windowStart, lte: today } },
    select: { logDate: true, countLogged: true },
    orderBy: { logDate: "asc" },
  });

  // Bonus Quest words, same 30-day window — kept as its own series, never
  // folded into `logs`/its totals above, since quest words never touch
  // story math (same rule getPlanProgress's bonusQuestsTotal/
  // bonusQuestsCompleted follow). Only COMPLETED quests count here,
  // mirroring how a bonus day only reads "BONUS" on the timeline once the
  // quest actually hit its target (see getPlanTimeline) — an opened-but-
  // unfinished quest isn't "bonus day word count" yet.
  const bonusQuests = await prisma.draftBonusQuest.findMany({
    where:  { planId: plan.id, logDate: { gte: windowStart, lte: today }, isCompleted: true },
    select: { logDate: true, countLogged: true },
    orderBy: { logDate: "asc" },
  });

  function sumWindow(days) {
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
    const inWindow = logs.filter((l) => l.logDate >= cutoff);
    const total     = inWindow.reduce((a, l) => a + Math.max(l.countLogged, 0), 0);
    const daysLogged = inWindow.filter((l) => l.countLogged > 0).length;

    const bonusInWindow   = bonusQuests.filter((q) => q.logDate >= cutoff);
    const bonusTotal      = bonusInWindow.reduce((a, q) => a + Math.max(q.countLogged, 0), 0);
    const bonusDaysLogged = bonusInWindow.length;

    return { total, daysLogged, bonusTotal, bonusDaysLogged };
  }

  // Per-day breakdown across the whole 30-day window — the "second info"
  // for the graph: every date carries both its real story countLogged and
  // its bonusCountLogged (0 on any day with no completed quest), so a
  // frontend chart can show a day's bonus quest word count alongside its
  // story word count instead of only the story total.
  const logsByDate  = new Map(logs.map((l) => [toMidnightUTC(l.logDate).toISOString(), l.countLogged]));
  const bonusByDate = new Map(bonusQuests.map((q) => [toMidnightUTC(q.logDate).toISOString(), q.countLogged]));

  const daily = [];
  const cursor = new Date(windowStart);
  while (cursor <= today) {
    const key = cursor.toISOString();
    daily.push({
      date:             key,
      countLogged:      logsByDate.get(key) ?? 0,
      bonusCountLogged: bonusByDate.get(key) ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    goalType: plan.goalType,
    last7:  sumWindow(7),
    last15: sumWindow(15),
    last30: sumWindow(30),
    daily,
  };
}

// ─── TIMELINE ────────────────────────────────────────────────────────────────
// Builds a calendar-style view spanning from the month the plan was created
// to the month the draft is estimated to finish (plan.createdAt +
// plan.estimatedDays). Every day in that range is classified as:
//   - "DONE"    — a picked writing day where the writer actually wrote
//   - "BONUS"   — the writer wrote on a day that wasn't planned
//   - "MISSED"  — a planned writing day, already in the past, with no entry
//   - "PLANNED" — a planned writing day still in the future
//   - null      — not a writing day at all, nothing logged
// Each day also carries its chapterLabel/note/countLogged if a
// DraftProgressLog row exists for that date, so the frontend can render the
// per-day chapter/task + journal entry alongside the status marker.

function buildMonthGrid(year, monthIndex /* 0-based */) {
  const firstDay      = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth    = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const startWeekday  = firstDay.getUTCDay(); // 0=Sun

  const weeks = [];
  let week = new Array(startWeekday).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(new Date(Date.UTC(year, monthIndex, d)));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

async function getPlanTimeline(userId, planId) {
  const plan = await resolvePlan(userId, planId, {
    writingDays: true, progressLogs: true, bonusQuests: true,
  });

  const logsByDate = new Map(
    plan.progressLogs.map((l) => [toMidnightUTC(l.logDate).toISOString(), l])
  );
  const questsByDate = new Map(
    plan.bonusQuests.map((q) => [toMidnightUTC(q.logDate).toISOString(), q])
  );

  const startDate = toMidnightUTC(plan.createdAt);
  const estimatedFinishDate = new Date(startDate);
  estimatedFinishDate.setUTCDate(estimatedFinishDate.getUTCDate() + plan.estimatedDays);

  const today = toMidnightUTC(new Date());

  const months = [];
  let cursor    = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(estimatedFinishDate.getUTCFullYear(), estimatedFinishDate.getUTCMonth(), 1));

  while (cursor <= endCursor) {
    const year       = cursor.getUTCFullYear();
    const monthIndex = cursor.getUTCMonth();

    const weeks = buildMonthGrid(year, monthIndex).map((week) =>
      week.map((date) => {
        if (!date) return null;

        const key            = date.toISOString();
        const log            = logsByDate.get(key);
        const quest          = questsByDate.get(key);
        const recurringPicked = isRecurringPickedDay(date, plan.writingDays);

        let status         = null;
        let effectivePicked = recurringPicked;

        if (log) {
          effectivePicked = log.isPickedDay;
          if (log.countLogged > 0) {
            status = log.isPickedDay ? "DONE" : "BONUS";
          } else {
            status = date < today ? "MISSED" : "PLANNED";
          }
        } else if (quest && quest.isCompleted) {
          // No real progress log for this day, but the Bonus Quest hit its
          // target — same "showed up on an off day" story a real word-count
          // BONUS tells, just backed by quest progress instead of story
          // words. A quest that was opened but NOT completed intentionally
          // doesn't set a status here — only a finished quest counts as a
          // bonus day, same as logProgress only counting real additions.
          status = "BONUS";
        } else if (recurringPicked && date >= startDate) {
          // Only infer MISSED/PLANNED from the recurring weekly pattern for
          // dates on or after the plan's own creation date — see comment
          // above on why buildMonthGrid can hand us dates earlier than that.
          status = date < today ? "MISSED" : "PLANNED";
        }

        return {
          date:         key,
          isToday:      date.getTime() === today.getTime(),
          isPickedDay:  effectivePicked,
          status,                                   // DONE | BONUS | MISSED | PLANNED | null
          chapterLabel: log?.chapterLabel ?? null,
          note:         log?.note ?? null,
          countLogged:  log?.countLogged ?? 0,
          timeSpent:    log?.timeSpent ?? null,
          hasNote:      Boolean(log?.note) || Boolean(quest?.note),
          bonusQuest: quest
            ? {
                questType:   quest.questType,
                prompt:      quest.prompt,
                targetCount: quest.targetCount,
                countLogged: quest.countLogged,
                isCompleted: quest.isCompleted,
                note:        quest.note ?? null,
                timeSpent:   quest.timeSpent ?? null,
              }
            : null,
        };
      })
    );

    months.push({ year, month: monthIndex + 1, weeks });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return {
    storyTitle: plan.storyTitle,
    planStart: startDate,
    estimatedFinishDate,
    months,
  };
}

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────

async function getUserById(userId) {
  return prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, username: true, email: true },
  });
}

// ─── CRON HELPER — called by the reminder cron job ───────────────────────────
// Returns all writing day rows whose reminderTimeUTC matches the current
// HH:MM in UTC, so the cron can fire on the minute without timezone math.

async function getWritersToRemindNow() {
  const now   = new Date();
  const hh    = String(now.getUTCHours()).padStart(2, "0");
  const mm    = String(now.getUTCMinutes()).padStart(2, "0");
  const timeUTC = `${hh}:${mm}`;

  const todayEnum = JS_TO_WEEKDAY_ENUM[now.getUTCDay()];

  const rows = await prisma.draftWritingDay.findMany({
    where: {
      day:             todayEnum,
      reminderTimeUTC: timeUTC,
      plan: {
        isCompleted: false,
      },
    },
    include: {
      plan: {
        select: {
          id:         true,
          storyTitle: true,
          dailyGoal:  true,
          goalType:   true,
          userId:     true,
          user: { select: { id: true, username: true, email: true } },
        },
      },
    },
  });

  return rows.map((r) => ({
    user:       r.plan.user,
    storyTitle: r.plan.storyTitle,
    dailyGoal:  r.plan.dailyGoal,
    goalType:   r.plan.goalType,
    planId:     r.plan.id,
  }));
}

module.exports = {
  createPlan,
  getMyPlan,
  getMyPlans,
  getMostRecentlyActivePlan,
  updatePlan,
  deletePlan,
  logProgress,
  planDay,
  getPlanProgress,
  getPlanHistory,
  getPlanTimeline,
  openBonusQuest,
  pickBonusQuestPrompt,
  getTodaysBonusQuest,
  logBonusQuestProgress,
  declineBonusQuest,
  getUserById,
  getWritersToRemindNow,
};