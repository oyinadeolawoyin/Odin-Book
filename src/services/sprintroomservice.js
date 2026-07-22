const prisma = require("../config/prismaClient");

// A member counts as "currently in the room" if they have a presence row
// with leftAt still null AND a heartbeat within this window. This lets a
// dropped connection (closed tab, dead socket) age out of the "who's here"
// list without requiring an explicit leave call.
const PRESENCE_STALE_MS = 60 * 1000; // 60s — pair with a ~20-30s client heartbeat

// Self-reported "what I'm doing" flag — purely informational, shown on a
// writer's member card so the room can see who's drafting/editing/outlining.
const WRITER_STATUSES = new Set(["DRAFTING", "EDITING", "OUTLINING"]);

// ─── ROOM LOOKUP ───────────────────────────────────────────────

// Single default room for now — mirrors the "just one room" design.
// Kept as a lookup rather than a hardcoded id so a second room could be
// introduced later without touching call sites.
async function fetchOrCreateDefaultRoom() {
  const existing = await prisma.sprintRoom.findFirst({ orderBy: { id: "asc" } });
  if (existing) return existing;
  return prisma.sprintRoom.create({ data: { name: "Sprint Room" } });
}

// The GroupSprint currently running (if any) — used to show the countdown
// timer to EVERYONE in the room, including people who haven't clicked
// "Join Sprint" yet. Room membership and sprint participation are separate
// on purpose, but the timer itself should be visible to the whole room.
//
// Also includes each participant's individual Sprint row (user + soundscape)
// so the room grid/strip can show who's currently sprinting and what
// they're listening to — without this, the frontend has no way to know who
// joined, since presence (who's in the room) and sprint participation are
// tracked separately.
async function fetchCurrentGroupSprint() {
  return prisma.groupSprint.findFirst({
    where: { isActive: true },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      startedAt: true,
      duration: true,
      sprintType: true,
      userId: true,
      sprints: {
        // No isActive filter here on purpose: a member's row used to
        // disappear from this list — and therefore from the total —
        // the instant their sprint ended (checkout, leave, or a draft
        // switch triggering a checkout+rejoin). The frontend already
        // picks the right row per user (active one, falling back to
        // their most recent) via the isActive field below, so it's safe
        // to hand over every row for this group sprint instead of only
        // the currently-active ones.
        select: {
          id: true,
          userId: true,
          isActive: true,
          wordsWritten: true,
          user: { select: { id: true, username: true, avatar: true } },
          soundscape: { select: { id: true, name: true } },
        },
      },
    },
  });
}

// ─── PRESENCE ──────────────────────────────────────────────────

async function joinRoom(sprintRoomId, userId) {
  return prisma.sprintRoomPresence.upsert({
    where: { sprintRoomId_userId: { sprintRoomId, userId } },
    // status starts neutral (null) on a fresh join; a returning writer who
    // never explicitly left (leftAt still null from a stale session) keeps
    // whatever status they last set rather than being reset under them.
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
    data: { leftAt: new Date(), status: null },
  });
}

// Writer picks their own status from the fixed set — purely a display flag,
// nothing else in the app reads or enforces it. Pass null to clear it.
async function setStatus(sprintRoomId, userId, status) {
  if (status != null && !WRITER_STATUSES.has(status)) {
    throw new Error("Unknown status");
  }
  const updated = await prisma.sprintRoomPresence.updateMany({
    where: { sprintRoomId, userId, leftAt: null },
    data: { status: status || null },
  });
  if (updated.count === 0) throw new Error("You're not currently in this room");
  return prisma.sprintRoomPresence.findUnique({
    where: { sprintRoomId_userId: { sprintRoomId, userId } },
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

// ─── MESSAGES ──────────────────────────────────────────────────

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

// Fixed set of soundboard sounds the room supports — keeping this as an
// allowlist (rather than trusting whatever string the client sends) means a
// SOUND message's key always maps to a real, known sound file, and nobody
// can smuggle arbitrary content through the soundKey field.
const SOUND_KEYS = new Set(["clap", "tada", "cheer", "support"]);

async function postMessage(sprintRoomId, senderId, content, quotedMessageId, options = {}) {
  const { messageType = "TEXT", mediaUrl = null, soundKey = null } = options;

  if (messageType === "GIF" && !mediaUrl) {
    throw new Error("A GIF message requires a mediaUrl");
  }
  if (messageType === "SOUND" && !SOUND_KEYS.has(soundKey)) {
    throw new Error("Unknown soundKey");
  }

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

  // Mentions only make sense for real typed text — a GIF or a soundboard
  // clap never carries an @handle worth resolving.
  const mentionedUsers = messageType === "TEXT" ? await resolveMentions(content) : [];

  const message = await prisma.sprintRoomMessage.create({
    data: {
      sprintRoomId,
      senderId,
      content,
      messageType,
      mediaUrl,
      soundKey,
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

// ─── GIFS (Tenor) ──────────────────────────────────────────────

// Proxied server-side so the Tenor key never ships to the browser. Set
// TENOR_API_KEY in the environment. An empty query returns Tenor's
// "featured" (trending) feed, matching the picker's default view.
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const TENOR_CLIENT_KEY = "quillweave";

async function searchGifs(query, { limit = 24, pos } = {}) {
  if (!TENOR_API_KEY) throw new Error("Tenor is not configured");

  const trimmed = (query || "").trim();
  const endpoint = trimmed
    ? "https://tenor.googleapis.com/v2/search"
    : "https://tenor.googleapis.com/v2/featured";

  const url = new URL(endpoint);
  url.searchParams.set("key", TENOR_API_KEY);
  url.searchParams.set("client_key", TENOR_CLIENT_KEY);
  url.searchParams.set("limit", String(Math.min(limit, 50)));
  url.searchParams.set("media_filter", "gif");
  url.searchParams.set("contentfilter", "medium");
  if (trimmed) url.searchParams.set("q", trimmed);
  if (pos) url.searchParams.set("pos", String(pos));

  const res = await fetch(url);
  if (!res.ok) throw new Error("Tenor request failed");
  const data = await res.json();

  const gifs = (data.results || [])
    .map((item) => {
      const gif = item.media_formats?.gif;
      const tinyGif = item.media_formats?.tinygif || gif;
      return {
        id: item.id,
        title: item.content_description || "",
        url: gif?.url,
        previewUrl: tinyGif?.url,
        width: gif?.dims?.[0],
        height: gif?.dims?.[1],
      };
    })
    .filter((g) => g.url);

  return { gifs, next: data.next || null };
}

module.exports = {
  fetchOrCreateDefaultRoom,
  fetchCurrentGroupSprint,
  joinRoom,
  heartbeat,
  leaveRoom,
  setStatus,
  fetchRoomMembers,
  postMessage,
  fetchRoomMessages,
  deleteMessage,
  searchGifs,
  fetchUnreadNotificationCount,
  markNotificationsRead,
  SOUND_KEYS,
  WRITER_STATUSES,
};