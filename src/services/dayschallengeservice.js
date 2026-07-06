// src/services/daysChallengeService.js
const prisma = require("../config/prismaClient");
const { localTimeToUTC, toMidnightUTC, todayInTimezone } = require("../utilis/timezone");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const DURATION_DAYS = { SEVEN: 7, FIFTEEN: 15 };

const VALID_FOCUSES = new Set([
  "OUTLINING",
  "BRAINSTORMING",
  "EDITING",
  "STORY_DEVELOPMENT",
]);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// toMidnightUTC now lives in src/utils/timezone.js, shared with
// draftPlanService.js. addDays stays local — it's specific to computing a
// challenge's endDate from its duration, nothing else needs it.

// Add N calendar days to a date
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// Compute stats from a challenge + its check-ins
function computeStats(challenge) {
  const totalDays      = DURATION_DAYS[challenge.duration];
  const checkIns       = challenge.checkIns ?? [];
  const daysCompleted  = checkIns.filter((c) => c.metDailyGoal).length;
  const daysLogged     = checkIns.length;
  const daysLeft       = Math.max(totalDays - daysCompleted, 0);
  const totalLogged    = checkIns.reduce((acc, c) => acc + c.countLogged, 0);
  const percentComplete = Math.min(Math.round((daysCompleted / totalDays) * 100), 100);

  // Days remaining in calendar (how many days until endDate from now)
  const now            = new Date();
  const calendarDaysLeft = Math.max(
    Math.ceil((new Date(challenge.endDate) - now) / (1000 * 60 * 60 * 60 * 24)),
    0
  );

  return {
    totalDays,
    daysCompleted,
    daysLogged,
    daysLeft,
    totalLogged,
    percentComplete,
    calendarDaysLeft,
  };
}

// ─── CHALLENGE CRUD ──────────────────────────────────────────────────────────

async function createChallenge(userId, data) {
  const {
    duration,
    focuses,
    storyTitle,
    workingGoal,
    whyNow,
    goalType,
    dailyGoal,
    reminderTime, // "HH:MM" in the writer's own local time — optional, defaults to "09:00"
  } = data;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!duration || !DURATION_DAYS[duration])
    throw new Error("Duration must be SEVEN or FIFTEEN");
  if (!Array.isArray(focuses) || focuses.length === 0 || focuses.length > 2)
    throw new Error("Pick one or two focuses for your challenge");
  for (const f of focuses) {
    if (!VALID_FOCUSES.has(f)) throw new Error(`Invalid focus: ${f}`);
  }
  if (!workingGoal?.trim()) throw new Error("Working goal is required");
  if (!whyNow?.trim())      throw new Error("Why this matters now is required");
  if (!goalType || !["WORDS", "DURATION"].includes(goalType))
    throw new Error("Goal type must be WORDS or DURATION");
  if (typeof dailyGoal !== "number" || dailyGoal < 1)
    throw new Error("Daily goal must be a positive number");

  const resolvedReminderTime = reminderTime ?? "09:00";
  if (!/^\d{2}:\d{2}$/.test(resolvedReminderTime))
    throw new Error("Reminder time must be in HH:MM format");

  // ── One active challenge at a time ────────────────────────────────────────
  const existing = await prisma.daysChallenge.findUnique({ where: { userId } });
  if (existing && existing.status === "ACTIVE")
    throw new Error("You already have an active challenge. Complete or leave it before joining a new one");

  // If previous challenge exists but is completed/expired, delete it so the
  // @unique userId constraint allows the new one
  if (existing) {
    await prisma.daysChallenge.delete({ where: { id: existing.id } });
  }

  // ── Resolve writer's timezone for the reminder conversion ─────────────────
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone ?? "UTC";
  const reminderTimeUTC = localTimeToUTC(resolvedReminderTime, timezone);

  const startDate = new Date();
  const endDate   = addDays(startDate, DURATION_DAYS[duration]);

  const challenge = await prisma.daysChallenge.create({
    data: {
      userId,
      duration,
      workingGoal:  workingGoal.trim(),
      whyNow:       whyNow.trim(),
      storyTitle:   storyTitle?.trim() ?? null,
      goalType,
      dailyGoal,
      reminderTime:    resolvedReminderTime,
      reminderTimeUTC,
      startDate,
      endDate,
      focuses: {
        create: focuses.map((f) => ({ focus: f })),
      },
    },
    include: {
      focuses:  true,
      checkIns: true,
    },
  });

  return { challenge, stats: computeStats(challenge) };
}

