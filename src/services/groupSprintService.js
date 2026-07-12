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
async function startGroupSprint(userId, duration, visibility = "PUBLIC", sprintType = "WRITING") {
  const groupSprint = await prisma.groupSprint.create({
    data: { userId, duration, visibility, sprintType }
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
      where: { isActive: true, visibility: "PUBLIC" }, // only PUBLIC sprints in the global list
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
    prisma.groupSprint.count({ where: { isActive: true, visibility: "PUBLIC" } })
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

// projectId is now part of join — each member can optionally link their project
async function joinSprint(userId, groupSprintId, checkin, startWords, soundscapeId, projectId) {
  const existing = await prisma.sprint.findFirst({
    where: { userId, groupSprintId, isActive: true }
  });

  if (existing) return existing;

  return prisma.sprint.create({
    data: {
      userId,
      groupSprintId,
      checkin,
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
    select: { startWords: true, userId: true, groupSprintId: true, projectId: true }
  });

  if (!existing) throw new Error("Sprint not found");

  const diff = currentWordCount - existing.startWords;
  const wordsWritten = diff > 0 ? diff : 0;
  const deletedWords = diff < 0 ? Math.abs(diff) : 0;

  const sprint = await prisma.sprint.update({
    where: { id: sprintId },
    data: { wordsWritten, deletedWords, completedAt: new Date(), isActive: false }
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
      checkin: true,
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
  fetchLoginUserSprint,
  fetchUserSprintHistory,
  fetchUserSprintHeatmap,
  autoEndStaleSprints,
};