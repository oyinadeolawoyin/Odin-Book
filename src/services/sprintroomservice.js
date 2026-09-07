const prisma = require("../config/prismaClient");

// A member counts as "currently in the room" if they have a presence row
// with leftAt still null AND a heartbeat within this window. This lets a
// dropped connection (closed tab, dead socket) age out of the "who's here"
// list without requiring an explicit leave call.
const PRESENCE_STALE_MS = 60 * 1000; // 60s — pair with a ~20-30s client heartbeat

// ─── ROOM LOOKUP ───────────────────────────────────────────────

// Single default room for now — mirrors the "just one room" design.
// Kept as a lookup rather than a hardcoded id so a second room could be
// introduced later without touching call sites.
async function fetchOrCreateDefaultRoom() {
  const existing = await prisma.sprintRoom.findFirst({ orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.sprintRoom.create({ data: { name: "Sprint Room" } });
}

async function fetchRoomById(sprintRoomId) {
  return prisma.sprintRoom.findUnique({ where: { id: Number(sprintRoomId) } });
}

// ─── SPRINTING MEMBERS (no GroupSprint attachment) ──────────────
//
// The room no longer tracks one shared GroupSprint timer — each writer
// starts and checks in their own Sprint independently. This is how the
// room grid/strip knows who's currently sprinting and what they're
// listening to: take everyone whose presence is still live, then pull
// each of their individually active Sprint rows. No group entity in
// between at all.
async function fetchSprintingMembers(sprintRoomId) {
  const staleBefore = new Date(Date.now() - PRESENCE_STALE_MS);

  const presentMembers = await prisma.sprintRoomPresence.findMany({
    where: {
      sprintRoomId,
      leftAt: null,
      lastSeenAt: { gte: staleBefore },
    },
    select: { userId: true },
  });

  const presentUserIds = presentMembers.map((p) => p.userId);
  if (presentUserIds.length === 0) return [];

  return prisma.sprint.findMany({
    where: {
      userId: { in: presentUserIds },
      isActive: true,
      groupSprintId: null,
    },
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      userId: true,
      duration: true,
      startWords: true,
      currentWords: true, // initial value on page load — live socket pushes (sprint:progress) take over from here client-side
      startedAt: true,
      user: { select: { id: true, username: true, avatar: true } },
      soundscape: { select: { id: true, name: true } },
    },
  });
}

// ─── PRESENCE ──────────────────────────────────────────────────

async function joinRoom(sprintRoomId, userId) {
  return prisma.sprintRoomPresence.upsert({
    where: { sprintRoomId_userId: { sprintRoomId, userId } },
    create: { sprintRoomId, userId },
    update: { leftAt: null, lastSeenAt: new Date() },
  });
}

// Called on a client heartbeat interval while the room tab is open/focused.
async function heartbeat(sprintRoomId, userId) {
  return prisma.sprintRoomPresence.updateMany({
    where: { sprintRoomId, userId },
    data: { lastSeenAt: new Date(), leftAt: null },
  });
}

async function leaveRoom(sprintRoomId, userId) {
  return prisma.sprintRoomPresence.updateMany({
    where: { sprintRoomId, userId, leftAt: null },
    data: { leftAt: new Date() },
  });
}

// Everyone currently "in" the room — used to populate the PFP grid and as
// the tag-able member list during check-in/check-out. Distinct from Sprint
// participation: someone can be listed here without having joined a sprint.
async function fetchRoomMembers(sprintRoomId) {
  const staleBefore = new Date(Date.now() - PRESENCE_STALE_MS);

  return prisma.sprintRoomPresence.findMany({
    where: {
      sprintRoomId,
      leftAt: null,
      lastSeenAt: { gte: staleBefore },
    },
    include: {
      user: { select: { id: true, username: true, avatar: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
}

// ─── MESSAGES (text only — no GIF or SOUND) ─────────────────────

// Pulls @username tokens out of message content and resolves them against
// any real user (same as thread mentions), not just people currently
// present in the room. A mention should still land as a notification even
// if the mentioned person's presence went stale or they already left —
// otherwise a slow/backgrounded tab silently swallows the mention.
async function resolveMentions(content) {
  const handles = [...new Set([...content.matchAll(/@(\w+)/g)].map((m) => m[1].toLowerCase()))];
  if (handles.length === 0) return [];

  const users = await prisma.user.findMany({
    where: {
      username: { in: handles, mode: "insensitive" },
      isDeleted: false,
    },
    select: { id: true, username: true },
  });

  const matched = new Map(); // dedupe by id
  for (const user of users) matched.set(user.id, user);
  return [...matched.values()];
}

async function postMessage(sprintRoomId, senderId, content, quotedMessageId) {
  let quotedContent = null;
  let quotedSenderName = null;

  if (quotedMessageId) {
    const quoted = await prisma.sprintRoomMessage.findUnique({
      where: { id: Number(quotedMessageId) },
      include: { sender: { select: { username: true } } },
    });
    if (quoted) {
      quotedContent = quoted.content;
      quotedSenderName = quoted.sender?.username || null;
    }
  }

  const mentionedUsers = await resolveMentions(content);

  const message = await prisma.sprintRoomMessage.create({
    data: {
      sprintRoomId,
      senderId,
      content,
      mentionedUserIds: mentionedUsers.map((u) => u.id),
      quotedMessageId: quotedMessageId || null,
      quotedContent,
      quotedSenderName,
    },
    include: {
      sender: { select: { id: true, username: true, avatar: true } },
    },
  });

  // Dedicated, lightweight notifications — deliberately NOT routed through
  // notifyUser()/the Notification table, so they never appear on the bell
  // page. They only drive the chat icon's red-dot badge (see
  // fetchUnreadNotificationCount / markNotificationsRead below).
  const recipientIds = new Set(); // dedupe so one message → one row per person, per kind
  const notificationRows = [];

  for (const user of mentionedUsers) {
    if (user.id === senderId) continue; // don't notify yourself
    const key = `MENTION:${user.id}`;
    if (recipientIds.has(key)) continue;
    recipientIds.add(key);
    notificationRows.push({ userId: user.id, messageId: message.id, kind: "MENTION" });
  }

  if (quotedMessageId) {
    const quotedSender = await prisma.sprintRoomMessage.findUnique({
      where: { id: Number(quotedMessageId) },
      select: { senderId: true },
    });
    if (quotedSender?.senderId && quotedSender.senderId !== senderId) {
      const key = `REPLY:${quotedSender.senderId}`;
      if (!recipientIds.has(key)) {
        recipientIds.add(key);
        notificationRows.push({ userId: quotedSender.senderId, messageId: message.id, kind: "REPLY" });
      }
    }
  }

  if (notificationRows.length > 0) {
    await prisma.sprintRoomNotification.createMany({ data: notificationRows });
  }

  return message;
}

async function fetchRoomMessages(sprintRoomId, { limit = 50, before } = {}) {
  return prisma.sprintRoomMessage.findMany({
    where: {
      sprintRoomId,
      deletedAt: null,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      sender: { select: { id: true, username: true, avatar: true } },
    },
  });
}

async function deleteMessage(messageId, requesterId) {
  const message = await prisma.sprintRoomMessage.findUnique({ where: { id: messageId } });
  if (!message) throw new Error("Message not found");
  if (message.senderId !== requesterId) throw new Error("Not authorized to delete this message");

  return prisma.sprintRoomMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });
}

// ─── CHAT NOTIFICATIONS (mentions / replies — badge only) ───────

// Powers the red-dot count on the Chat toggle (right panel) and, while the
// writer isn't currently in the room, the Sprint Room icon in the sidebar.
async function fetchUnreadNotificationCount(userId) {
  return prisma.sprintRoomNotification.count({
    where: { userId, read: false },
  });
}

// Called when the writer opens the chat panel — clears the badge.
async function markNotificationsRead(userId) {
  return prisma.sprintRoomNotification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}

module.exports = {
  fetchOrCreateDefaultRoom,
  fetchRoomById,
  fetchSprintingMembers,
  joinRoom,
  heartbeat,
  leaveRoom,
  fetchRoomMembers,
  postMessage,
  fetchRoomMessages,
  deleteMessage,
  fetchUnreadNotificationCount,
  markNotificationsRead,
};