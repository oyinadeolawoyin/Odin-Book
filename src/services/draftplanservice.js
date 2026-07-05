// src/services/draftPlanService.js
const prisma = require("../config/prismaClient");
const {
  toMidnightUTC,
  todayInTimezone,
  localTimeToUTC: localTimeToUTCReliable, // see note below on the rename
  startOfWeekInTimezone,
} = require("../utilis/timezone");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const WEEKDAY_JS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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
  return { estimatedDays, weeklyGoal };
}

// Check if a JS Date's UTC day matches one of the writer's WeekDay picks
function isPickedDay(date, writingDays) {
  const jsDay     = date.getUTCDay(); // 0=Sun, 1=Mon...
  const pickedSet = new Set(writingDays.map((d) => WEEKDAY_JS[d.day]));
  return pickedSet.has(jsDay);
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
    // Step 2
    whyFinish,
    whatItMeans,
    dailyTreat,
    weeklyTreat,
    inspirationSource,
    moodboardImages,   // string[] ≤5 URLs
    characters,        // [{ name, description }] ≤5
    // Step 3
    storyTitle,
    premise,
  } = data;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!storyTitle?.trim())          throw new Error("Story title is required");
  if (!premise?.trim())             throw new Error("Premise is required");
  if (!whyFinish?.trim())           throw new Error("Why you want to finish is required");
  if (!whatItMeans?.trim())         throw new Error("What finishing means to you is required");
  if (!dailyTreat?.trim())          throw new Error("Daily treat is required");
  if (!weeklyTreat?.trim())         throw new Error("Weekly treat is required");
  if (!inspirationSource?.trim())   throw new Error("Inspiration source is required");
  if (!goalType)                    throw new Error("Goal type is required");
  if (typeof dailyGoal !== "number" || dailyGoal < 1)
    throw new Error("Daily goal must be a positive number");
  if (typeof targetLength !== "number" || targetLength < 1)
    throw new Error("Target length must be a positive number");
  if (typeof wordsWrittenSoFar !== "number" || wordsWrittenSoFar < 0)
    throw new Error("Words written so far must be 0 or more");
  if (!Array.isArray(writingDays) || writingDays.length === 0)
    throw new Error("Pick at least one writing day");

  // Validate writing days shape
  const validDays = new Set(["MON","TUE","WED","THU","FRI","SAT","SUN"]);
  for (const wd of writingDays) {
    if (!validDays.has(wd.day))
      throw new Error(`Invalid day: ${wd.day}`);
    if (!wd.reminderTime || !/^\d{2}:\d{2}$/.test(wd.reminderTime))
      throw new Error(`Reminder time for ${wd.day} must be in HH:MM format`);
  }

  // Character validation — max 5, description ≤50 chars
  const chars = Array.isArray(characters) ? characters.slice(0, 5) : [];
  for (const c of chars) {
    if (!c.name?.trim()) throw new Error("Each character must have a name");
    if (c.description && c.description.length > 50)
      throw new Error(`Character description for "${c.name}" must be 50 characters or fewer`);
  }

  const images = Array.isArray(moodboardImages) ? moodboardImages.slice(0, 5) : [];

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
  // Wrapped in try/catch: this is reached from the guest-signup → create-
  // plan flow too (see draftPlanWizard.jsx's handleSignedUp), so it's
  // possible for a userId to already have a plan row by the time this runs
  // (double-submit, duplicate tab, retry after a slow response, etc).
  // Without this, Prisma's raw "Unique constraint failed on the fields:
  // (`userId`)" error leaks straight to the UI (see screenshot). We catch
  // that specific case (P2002 on userId) and turn it into a clean,
  // recognizable message the frontend can branch on to redirect to the
  // existing plan instead of showing a dead-end error.
  let plan;
  try {
    plan = await prisma.draftPlan.create({
      data: {
        userId,
        storyTitle:        storyTitle.trim(),
        premise:           premise.trim(),
        wordsWrittenSoFar,
        targetLength,
        goalType,
        dailyGoal,
        weeklyGoal,
        estimatedDays,
        whyFinish:         whyFinish.trim(),
        whatItMeans:       whatItMeans.trim(),
        dailyTreat:        dailyTreat.trim(),
        weeklyTreat:       weeklyTreat.trim(),
        inspirationSource: inspirationSource.trim(),
        moodboardImages:   images,
        writingDays: {
          create: writingDays.map((wd) => ({
            day:             wd.day,
            reminderTime:    wd.reminderTime,
            reminderTimeUTC: localTimeToUTCReliable(wd.reminderTime, timezone),
          })),
        },
        characters: {
          create: chars.map((c) => ({
            name:        c.name.trim(),
            description: c.description?.trim() ?? "",
          })),
        },
      },
      include: {
        writingDays:  true,
        characters:   true,
        progressLogs: true,
      },
    });
  } catch (err) {
    if (err.code === "P2002" && err.meta?.target?.includes("userId")) {
      throw new Error("You already have a draft plan.");
    }
    throw err;
  }

  return plan;
}