async function getMyChallenge(userId) {
  const challenge = await prisma.daysChallenge.findUnique({
    where:   { userId },
    include: {
      focuses:  true,
      checkIns: { orderBy: { checkInDate: "asc" } },
    },
  });
  if (!challenge) throw new Error("No active challenge found");
  return { challenge, stats: computeStats(challenge) };
}

// Edit challenge info / daily goal. Deliberately limited to fields that are
// safe to change mid-challenge without corrupting stats already logged.
async function updateChallenge(userId, data) {
  const { storyTitle, workingGoal, whyNow, dailyGoal, reminderTime } = data;

  const challenge = await prisma.daysChallenge.findUnique({ where: { userId } });
  if (!challenge)                    throw new Error("No challenge found");
  if (challenge.status !== "ACTIVE") throw new Error("This challenge is no longer active");

  const update = {};

  if (storyTitle !== undefined) {
    update.storyTitle = storyTitle?.trim() || null;
  }
  if (workingGoal !== undefined) {
    if (!workingGoal?.trim()) throw new Error("Working goal is required");
    update.workingGoal = workingGoal.trim();
  }
  if (whyNow !== undefined) {
    if (!whyNow?.trim()) throw new Error("Why this matters now is required");
    update.whyNow = whyNow.trim();
  }
  if (dailyGoal !== undefined) {
    if (typeof dailyGoal !== "number" || dailyGoal < 1)
      throw new Error("Daily goal must be a positive number");
    update.dailyGoal = dailyGoal;
  }
  if (reminderTime !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(reminderTime))
      throw new Error("Reminder time must be in HH:MM format");
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { timezone: true },
    });
    update.reminderTime    = reminderTime;
    update.reminderTimeUTC = localTimeToUTC(reminderTime, user?.timezone ?? "UTC");
  }

  const updated = await prisma.daysChallenge.update({
    where:   { id: challenge.id },
    data:    update,
    include: { focuses: true, checkIns: { orderBy: { checkInDate: "asc" } } },
  });

  return { challenge: updated, stats: computeStats(updated) };
}

// Mark done early — writer hit their goal ahead of schedule
async function completeChallenge(userId) {
  const challenge = await prisma.daysChallenge.findUnique({ where: { userId } });
  if (!challenge)                    throw new Error("No challenge found");
  if (challenge.status !== "ACTIVE") throw new Error("Challenge is not active");

  const updated = await prisma.daysChallenge.update({
    where:   { id: challenge.id },
    data:    { status: "COMPLETED", completedAt: new Date() },
    include: { focuses: true, checkIns: { orderBy: { checkInDate: "asc" } } },
  });

  return { challenge: updated, stats: computeStats(updated) };
}

// Undo "Mark done early" — restores an early-completed challenge back to ACTIVE
// so the writer can continue logging. Only allowed if endDate hasn't passed yet;
// if the deadline has already elapsed, re-activating would leave them in a dead
// state (logProgress would immediately reject new check-ins as expired).
async function uncompleteChallenge(userId) {
  const challenge = await prisma.daysChallenge.findUnique({ where: { userId } });
  if (!challenge)                       throw new Error("No challenge found");
  if (challenge.status !== "COMPLETED") throw new Error("Only manually completed challenges can be undone");

  // Guard: endDate must still be in the future for resuming to make sense
  const now = new Date();
  if (now > new Date(challenge.endDate)) {
    throw new Error(
      "The deadline for this challenge has already passed — you can't resume it. Start a new challenge instead."
    );
  }

  const updated = await prisma.daysChallenge.update({
    where:   { id: challenge.id },
    data:    { status: "ACTIVE", completedAt: null },
    include: { focuses: true, checkIns: { orderBy: { checkInDate: "asc" } } },
  });

  return { challenge: updated, stats: computeStats(updated) };
}

