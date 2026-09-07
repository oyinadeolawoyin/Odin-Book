const prisma = require("../config/prismaClient");
const { todayInTimezone } = require("../utilis/timezone");
const { recordSprintActivity } = require("./writingactivityservice");

// ─── SOLO SPRINT ─────────────────────────────────────────────────────────
// Every writer starts and checks in their own sprint independently — no
// group sprint attachment. Reuses the existing Sprint table with
// groupSprintId left null — same startWords/endWords/wordsWritten diff
// logic as before, just without anything group-related attached.
//
//   1. start a sprint with a duration, starting word count, and optional
//      soundscape/draft
//   2. check in with a final word count when it's done
// ──────────────────────────────────────────────────────────────────────

async function startSprint(userId, duration, startWords = 0, draftId = null, soundscapeId = null) {
  return prisma.$transaction(async (tx) => {
    // A writer should only ever have one active solo sprint at a time.
    // Nothing enforced that before this — starting a new sprint never
    // checked for or closed an existing active one, so a sprint that
    // never got an explicit checkin (closed tab, dead connection, a
    // second tab, a failed checkout request) just sat there isActive
    // forever. Every one of those ghosts then showed up as its own
    // duplicate "currently sprinting" card in the Sprint Room (see
    // sprintRoomService.fetchSprintingMembers). Close any stragglers out
    // here — marked left-early rather than silently deleted, since they
    // did write real words before going stale — before creating the new
    // one, so there's never more than one isActive row per user.
    await tx.sprint.updateMany({
      where: { userId, isActive: true, groupSprintId: null },
      data: { isActive: false, leftEarly: true, completedAt: new Date() },
    });

    return tx.sprint.create({
      data: {
        userId,
        duration: duration || null,
        startWords: startWords || 0,
        draftId: draftId || null,
        soundscapeId: soundscapeId || null,
      },
      include: {
        soundscape: { select: { id: true, name: true } },
      },
    });
  });
}

// Called from the sprint:progress socket handler (index.js) on every live
// word-count push. Deliberately NOT a REST endpoint — this is meant to be
// cheap and frequent (near every keystroke, debounced client-side), so it
// skips checkinSprint's full read-then-write and doesn't touch
// endWords/wordsWritten/completedAt/isActive at all. userId comes from the
// authenticated socket connection, never trusted from the client payload —
// a socket can only ever push progress for its own sprint. Returns null
// (not a throw) for a sprintId that isn't this user's or isn't active
// anymore, since a late-arriving ping racing a checkin is an expected,
// ignorable race, not an error worth logging per-occurrence.
async function updateSprintProgress(sprintId, userId, currentWords) {
  const existing = await prisma.sprint.findFirst({
    where: { id: sprintId, userId, isActive: true },
    select: { startWords: true },
  });
  if (!existing) return null;

  const clean = Math.max(0, Number(currentWords) || 0);
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { currentWords: clean },
  });

  return {
    id: sprintId,
    userId,
    wordsWritten: Math.max(0, clean - existing.startWords),
  };
}

// Single check-in to close out the sprint — separate from the live socket
// no group total to update. Same floor-at-zero diff as before: a
// net-negative diff (deleted below the starting count) never records a
// negative word count.
async function checkinSprint(sprintId, userId, currentWordCount) {
  const existing = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: { userId: true, startWords: true, isActive: true, startedAt: true },
  });

  if (!existing) throw new Error("Sprint not found");
  if (existing.userId !== userId) throw new Error("Not your sprint");
  if (!existing.isActive) throw new Error("Sprint already checked in");

  const diff = currentWordCount - existing.startWords;
  const wordsWritten = Math.max(0, diff);
  const deletedWords = diff < 0 ? Math.abs(diff) : 0;
  const completedAt = new Date();

  const sprint = await prisma.sprint.update({
    where: { id: sprintId },
    data: {
      endWords: currentWordCount,
      wordsWritten,
      deletedWords,
      completedAt,
      isActive: false,
    },
  });

  // Feed the day's DailyWritingActivity row — this is what makes a sprint
  // count as "writing today" in Community, keep a streak alive, and show
  // up in the workspace history graph/stats. Previously this call site was
  // never wired in (see the TODO that used to live in
  // writingactivityservice.js), so sprint-only writers never showed up in
  // any of those. Minutes spent is the sprint's real elapsed time
  // (checkin - start), not its planned duration, so WPM reflects what
  // actually happened even for an early or late checkin.
  if (wordsWritten > 0) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const timezone = user?.timezone ?? "UTC";
    const minutesSpent = Math.max(1, Math.round((completedAt - existing.startedAt) / 60000));
    await recordSprintActivity(userId, todayInTimezone(timezone), wordsWritten, minutesSpent);
  }

  return sprint;
}

// The writer's current in-progress solo sprint, if any — lets the client
// know whether to show "resume sprint" or "start sprint" on load.
async function fetchActiveSprint(userId) {
  return prisma.sprint.findFirst({
    where: { userId, isActive: true, groupSprintId: null },
    include: {
      soundscape: { select: { id: true, name: true } },
    },
  });
}

module.exports = {
  startSprint,
  checkinSprint,
  updateSprintProgress,
  fetchActiveSprint,
};