async function getMyPlan(userId) {
  const plan = await prisma.draftPlan.findUnique({
    where:   { userId },
    include: {
      writingDays:  true,
      characters:   true,
      progressLogs: { orderBy: { logDate: "desc" } },
    },
  });
  if (!plan) throw new Error("Draft plan not found");
  return plan;
}

async function updatePlan(userId, data) {
  const plan = await prisma.draftPlan.findUnique({
    where:   { userId },
    include: { writingDays: true },
  });
  if (!plan) throw new Error("Draft plan not found");

  const {
    storyTitle, premise, whyFinish, whatItMeans,
    dailyTreat, weeklyTreat, inspirationSource,
    moodboardImages, characters, dailyGoal, writingDays,
    targetLength, wordsWrittenSoFar,
  } = data;

  if (characters) {
    const chars = Array.isArray(characters) ? characters.slice(0, 5) : [];
    for (const c of chars) {
      if (!c.name?.trim()) throw new Error("Each character must have a name");
      if (c.description && c.description.length > 50)
        throw new Error(`Character description for "${c.name}" must be 50 characters or fewer`);
    }
  }

  // Validate the new goal-math fields, same rules as plan creation.
  if (targetLength !== undefined) {
    if (typeof targetLength !== "number" || targetLength < 1)
      throw new Error("Target length must be a positive number");
  }
  if (wordsWrittenSoFar !== undefined) {
    if (typeof wordsWrittenSoFar !== "number" || wordsWrittenSoFar < 0)
      throw new Error("Words written so far must be 0 or more");
  }

  // Recalculate derived fields whenever any input to that math changed —
  // dailyGoal/writingDays (existing behavior), or the new editable
  // targetLength/wordsWrittenSoFar fields. All four feed the same formula,
  // so any one of them changing means estimatedDays/weeklyGoal are stale.
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

  if (characters) {
    await prisma.draftPlanCharacter.deleteMany({ where: { planId: plan.id } });
    await prisma.draftPlanCharacter.createMany({
      data: characters.slice(0, 5).map((c) => ({
        planId:      plan.id,
        name:        c.name.trim(),
        description: c.description?.trim() ?? "",
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
      ...(whatItMeans        !== undefined && { whatItMeans:       whatItMeans.trim() }),
      ...(dailyTreat         !== undefined && { dailyTreat:        dailyTreat.trim() }),
      ...(weeklyTreat        !== undefined && { weeklyTreat:       weeklyTreat.trim() }),
      ...(inspirationSource  !== undefined && { inspirationSource: inspirationSource.trim() }),
      ...(moodboardImages    !== undefined && { moodboardImages:   moodboardImages.slice(0, 5) }),
      ...(dailyGoal          !== undefined && { dailyGoal }),
      ...(targetLength       !== undefined && { targetLength }),
      ...(wordsWrittenSoFar  !== undefined && { wordsWrittenSoFar }),
      ...recalcFields,
      ...completionFields,
    },
    include: {
      writingDays:  true,
      characters:   true,
      progressLogs: { orderBy: { logDate: "desc" } },
    },
  });

  return updated;
}

async function deletePlan(userId) {
  const plan = await prisma.draftPlan.findUnique({ where: { userId } });
  if (!plan) throw new Error("Draft plan not found");
  await prisma.draftPlan.delete({ where: { id: plan.id } });
  return { message: "Draft plan deleted" };
}

// ─── PROGRESS LOGGING ────────────────────────────────────────────────────────

async function logProgress(userId, data) {
  const { countLogged, note, logDate, direction } = data;

  if (typeof countLogged !== "number" || countLogged < 1)
    throw new Error("Count logged must be a positive number");

  // "add" (default) increases the project total by countLogged.
  // "remove" decreases it instead — for correcting an earlier over-count.
  const dir = direction === "remove" ? "remove" : "add";

  const plan = await prisma.draftPlan.findUnique({
    where:   { userId },
    include: {
      writingDays:  true,
      progressLogs: true,
    },
  });
  if (!plan)            throw new Error("Draft plan not found");
  if (plan.isCompleted && dir !== "remove") throw new Error("This draft has already been marked complete");

  const user       = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone   = user?.timezone ?? "UTC";

  // If the caller passed an explicit logDate, treat it as already meaningful
  // (e.g. backfilling a specific day) — otherwise resolve "today" in the
  // writer's own timezone, not the server's.
  const today      = logDate ? toMidnightUTC(logDate) : todayInTimezone(timezone);
  const pickedDay  = isPickedDay(today, plan.writingDays);

  // Running total — subtract existing today log if re-logging
  const existing   = await prisma.draftProgressLog.findUnique({
    where: { planId_logDate: { planId: plan.id, logDate: today } },
  });
  const totalLogged    = plan.progressLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const prevToday       = existing?.countLogged ?? 0;
  const signedCount     = dir === "remove" ? -countLogged : countLogged;
  // Today's stored count can itself go negative (a pure correction day),
  // but the overall project total never drops below 0.
  const newTodayCount   = prevToday + signedCount;
  const newTotal        = Math.max(plan.wordsWrittenSoFar + totalLogged - prevToday + newTodayCount, 0);

  // metGoal applies any day the daily goal amount is hit — picked writing
  // day OR a bonus day — as long as it's a real addition (not a removal).
  // A bonus day still deserves the same "go treat yourself" moment.
  const metGoal    = dir === "add" && newTodayCount >= plan.dailyGoal;
  const isDraftDone = newTotal >= plan.targetLength;

  const log = await prisma.draftProgressLog.upsert({
    where:  { planId_logDate: { planId: plan.id, logDate: today } },
    create: {
      planId:       plan.id,
      userId,
      logDate:      today,
      countLogged:  newTodayCount,
      isPickedDay:  pickedDay,
      metDailyGoal: metGoal,
      totalSoFar:   newTotal,
      note:         note?.trim() ?? null,
    },
    update: {
      countLogged:  newTodayCount,
      isPickedDay:  pickedDay,
      metDailyGoal: metGoal,
      totalSoFar:   newTotal,
      note:         note?.trim() ?? null,
    },
  });

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

  // Weekly goal check — only count picked-day logs from this week, in the
  // writer's own timezone
  const weekStart      = startOfWeekInTimezone(timezone);
  const allLogs        = await prisma.draftProgressLog.findMany({
    where: { planId: plan.id, logDate: { gte: weekStart } },
  });
  const weekTotal      = allLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const metWeeklyGoal  = weekTotal >= plan.weeklyGoal;

  return {
    log,
    direction: dir,
    isDraftDone,
    isPickedDay: pickedDay,
    metDailyGoal: metGoal,
    metWeeklyGoal,
    newTotal,
    dailyTreat:  metGoal        ? plan.dailyTreat  : null,
    weeklyTreat: metWeeklyGoal  ? plan.weeklyTreat : null,
    plan: {
      id:          plan.id,
      userId:      plan.userId,
      storyTitle:  plan.storyTitle,
      targetLength: plan.targetLength,
      goalType:    plan.goalType,
    },
  };
}

// Full plan + computed stats for the plan page
async function getPlanProgress(userId) {
  const plan = await prisma.draftPlan.findUnique({
    where:   { userId },
    include: {
      writingDays:  true,
      characters:   true,
      progressLogs: { orderBy: { logDate: "asc" } },
    },
  });
  if (!plan) throw new Error("Draft plan not found");

  const user      = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  const timezone  = user?.timezone ?? "UTC";

  const totalLogged       = plan.progressLogs.reduce((acc, l) => acc + l.countLogged, 0);
  const totalSoFar        = plan.wordsWrittenSoFar + totalLogged;
  const remaining         = Math.max(plan.targetLength - totalSoFar, 0);
  // daysLogged = any day with a log row at all (picked or bonus).
  // sessionsDone = a real completed session: a picked writing day where the
  // daily goal was actually hit. This is what "sessions done" means
  // wherever it's shown in the UI — daysLogged is kept for anything that
  // still wants the raw "logged on X days" count.
  const daysLogged        = plan.progressLogs.length;
  const sessionsDone      = plan.progressLogs.filter((l) => l.isPickedDay && l.metDailyGoal).length;
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

  // This week's progress — only picked days count toward weekly goal,
  // "this week" is anchored to the writer's own timezone
  const weekStart         = startOfWeekInTimezone(timezone);
  const weekLogs          = plan.progressLogs.filter(
    (l) => new Date(l.logDate) >= weekStart && l.isPickedDay
  );
  const weekTotal         = weekLogs.reduce((acc, l) => acc + l.countLogged, 0);

  return {
    plan,
    stats: {
      totalSoFar,
      remaining,
      daysLogged,
      sessionsDone,
      daysMetGoal,
      sessionsLeft,
      weeksLeft,
      percentComplete,
      weekTotal,
      weeklyGoal: plan.weeklyGoal,
    },
  };
}

// ─── COMMUNITY FEED ──────────────────────────────────────────────────────────

async function getActiveDraftWriters(requestingUserId) {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  const plans = await prisma.draftPlan.findMany({
    where: {
      OR: [
        { isCompleted: false },
        { isCompleted: true, completedAt: { gte: twoDaysAgo } },
      ],
    },
    include: {
      user:         { select: { id: true, username: true, avatar: true } },
      characters:   true,
      writingDays:  true,
      // Need every log (not just the latest) to total progress and count
      // sessions done — same shape getPlanProgress() uses for "my" plan.
      progressLogs: { orderBy: { logDate: "desc" } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return plans.map((p) => {
    const totalLogged      = p.progressLogs.reduce((acc, l) => acc + (l.countLogged ?? 0), 0);
    const totalSoFar       = p.wordsWrittenSoFar + totalLogged;
    const remaining        = Math.max(p.targetLength - totalSoFar, 0);
    // A real "session" is a picked writing day where they actually hit the
    // daily goal — matches daysMetGoal in getPlanProgress(). Just having a
    // log row (e.g. a bonus day, or logging less than the goal) isn't a
    // completed session for this count.
    const sessionsDone     = p.progressLogs.filter((l) => l.isPickedDay && l.metDailyGoal).length;
    // dailyGoal should always be set on an active plan, but guard against a
    // missing/zero value anyway so a data hiccup shows "—" instead of a
    // false "0 to go" that reads as "fully done."
    const sessionsLeft     = p.dailyGoal > 0 ? Math.ceil(remaining / p.dailyGoal) : null;
    const percentComplete  = p.targetLength > 0
      ? Math.min(Math.round((totalSoFar / p.targetLength) * 100), 100)
      : 0;

    return {
      planId:          p.id,
      userId:          p.userId,
      username:        p.user.username,
      avatar:          p.user.avatar,
      storyTitle:      p.storyTitle,
      goalType:        p.goalType,
      targetLength:    p.targetLength,
      dailyGoal:       p.dailyGoal,
      isCompleted:     p.isCompleted,
      completedAt:     p.completedAt,
      percentComplete,
      daysLogged:      sessionsDone, // kept for backward compatibility with older clients
      sessionsDone,
      sessionsLeft,
      writingDays:     p.writingDays,
      lastLogDate:     p.progressLogs[0]?.logDate ?? null,
      characters:      p.characters,
      isCurrentUser:   p.userId === requestingUserId,
    };
  });
}

async function getWritersWhoLoggedToday() {
  const today    = toMidnightUTC(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const logs = await prisma.draftProgressLog.findMany({
    where:   { logDate: { gte: today, lt: tomorrow } },
    include: {
      user: { select: { id: true, username: true, avatar: true } },
      plan: { select: { storyTitle: true, goalType: true, isCompleted: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return logs.map((l) => ({
    userId:       l.userId,
    username:     l.user.username,
    avatar:       l.user.avatar,
    storyTitle:   l.plan.storyTitle,
    goalType:     l.plan.goalType,
    countLogged:  l.countLogged,
    isPickedDay:  l.isPickedDay,
    metDailyGoal: l.metDailyGoal,
    isCompleted:  l.plan.isCompleted,
  }));
}

// Writers who share TODAY as a picked writing day with the requesting user —
// "writing with you today". Only returned if the requesting user's own plan
// also has today picked, so this stays a same-day-peers view, not a global
// schedule broadcast. Includes peers who've already logged today (marked via
// hasLoggedToday) alongside those still getting ready — previously this
// excluded anyone who'd logged, which meant a peer would just vanish from
// the list the moment they finished their session instead of showing as done.
async function getWritersScheduledToday(requestingUserId) {
  const myPlan = await prisma.draftPlan.findUnique({
    where: { userId: requestingUserId },
    include: { writingDays: true },
  });
  if (!myPlan) return [];

  const jsDayToday = new Date().getUTCDay();
  const iAmWritingToday = myPlan.writingDays.some((d) => WEEKDAY_JS[d.day] === jsDayToday);
  if (!iAmWritingToday) return [];

  const today    = toMidnightUTC(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Map of userId -> today's log, so each peer can be marked logged vs.
  // still getting ready, rather than logged peers being dropped entirely.
  const todaysLogs = await prisma.draftProgressLog.findMany({
    where:  { logDate: { gte: today, lt: tomorrow } },
    select: { userId: true, countLogged: true, metDailyGoal: true },
  });
  const loggedByUserId = new Map(todaysLogs.map((l) => [l.userId, l]));

  const plans = await prisma.draftPlan.findMany({
    where: {
      userId:      { not: requestingUserId },
      isCompleted: false,
    },
    include: {
      user:        { select: { id: true, username: true, avatar: true } },
      writingDays: true,
    },
  });

  return plans
    .filter((p) => p.writingDays.some((d) => WEEKDAY_JS[d.day] === jsDayToday))
    .map((p) => {
      const todayLog = loggedByUserId.get(p.userId);
      return {
        userId:         p.userId,
        username:       p.user.username,
        avatar:         p.user.avatar,
        storyTitle:     p.storyTitle,
        goalType:       p.goalType,
        hasLoggedToday: Boolean(todayLog),
        countLogged:    todayLog?.countLogged ?? 0,
        metDailyGoal:   todayLog?.metDailyGoal ?? false,
      };
    })
    .sort((a, b) => {
      if (a.hasLoggedToday !== b.hasLoggedToday) return a.hasLoggedToday ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
}

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────

async function getOtherActivePlanUsers(excludeUserId) {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  const plans = await prisma.draftPlan.findMany({
    where: {
      userId: { not: excludeUserId },
      OR: [
        { isCompleted: false },
        { isCompleted: true, completedAt: { gte: twoDaysAgo } },
      ],
    },
    select: { user: { select: { id: true, username: true, email: true } } },
  });

  return plans.map((p) => p.user);
}

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

  // Map JS day (0=Sun) back to WeekDay enum
  const jsToEnum = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  const todayEnum = jsToEnum[now.getUTCDay()];

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
  updatePlan,
  deletePlan,
  logProgress,
  getPlanProgress,
  getActiveDraftWriters,
  getWritersWhoLoggedToday,
  getWritersScheduledToday,
  getOtherActivePlanUsers,
  getUserById,
  getWritersToRemindNow,
};