// Leave / abandon challenge. Allowed in any status.
async function leaveChallenge(userId) {
  const challenge = await prisma.daysChallenge.findUnique({ where: { userId } });
  if (!challenge) throw new Error("No challenge found");

  await prisma.daysChallenge.delete({ where: { id: challenge.id } });
  return { message: "Challenge left" };
}

// ─── CHECK-IN / PROGRESS LOGGING ─────────────────────────────────────────────

async function logProgress(userId, data) {
  const { countLogged, note, checkInDate, direction } = data;

  if (typeof countLogged !== "number" || countLogged < 1)
    throw new Error("Count logged must be a positive number");

  // "replace" (default) sets today's count to exactly countLogged,
  // overwriting whatever was already logged today. "add" stacks countLogged
  // on top of today's existing count instead; "remove" subtracts it — both
  // are opt-in via an explicit direction, for writers who want to build on
  // today's number rather than have a new entry replace it outright.
  const dir = direction === "add" ? "add" : direction === "remove" ? "remove" : "replace";

  const challenge = await prisma.daysChallenge.findUnique({
    where:   { userId },
    include: { checkIns: true, focuses: true },
  });
  if (!challenge)                    throw new Error("No challenge found");
  if (challenge.status !== "ACTIVE") throw new Error("This challenge is no longer active");

  // Block logging after endDate
  const now = new Date();
  if (now > new Date(challenge.endDate))
    throw new Error("This challenge has expired");

  // Resolve "today" in the WRITER's own timezone, not the server's — same
  // reasoning as draftPlanService.logProgress. Without this, a writer whose
  // local evening has already crossed into a new calendar day relative to
  // server-UTC (or hasn't yet) gets their check-in keyed to the wrong day,
  // can silently skip a day's check-in, or land two check-ins on what they
  // experience as one day.
  //
  // If the caller passed an explicit checkInDate (e.g. backfilling a
  // specific day), treat it as already meaningful and don't reinterpret it.
  let today;
  if (checkInDate) {
    today = toMidnightUTC(checkInDate);
  } else {
    const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const timezone = user?.timezone ?? "UTC";
    today          = todayInTimezone(timezone, now);
  }

  const existing      = await prisma.daysChallengeCheckIn.findUnique({
    where: { challengeId_checkInDate: { challengeId: challenge.id, checkInDate: today } },
  });

  // Today's count is set per direction — "replace" (default) overwrites it
  // outright, "add"/"remove" stack on top of or subtract from whatever's
  // already logged for the day.
  const prevToday      = existing?.countLogged ?? 0;
  let newTodayCount;
  if (dir === "add") {
    newTodayCount = prevToday + countLogged;
  } else if (dir === "remove") {
    newTodayCount = prevToday - countLogged;
  } else {
    newTodayCount = countLogged;
  }
  // A single day's count can't go below 0 — unlike draft plan's running
  // project total, there's no larger running total here to absorb a
  // negative correction into, so the floor has to be on the day itself.
  newTodayCount        = Math.max(newTodayCount, 0);
  const metGoal        = newTodayCount >= challenge.dailyGoal;

  const checkIn = await prisma.daysChallengeCheckIn.upsert({
    where:  { challengeId_checkInDate: { challengeId: challenge.id, checkInDate: today } },
    create: {
      challengeId:  challenge.id,
      userId,
      checkInDate:  today,
      countLogged:  newTodayCount,
      metDailyGoal: metGoal,
      note:         note?.trim() ?? null,
    },
    update: {
      countLogged:  newTodayCount,
      metDailyGoal: metGoal,
      note:         note?.trim() ?? null,
    },
  });

  // Check if all days are now complete — auto-complete if so. A "remove"
  // can only ever reduce daysMetGoal, never complete the challenge.
  const totalDays    = DURATION_DAYS[challenge.duration];
  const updatedLogs  = await prisma.daysChallengeCheckIn.findMany({
    where: { challengeId: challenge.id },
  });
  const daysMetGoal  = updatedLogs.filter((c) => c.metDailyGoal).length;
  const allDone      = dir !== "remove" && daysMetGoal >= totalDays;

  if (allDone) {
    await prisma.daysChallenge.update({
      where: { id: challenge.id },
      data:  { status: "COMPLETED", completedAt: new Date() },
    });
  }

  const stats = computeStats({ ...challenge, checkIns: updatedLogs });

  return {
    checkIn,
    direction:    dir,
    metDailyGoal: metGoal,
    isAllDone:    allDone,
    stats,
    challenge: {
      id:         challenge.id,
      userId:     challenge.userId,
      storyTitle: challenge.storyTitle,
      goalType:   challenge.goalType,
      dailyGoal:  challenge.dailyGoal,
      focuses:    challenge.focuses,
    },
  };
}

