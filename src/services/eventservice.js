const prisma = require("../config/prismaClient");

const PARTICIPANT_PLAN_SELECT = {
  id: true,
  storyTitle: true,
  goalType: true,
  targetLength: true,
  wordsWrittenSoFar: true,
  isCompleted: true,
  completedAt: true,
  user: { select: { id: true, username: true, avatar: true } },
};

function throwHttp(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function deriveStatus(event, now = new Date()) {
  // Never override a manually/cron finalized ENDED event.
  if (event.status === "ENDED") return "ENDED";
  if (now < event.startDate) return "UPCOMING";
  if (now >= event.endDate) return "ENDED";
  return "ACTIVE";
}

function withComputed(event) {
  if (!event) return event;
  const { participantPlanIds, ...rest } = event;
  return {
    ...rest,
    participantPlanIds,
    participantCount: participantPlanIds?.length ?? 0,
    status: deriveStatus(event),
  };
}

// ─── Events (admin write, public read) ───────────────────────────────────────

async function createEvent({ title, description, imageUrl, startDate, endDate, badgeName, badgeIcon }) {
  const event = await prisma.event.create({
    data: {
      title,
      description,
      imageUrl: imageUrl || null,
      startDate,
      endDate,
      badgeName,
      badgeIcon,
    },
  });
  return withComputed(event);
}

async function getEvents({ page = 1, limit = 20, status } = {}) {
  const skip = (page - 1) * limit;

  // status here is the *requested filter*, applied after we compute the
  // live status (UPCOMING/ACTIVE/ENDED can drift from the stored value
  // between finalize runs), so we overfetch a bit and filter in JS for
  // correctness rather than trying to replicate the date math in SQL.
  const [events, total] = await Promise.all([
    prisma.event.findMany({ orderBy: { startDate: "desc" } }),
    prisma.event.count(),
  ]);

  let computed = events.map(withComputed);
  if (status) computed = computed.filter((e) => e.status === status);

  const paged = computed.slice(skip, skip + limit);

  return {
    events: paged,
    total: status ? computed.length : total,
    page,
    totalPages: Math.ceil((status ? computed.length : total) / limit),
  };
}

async function getEvent(eventId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  return withComputed(event);
}

async function findEvent(eventId) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, imageUrl: true, status: true, startDate: true, endDate: true, badgeName: true, badgeIcon: true, participantPlanIds: true },
  });
}

async function updateEvent(eventId, { title, description, imageUrl, startDate, endDate, badgeName, badgeIcon }) {
  const event = await prisma.event.update({
    where: { id: eventId },
    data: {
      ...(title       !== undefined && { title }),
      ...(description !== undefined && { description }),
      ...(imageUrl    !== undefined && { imageUrl }),
      ...(startDate   !== undefined && { startDate }),
      ...(endDate     !== undefined && { endDate }),
      ...(badgeName   !== undefined && { badgeName }),
      ...(badgeIcon   !== undefined && { badgeIcon }),
    },
  });
  return withComputed(event);
}

async function deleteEvent(eventId) {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { imageUrl: true } });
  await prisma.event.delete({ where: { id: eventId } });
  return event?.imageUrl || null;
}

// ─── Joining / leaving ────────────────────────────────────────────────────────

/**
 * A member can only join if they currently have a DraftPlan (one active
 * plan per writer, enforced elsewhere). We store the *plan id*, not the
 * user id, in the event's list — that's the "their draft plan joins the
 * event" behaviour that was asked for.
 */
async function joinEvent(eventId, userId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throwHttp(404, "Event not found.");
  if (deriveStatus(event) === "ENDED") throwHttp(400, "This event has already ended.");

  const plan = await prisma.draftPlan.findUnique({
    where: { userId },
    select: { id: true, storyTitle: true },
  });
  if (!plan) throwHttp(400, "You need an active draft plan before you can join this event.");

  if (event.participantPlanIds.includes(plan.id)) {
    return { event: withComputed(event), alreadyJoined: true, plan };
  }

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: { participantPlanIds: { push: plan.id } },
  });

  return { event: withComputed(updated), alreadyJoined: false, plan };
}

async function leaveEvent(eventId, userId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throwHttp(404, "Event not found.");

  const plan = await prisma.draftPlan.findUnique({ where: { userId }, select: { id: true } });
  if (!plan || !event.participantPlanIds.includes(plan.id)) {
    return { event: withComputed(event), wasParticipant: false };
  }

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: { participantPlanIds: event.participantPlanIds.filter((id) => id !== plan.id) },
  });

  return { event: withComputed(updated), wasParticipant: true };
}

