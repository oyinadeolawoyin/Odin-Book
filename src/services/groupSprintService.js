const prisma = require("../config/prismaClient");

// "YYYY-MM-DD" for a given Date, in a given IANA timezone — used so a
// writer's streak/heatmap is bucketed by *their* calendar day, not the
// server's (UTC). en-CA gives YYYY-MM-DD ordering directly.
function localDateKey(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    // Unknown/invalid timezone string — fall back to UTC rather than throwing.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

// ─── AUTO-END STALE SPRINTS ───────────────────────────────────
// Called before any read that returns active sprints.
// Ends any GroupSprint whose (startedAt + duration + 10 min grace) has passed.
// This ensures stale sprints vanish from the homepage even when the host
// never manually ends the session.
async function autoEndStaleSprints() {
  const now = new Date();

  // Find all active group sprints that are overdue
  const stale = await prisma.groupSprint.findMany({
    where: { isActive: true },
    select: { id: true, startedAt: true, duration: true },
  });

  const overdueIds = stale
    .filter(({ startedAt, duration }) => {
      const endsAt = new Date(startedAt).getTime() + (duration + 10) * 60 * 1000;
      return now.getTime() > endsAt;
    })
    .map((gs) => gs.id);

  if (overdueIds.length === 0) return;

  // For each overdue sprint, run the same logic as endGroupSprint
  for (const groupSprintId of overdueIds) {
    try {
      await prisma.sprint.updateMany({
        where: { groupSprintId, isActive: true },
        data: { completedAt: now, isActive: false },
      });

      const allSprints = await prisma.sprint.findMany({
        where: { groupSprintId },
        select: { wordsWritten: true },
      });
      const totalWordsWritten = allSprints.reduce((sum, s) => sum + (s.wordsWritten || 0), 0);

      await prisma.groupSprint.update({
        where: { id: groupSprintId },
        data: { completedAt: now, isActive: false, totalWordsWritten },
      });
    } catch (err) {
      // Don't let one failure block the rest
      console.error(`[autoEnd] Failed to end groupSprint ${groupSprintId}:`, err);
    }
  }
}

// ─── GROUP SPRINT ─────────────────────────────────────────────
async function startGroupSprint(userId, duration, sprintType = "WRITING") {
  const groupSprint = await prisma.groupSprint.create({
    data: { userId, duration, sprintType }
  });

  return prisma.groupSprint.update({
    where: { id: groupSprint.id },
    data: { liveKitRoomName: `sprint-${groupSprint.id}` }
  });
}


async function endGroupSprint(groupSprintId) {
  await prisma.sprint.updateMany({
    where: { groupSprintId, isActive: true },
    data: { completedAt: new Date(), isActive: false }
  });

  const allSprints = await prisma.sprint.findMany({
    where: { groupSprintId },
    select: { wordsWritten: true }
  });
  const totalWordsWritten = allSprints.reduce((sum, s) => sum + (s.wordsWritten || 0), 0);

  return prisma.groupSprint.update({
    where: { id: groupSprintId },
    data: { completedAt: new Date(), isActive: false, totalWordsWritten }
  });
}

async function fetchGroupSprint(groupSprintId) {
  // Auto-end this sprint if its time has passed (covers direct URL visits)
  await autoEndStaleSprints();

  return prisma.groupSprint.findFirst({
    where: { id: groupSprintId },
    include: {
      sprints: {
        include: {
          user: { select: { id: true, username: true, avatar: true, discordId: true } },
          soundscape: {
            select: { id: true, name: true, fileUrl: true, creatorName: true }
          }
        }
      },
      _count: { select: { sprints: true } },
      user: { select: { id: true, username: true, avatar: true } }
    }
  });
}

async function fetchAllActiveGroupSprints({ take, skip }) {
  // Sweep stale sprints before returning the list so the homepage stays clean
  await autoEndStaleSprints();

  const [groupSprints, total] = await prisma.$transaction([
    prisma.groupSprint.findMany({
      where: { isActive: true },
      skip,
      take,
      orderBy: { startedAt: "desc" },
      include: {
        user: { select: { id: true, username: true, avatar: true } },
        sprints: {
          select: {
            userId: true,
            user: { select: { id: true, username: true, avatar: true } }
          }
        },
        _count: { select: { sprints: true } }
      }
    }),
    prisma.groupSprint.count({ where: { isActive: true } })
  ]);

  return { groupSprints, total };
}

async function fetchLastGroupSprint() {
  return prisma.groupSprint.findFirst({
    where: { isActive: false, completedAt: { not: null } },
    orderBy: { completedAt: "desc" },
    include: {
      sprints: {
        orderBy: { wordsWritten: "desc" },
        include: {
          user: { select: { id: true, username: true, avatar: true } },
          soundscape: {
            select: { id: true, name: true, fileUrl: true, creatorName: true }
          }
        }
      },
      user: { select: { id: true, username: true, avatar: true } },
      _count: { select: { sprints: true } }
    }
  });
}

// ─── SPRINT ───────────────────────────────────────────────────

async function joinSprint(userId, groupSprintId, startWords, soundscapeId, { rebaseline = false } = {}) {
  const existing = await prisma.sprint.findFirst({
    where: { userId, groupSprintId, isActive: true }
  });

  if (existing) {
    // Plain "join" (e.g. a double-click) should just hand back the same
    // in-progress row untouched. A rejoin after a mid-sprint draft switch
    // is different: it's supposed to rebaseline against the new draft's
    // starting count, even if this exact row was already active — e.g.
    // because a prior checkout call silently failed server-side. Without
    // this, the row would keep whichever draft's baseline it started
    // with, permanently mismatched against the draft you're actually on.
    if (!rebaseline) return existing;
    return prisma.sprint.update({
      where: { id: existing.id },
      data: { startWords: startWords || 0 },
      include: {
        soundscape: {
          select: { id: true, name: true, fileUrl: true, creatorName: true }
        }
      }
    });
  }

  return prisma.sprint.create({
    data: {
      userId,
      groupSprintId,
      startWords: startWords || 0,
      soundscapeId: soundscapeId || null,
    },
    include: {
      soundscape: {
        select: { id: true, name: true, fileUrl: true, creatorName: true }
      }
    }
  });
}

async function checkoutSprint(sprintId, currentWordCount) {
  const existing = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: { startWords: true, userId: true, groupSprintId: true, wordsWritten: true }
  });

  if (!existing) throw new Error("Sprint not found");

  const diff = currentWordCount - existing.startWords;
  // True live diff — no high-water mark. If the writer deleted text since
  // their peak, the persisted total reflects that, same as what they saw
  // on screen. Floored at 0 so a net-negative diff (deleted below the
  // starting count) doesn't record a negative word count.
  const wordsWritten = Math.max(0, diff);
  const deletedWords = diff < 0 ? Math.abs(diff) : 0;

  const sprint = await prisma.sprint.update({
    where: { id: sprintId },
    data: { endWords: currentWordCount, wordsWritten, deletedWords, completedAt: new Date(), isActive: false }
  });

  // ── Update group sprint total ──────────────────────────────
  if (existing.groupSprintId) {
    const allSprints = await prisma.sprint.findMany({
      where: { groupSprintId: existing.groupSprintId },
      select: { wordsWritten: true }
    });
    const total = allSprints.reduce((sum, s) => sum + (s.wordsWritten || 0), 0);
    await prisma.groupSprint.update({
      where: { id: existing.groupSprintId },
      data: { totalWordsWritten: total }
    });
  }

  return sprint;
}