// ─── COMMUNITY FEED ──────────────────────────────────────────────────────────

async function getActiveChallengeWriters(requestingUserId) {
  const challenges = await prisma.daysChallenge.findMany({
    where:   { status: "ACTIVE" },
    include: {
      user:     { select: { id: true, username: true, avatar: true } },
      focuses:  true,
      checkIns: { orderBy: { checkInDate: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  return challenges.map((c) => {
    const totalDays = DURATION_DAYS[c.duration];
    const stats     = computeStats({ ...c, checkIns: [] });

    return {
      challengeId:     c.id,
      userId:          c.userId,
      username:        c.user.username,
      avatar:          c.user.avatar,
      storyTitle:      c.storyTitle,
      workingGoal:     c.workingGoal,
      duration:        c.duration,
      totalDays,
      focuses:         c.focuses.map((f) => f.focus),
      goalType:        c.goalType,
      dailyGoal:       c.dailyGoal,
      lastCheckIn:     c.checkIns[0]?.checkInDate ?? null,
      isCurrentUser:   c.userId === requestingUserId,
    };
  });
}

async function getWritersWhoLoggedToday() {
  const today    = toMidnightUTC(new Date());
  const tomorrow = addDays(today, 1);

  const checkIns = await prisma.daysChallengeCheckIn.findMany({
    where:   { checkInDate: { gte: today, lt: tomorrow } },
    include: {
      user:      { select: { id: true, username: true, avatar: true } },
      challenge: {
        select: {
          storyTitle:  true,
          goalType:    true,
          duration:    true,
          status:      true,
          focuses:     true,
          checkIns:    { select: { metDailyGoal: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return checkIns.map((c) => {
    const totalDays     = DURATION_DAYS[c.challenge.duration];
    const daysCompleted = c.challenge.checkIns.filter((ci) => ci.metDailyGoal).length;

    return {
      userId:       c.userId,
      username:     c.user.username,
      avatar:       c.user.avatar,
      storyTitle:   c.challenge.storyTitle,
      goalType:     c.challenge.goalType,
      focuses:      c.challenge.focuses.map((f) => f.focus),
      countLogged:  c.countLogged,
      metDailyGoal: c.metDailyGoal,
      daysCompleted,
      totalDays,
      percentComplete: Math.min(Math.round((daysCompleted / totalDays) * 100), 100),
    };
  });
}

// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────

async function getOtherActiveChallengeUsers(excludeUserId) {
  const challenges = await prisma.daysChallenge.findMany({
    where:  { status: "ACTIVE", userId: { not: excludeUserId } },
    select: { user: { select: { id: true, username: true, email: true } } },
  });
  return challenges.map((c) => c.user);
}

// ─── CRON HELPER ─────────────────────────────────────────────────────────────

async function expireOverdueChallenges() {
  const now = new Date();

  const result = await prisma.daysChallenge.updateMany({
    where: {
      status:  "ACTIVE",
      endDate: { lt: now },
    },
    data: {
      status:    "EXPIRED",
      expiredAt: now,
    },
  });

  return { expired: result.count };
}

// ─── REMINDER CRON HELPER ─────────────────────────────────────────────────────
// Mirrors draftPlanService.getWritersToRemindNow(): a simple string match on
// reminderTimeUTC, done once a minute, with all the timezone math already
// baked into the stored value at create/update time.
//
// Differs from the draft-plan version in two ways that matter for this model:
//   1. There's no "picked day" concept — every day of an active challenge is
//      a reminder day, so we don't filter by weekday at all.
//   2. We additionally guard against `endDate` having passed. The midnight
//      expiry cron (daysChallengeExpiryCron) usually catches this first and
//      flips status to EXPIRED, but a challenge can still be ACTIVE for the
//      remaining minutes of its final day — and on that last day we still
//      want the reminder to fire, so this only excludes challenges where
//      endDate is already in the past, not the day endDate falls on.
//   3. If the writer has already logged a check-in for today that met their
//      goal, skip the reminder — no need to nudge someone who already showed
//      up today. "Today" here is resolved per-writer in their own timezone
//      (todayInTimezone), not the server's UTC day — this function fans out
//      across writers in many timezones at once, so a single shared "today"
//      computed up front would be wrong for everyone except whoever's in
//      UTC. Pulling the last few days of check-ins and filtering in code
//      sidesteps doing a per-row timezone-aware date query in Prisma.
async function getChallengeWritersToRemindNow() {
  const now     = new Date();
  const hh      = String(now.getUTCHours()).padStart(2, "0");
  const mm      = String(now.getUTCMinutes()).padStart(2, "0");
  const timeUTC = `${hh}:${mm}`;
  // Wide enough window (48h) to safely contain "today" in any IANA timezone
  // relative to server-UTC now, in either direction.
  const lookback = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

  const challenges = await prisma.daysChallenge.findMany({
    where: {
      status:          "ACTIVE",
      reminderTimeUTC: timeUTC,
      endDate:         { gt: now },
    },
    include: {
      user:     { select: { id: true, username: true, email: true, timezone: true } },
      focuses:  true,
      checkIns: { where: { checkInDate: { gte: lookback } } },
    },
  });

  // Skip anyone who's already checked in (and hit their goal) on their own
  // local "today" — computed per writer, since this batch spans timezones.
  const due = challenges.filter((c) => {
    const timezone     = c.user?.timezone ?? "UTC";
    const todayForUser = todayInTimezone(timezone, now);
    const todayCheckIn  = c.checkIns.find(
      (ci) => toMidnightUTC(ci.checkInDate).getTime() === todayForUser.getTime()
    );
    return !(todayCheckIn && todayCheckIn.metDailyGoal);
  });

  return due.map((c) => ({
    user:        c.user,
    challengeId: c.id,
    storyTitle:  c.storyTitle,
    workingGoal: c.workingGoal,
    dailyGoal:   c.dailyGoal,
    goalType:    c.goalType,
    duration:    c.duration,
    endDate:     c.endDate,
  }));
}

module.exports = {
  createChallenge,
  getMyChallenge,
  updateChallenge,
  completeChallenge,
  uncompleteChallenge,
  leaveChallenge,
  logProgress,
  getActiveChallengeWriters,
  getWritersWhoLoggedToday,
  getOtherActiveChallengeUsers,
  expireOverdueChallenges,
  getChallengeWritersToRemindNow,
};