async function isUserParticipant(eventId, userId) {
  const [event, plan] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { participantPlanIds: true } }),
    prisma.draftPlan.findUnique({ where: { userId }, select: { id: true } }),
  ]);
  if (!event || !plan) return false;
  return event.participantPlanIds.includes(plan.id);
}

/**
 * Everything the frontend needs to decide what the "Join" button should say
 * for one event + the current user, in a single call:
 *   - hasDraftPlan: false → show "Create a draft plan to join"
 *   - hasDraftPlan: true, joined: false → show "Join {title}"
 *   - joined: true → show "You're in" / "Leave event"
 */
async function getMyParticipation(eventId, userId) {
  const [event, plan] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { participantPlanIds: true } }),
    prisma.draftPlan.findUnique({
      where: { userId },
      select: { id: true, storyTitle: true, isCompleted: true },
    }),
  ]);
  if (!event) throwHttp(404, "Event not found.");

  if (!plan) {
    return { hasDraftPlan: false, joined: false, plan: null };
  }

  return {
    hasDraftPlan: true,
    joined: event.participantPlanIds.includes(plan.id),
    plan,
  };
}

// ─── Participants (public read) ──────────────────────────────────────────────

async function getParticipants(eventId, { page = 1, limit = 20 } = {}) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { participantPlanIds: true },
  });
  if (!event) return null;

  const ids = event.participantPlanIds;
  const total = ids.length;
  const skip = (page - 1) * limit;
  const pageIds = ids.slice(skip, skip + limit);

  const plans = pageIds.length
    ? await prisma.draftPlan.findMany({
        where: { id: { in: pageIds } },
        select: PARTICIPANT_PLAN_SELECT,
      })
    : [];

  // findMany doesn't preserve `in` order — restore join order.
  const order = new Map(pageIds.map((id, i) => [id, i]));
  plans.sort((a, b) => order.get(a.id) - order.get(b.id));

  return { participants: plans, total, page, totalPages: Math.ceil(total / limit) };
}

// ─── Finalizing (end-of-event role assignment) ───────────────────────────────

/**
 * Walks the event's participant plan list, finds every plan that hit its
 * writing target (isCompleted), and grants those writers a UserBadge
 * (sourceType: EVENT) snapshotting the event's current badgeName/badgeIcon.
 * Never touches User.role. Idempotent — safe to call more than once (e.g.
 * cron retry), since an already-ENDED event is returned as-is, and the
 * @@unique on UserBadge means re-running never grants a duplicate badge
 * even if this function were somehow invoked twice for the same event.
 */
async function finalizeEvent(eventId) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throwHttp(404, "Event not found.");

  if (event.status === "ENDED") {
    return { event: withComputed(event), alreadyFinalized: true, finisherUserIds: [] };
  }

  const plans = event.participantPlanIds.length
    ? await prisma.draftPlan.findMany({
        where: { id: { in: event.participantPlanIds } },
        select: { id: true, userId: true, isCompleted: true },
      })
    : [];

  const finishers = plans.filter((p) => p.isCompleted);
  const finisherUserIds = finishers.map((f) => f.userId);

  if (finisherUserIds.length > 0) {
    await prisma.userBadge.createMany({
      data: finisherUserIds.map((userId) => ({
        userId,
        name: event.badgeName,
        icon: event.badgeIcon,
        sourceType: "EVENT",
        sourceId: event.id,
        weekStart: null,
      })),
      skipDuplicates: true, // relies on the @@unique([userId, sourceType, sourceId, weekStart])
    });
  }

  const updated = await prisma.event.update({
    where: { id: eventId },
    data: { status: "ENDED", finalizedAt: new Date() },
  });

  return { event: withComputed(updated), alreadyFinalized: false, finisherUserIds };
}

/**
 * Cron entry point — finds every event whose endDate has passed but that
 * hasn't been finalized yet, and finalizes each one.
 */
async function finalizeEndedEvents() {
  const now = new Date();
  const dueEvents = await prisma.event.findMany({
    where: { status: { not: "ENDED" }, endDate: { lte: now } },
    select: { id: true },
  });

  const results = [];
  for (const { id } of dueEvents) {
    try {
      results.push(await finalizeEvent(id));
    } catch (err) {
      console.error(`Failed to finalize event ${id}:`, err);
    }
  }
  return results;
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function getUserById(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true },
  });
}

async function getAllUsers() {
  return prisma.user.findMany({
    select: { id: true, username: true, email: true },
  });
}

module.exports = {
  createEvent,
  getEvents,
  getEvent,
  findEvent,
  updateEvent,
  deleteEvent,
  joinEvent,
  leaveEvent,
  isUserParticipant,
  getMyParticipation,
  getParticipants,
  finalizeEvent,
  finalizeEndedEvents,
  getUserById,
  getAllUsers,
};