// Live word-count sync while a sprint is still running — same diff logic as
// checkoutSprint, but doesn't end the sprint (isActive/completedAt untouched).
// Called from the socket handler on each progress tick so every writer's
// bar can update without waiting for a checkout. Returns null (rather than
// throwing) for a sprint that's already been checked out/left, since a late
// progress ping arriving after that is expected, not an error.
async function updateSprintProgress(sprintId, currentWordCount) {
  const existing = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: { startWords: true, isActive: true }
  });

  if (!existing) throw new Error("Sprint not found");
  if (!existing.isActive) return null;

  const diff = currentWordCount - existing.startWords;
  // True live diff — no high-water mark, same as checkoutSprint. A
  // background sync mid-sprint should persist exactly what's on screen,
  // not lock in whatever the peak happened to be at an earlier tick.
  const wordsWritten = Math.max(0, diff);

  return prisma.sprint.update({
    where: { id: sprintId },
    data: { wordsWritten },
    select: { id: true, userId: true, groupSprintId: true, wordsWritten: true }
  });
}

// Called when a writer switches drafts mid-sprint. Keeps the SAME sprint
// row running (no checkout, no new row) — just shifts its startWords
// baseline so the diff formula (currentWordCount - startWords), applied
// against the *new* draft's word count, reproduces the exact total the
// writer had already earned on the old draft, and keeps climbing from
// there as they keep typing. This is the same floor-at-zero diff logic as
// checkoutSprint/updateSprintProgress/leaveSprint — just re-anchored.
async function rebaselineSprint(sprintId, oldWordCount, newWordCount) {
  const existing = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: { startWords: true, isActive: true },
  });

  if (!existing) throw new Error("Sprint not found");
  if (!existing.isActive) throw new Error("Sprint is no longer active");

  // Total already earned on the draft being left.
  const totalSoFar = Math.max(0, oldWordCount - existing.startWords);
  // Re-anchor so newWordCount - newStartWords === totalSoFar right now.
  const newStartWords = newWordCount - totalSoFar;

  return prisma.sprint.update({
    where: { id: sprintId },
    data: { startWords: newStartWords, wordsWritten: totalSoFar },
  });
}

// A voluntary early exit — distinct from checkoutSprint, which is the
// "properly finished, sprint ended naturally" path. currentWordCount is
// optional here: leaving shouldn't force a final word-count entry, that's
// the whole point of it being lower-friction than checkout.
async function leaveSprint(sprintId, currentWordCount) {
  const existing = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: { startWords: true, groupSprintId: true, wordsWritten: true }
  });

  if (!existing) throw new Error("Sprint not found");

  // If no final count is given, keep whatever was last persisted (e.g. by
  // the periodic background sync) rather than wiping it to 0 — leaving is
  // meant to be lower-friction than checkout, not lossy.
  let wordsWritten = existing.wordsWritten, deletedWords = 0, endWords = null;
  if (currentWordCount != null) {
    const diff = currentWordCount - existing.startWords;
    // True live diff, same as checkoutSprint/updateSprintProgress — no
    // high-water mark.
    wordsWritten = Math.max(0, diff);
    deletedWords = diff < 0 ? Math.abs(diff) : 0;
    endWords = currentWordCount;
  }

  const sprint = await prisma.sprint.update({
    where: { id: sprintId },
    data: { endWords, wordsWritten, deletedWords, leftEarly: true, completedAt: new Date(), isActive: false }
  });

  if (existing.groupSprintId) {
    const allSprints = await prisma.sprint.findMany({
      where: { groupSprintId: existing.groupSprintId },
      select: { wordsWritten: true }
    });
    const total = allSprints.reduce((sum, s) => sum + (s.wordsWritten || 0), 0);
    await prisma.groupSprint.update({
      where: { id: existing.groupSprintId },
      data: { totalWordsWritten: total }
    });
  }

  return sprint;
}

async function fetchLoginUserSprint(userId) {
  return prisma.sprint.findFirst({
    where: { userId, isActive: true },
    include: {
      user: { select: { id: true, username: true, avatar: true } },
      soundscape: {
        select: { id: true, name: true, fileUrl: true, creatorName: true }
      }
    }
  });
}

// ─── SPRINT HISTORY & HEATMAP ──────────────────────────────────
// Powers the drafts page's "your sprint activity" section — a recent-
// sprints list plus a GitHub-style calendar heatmap of writing days.

// Most recent completed sprints for a writer, newest first. Pass `days` to
// scope this to a rolling window (e.g. the last 7 days) instead of just
// capping by row count — used by the drafts page's "recent sprints" list.
async function fetchUserSprintHistory(userId, { limit = 20, days } = {}) {
  const where = { userId, completedAt: { not: null } };

  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);
    where.completedAt = { not: null, gte: since };
  }

  return prisma.sprint.findMany({
    where,
    orderBy: { completedAt: "desc" },
    take: limit,
    select: {
      id: true,
      wordsWritten: true,
      startedAt: true,
      completedAt: true,
      groupSprintId: true,
      groupSprint: { select: { duration: true, sprintType: true } },
    },
  });
}

// Daily totals of words written over the last `days` days, keyed by
// "YYYY-MM-DD" in the writer's own timezone (User.timezone) — the frontend
// maps these into heatmap cell intensities and computes the day streak
// from the same keys, so a sprint logged late at night still lands on the
// day the writer experienced it as, not whatever day it happened to be
// in UTC on the server.
//
// `total` is a separate, unbounded COUNT of every completed sprint the
// writer has ever done — not capped by `days` (which only controls how
// far back the calendar/heatmap itself renders) and not capped by any
// page-size limit, so "sprints total" on the dashboard is always exact.
async function fetchUserSprintHeatmap(userId, { days = 182 } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const [user, sprints, total] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    prisma.sprint.findMany({
      where: { userId, completedAt: { gte: since, not: null } },
      select: { completedAt: true, wordsWritten: true },
    }),
    prisma.sprint.count({ where: { userId, completedAt: { not: null } } }),
  ]);
  const timezone = user?.timezone || "UTC";

  const byDay = {};
  for (const s of sprints) {
    const key = localDateKey(s.completedAt, timezone);
    byDay[key] = (byDay[key] || 0) + (s.wordsWritten || 0);
  }

  return { heatmap: byDay, total };
}

module.exports = {
  startGroupSprint,
  endGroupSprint,
  fetchGroupSprint,
  fetchAllActiveGroupSprints,
  fetchLastGroupSprint,
  joinSprint,
  checkoutSprint,
  leaveSprint,
  updateSprintProgress,
  rebaselineSprint,
  fetchLoginUserSprint,
  fetchUserSprintHistory,
  fetchUserSprintHeatmap,
  autoEndStaleSprints,
};