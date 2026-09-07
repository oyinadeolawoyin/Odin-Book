// src/services/directMessageService.js
const prisma = require("../config/prismaClient");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MESSAGE_PAGE_SIZE = 30; // messages per page, newest-first

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Canonical pair ordering: always store the lower ID as userAId.
// This means the pair (3, 7) and the pair (7, 3) map to the same room.
function orderedPair(idA, idB) {
  return idA < idB
    ? { userAId: idA, userBId: idB }
    : { userAId: idB, userBId: idA };
}

// Shape a raw message row into what the API returns.
// Replaces the content of soft-deleted messages with a placeholder.
function formatMessage(msg) {
  const isDeleted = !!msg.deletedAt;
  return {
    id:               msg.id,
    conversationId:   msg.conversationId,
    senderId:         msg.senderId,
    senderUsername:   msg.sender?.username ?? null,
    senderAvatar:     msg.sender?.avatar   ?? null,
    content:          isDeleted ? null : msg.content,
    isDeleted,
    // Quote context — only shown if this message is replying to another
    quotedMessage: msg.quotedMessageId
      ? {
          id:         msg.quotedMessageId,
          content:    msg.quotedContent   ?? null, // snapshot
          senderName: msg.quotedSenderName ?? null, // snapshot
        }
      : null,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
  };
}

// Is this conversation unread for this user? Single source of truth for the
// check — used by listConversations (per-row dot) and fetchUnreadCount
// (sidebar badge), so the two can never drift out of sync with each other.
function isUnreadForUser(conversation, userId) {
  const last = conversation.messages[0];
  if (!last || last.senderId === userId) return false;

  const isUserA    = conversation.userAId === userId;
  const myLastRead = isUserA ? conversation.lastReadByA : conversation.lastReadByB;

  return !myLastRead || last.createdAt > myLastRead;
}

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────

// Get or create the conversation room between two users.
// Returns the conversation with a preview of the most recent message.
async function getOrCreateConversation(requestingUserId, otherUserId) {
  if (requestingUserId === otherUserId)
    throw new Error("You can't start a conversation with yourself");

  // Make sure the other user actually exists and isn't deleted
  const otherUser = await prisma.user.findUnique({
    where:  { id: otherUserId },
    select: { id: true, username: true, avatar: true, isDeleted: true },
  });
  if (!otherUser || otherUser.isDeleted)
    throw new Error("User not found");

  const pair = orderedPair(requestingUserId, otherUserId);

  const conversation = await prisma.directConversation.upsert({
    where:  { userAId_userBId: pair },
    create: pair,
    update: {}, // already exists — nothing to change
    include: {
      userA: { select: { id: true, username: true, avatar: true } },
      userB: { select: { id: true, username: true, avatar: true } },
      messages: {
        where:   { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take:    1,
        include: { sender: { select: { id: true, username: true } } },
      },
    },
  });

  const other = conversation.userAId === requestingUserId
    ? conversation.userB
    : conversation.userA;

  const lastMessage = conversation.messages[0] ?? null;

  return {
    id:           conversation.id,
    otherUser:    other,
    lastMessage:  lastMessage
      ? {
          content:   lastMessage.content,
          senderId:  lastMessage.senderId,
          createdAt: lastMessage.createdAt,
        }
      : null,
    createdAt: conversation.createdAt,
  };
}

// List all conversations the requesting user is part of, sorted by most
// recently active (newest message first). Used to render the inbox list.
async function listConversations(userId) {
  const conversations = await prisma.directConversation.findMany({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    include: {
      userA: { select: { id: true, username: true, avatar: true } },
      userB: { select: { id: true, username: true, avatar: true } },
      messages: {
        where:   { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take:    1,
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  return conversations.map((c) => {
    const other = c.userAId === userId ? c.userB : c.userA;
    const last  = c.messages[0] ?? null;

    return {
      id:        c.id,
      otherUser: other,
      unread:    isUnreadForUser(c, userId),
      lastMessage: last
        ? {
            content:   last.deletedAt ? null : last.content,
            senderId:  last.senderId,
            createdAt: last.createdAt,
          }
        : null,
      updatedAt: c.updatedAt,
    };
  });
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

// Fetch a page of messages for a conversation, newest first (cursor-based).
// The caller flips the display order on the frontend (oldest at top, like a
// real chat). Pass `beforeId` to paginate backwards through older messages.
async function getMessages(userId, conversationId, { beforeId } = {}) {
  // Verify the user is actually a participant in this conversation
  const conversation = await prisma.directConversation.findUnique({
    where:  { id: conversationId },
    select: { userAId: true, userBId: true },
  });
  if (!conversation) throw new Error("Conversation not found");
  if (conversation.userAId !== userId && conversation.userBId !== userId)
    throw new Error("Not authorised");

  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId,
      ...(beforeId ? { id: { lt: beforeId } } : {}),
    },
    orderBy: { id: "desc" }, // newest first — frontend reverses for display
    take:    MESSAGE_PAGE_SIZE,
    include: {
      sender: { select: { id: true, username: true, avatar: true } },
    },
  });

  return {
    messages:   messages.map(formatMessage),
    hasMore:    messages.length === MESSAGE_PAGE_SIZE,
    nextCursor: messages.length === MESSAGE_PAGE_SIZE
      ? messages[messages.length - 1].id
      : null,
  };
}

// Send a new message. If quotedMessageId is provided, we snapshot the quoted
// message's content and sender name at send time — so the quote survives even
// if the original is later deleted.
async function sendMessage(senderId, conversationId, { content, quotedMessageId }) {
  if (!content?.trim()) throw new Error("Message content is required");

  // Verify sender is a participant
  const conversation = await prisma.directConversation.findUnique({
    where:  { id: conversationId },
    select: { userAId: true, userBId: true },
  });
  if (!conversation) throw new Error("Conversation not found");
  if (conversation.userAId !== senderId && conversation.userBId !== senderId)
    throw new Error("Not authorised");

  // Resolve quote snapshot if needed
  let quotedContent    = null;
  let quotedSenderName = null;

  if (quotedMessageId) {
    const quoted = await prisma.directMessage.findUnique({
      where:   { id: quotedMessageId },
      include: { sender: { select: { username: true } } },
    });
    // Only quote messages from this same conversation
    if (!quoted || quoted.conversationId !== conversationId)
      throw new Error("Quoted message not found in this conversation");

    // Snapshot — use the original text if available, otherwise note it was deleted
    quotedContent    = quoted.deletedAt ? "(deleted message)" : quoted.content;
    quotedSenderName = quoted.sender?.username ?? "Unknown";
  }

  const message = await prisma.directMessage.create({
    data: {
      conversationId,
      senderId,
      content:          content.trim(),
      quotedMessageId:  quotedMessageId ?? null,
      quotedContent,
      quotedSenderName,
    },
    include: {
      sender: { select: { id: true, username: true, avatar: true } },
    },
  });

  // Bump conversation's updatedAt so inbox sorts correctly
  await prisma.directConversation.update({
    where: { id: conversationId },
    data:  { updatedAt: new Date() },
  });

  // ── Recipient lookup ───────────────────────────────────────────────────────
  // The controller handles actually firing the notification (fire-and-forget,
  // after the response is sent) — here we just hand back what it needs to do
  // that: who to notify, and the sender's name for the notification copy.
  const recipientId = conversation.userAId === senderId
    ? conversation.userBId
    : conversation.userAId;

  const [sender, recipient] = await Promise.all([
    prisma.user.findUnique({ where: { id: senderId }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: recipientId }, select: { id: true, username: true, email: true } }),
  ]);

  return {
    message:    formatMessage(message),
    recipient:  recipient ?? null,
    senderName: sender?.username ?? "Someone",
    isReply:    !!quotedMessageId,
  };
}

// Soft-delete a message. Only the sender can delete their own message.
async function deleteMessage(userId, messageId) {
  const message = await prisma.directMessage.findUnique({
    where:  { id: messageId },
    select: { id: true, senderId: true, deletedAt: true },
  });
  if (!message)          throw new Error("Message not found");
  if (message.senderId !== userId) throw new Error("Not authorised");
  if (message.deletedAt) throw new Error("Message already deleted");

  await prisma.directMessage.update({
    where: { id: messageId },
    data:  { deletedAt: new Date() },
  });

  return { message: "Message deleted" };
}

/**
 * Mark a conversation as read for the requesting user.
 * Sets lastReadByA or lastReadByB to now().
 * Called whenever the user opens the Messages page or a specific conversation.
 */
async function markConversationRead(userId, conversationId) {
  const conversation = await prisma.directConversation.findUnique({
    where:  { id: conversationId },
    select: { userAId: true, userBId: true },
  });
  if (!conversation) throw new Error("Conversation not found");
  if (conversation.userAId !== userId && conversation.userBId !== userId)
    throw new Error("Not authorised");
 
  const isUserA = conversation.userAId === userId;
 
  await prisma.directConversation.update({
    where: { id: conversationId },
    data:  isUserA
      ? { lastReadByA: new Date() }
      : { lastReadByB: new Date() },
  });
 
  return { ok: true };
}


// Powers the Inbox sidebar badge — same idea as mailboxService.fetchUnreadCount:
// its own small dedicated query, so the badge never depends on the shared
// /notifications/unread-counts endpoint (or breaks if that route ever does).
async function fetchUnreadCount(userId) {
  const conversations = await prisma.directConversation.findMany({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: {
      userAId:     true,
      userBId:     true,
      lastReadByA: true,
      lastReadByB: true,
      messages: {
        where:   { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take:    1,
        select:  { senderId: true, createdAt: true },
      },
    },
  });

  return conversations.filter((c) => isUnreadForUser(c, userId)).length;
}

module.exports = {
  getOrCreateConversation,
  listConversations,
  getMessages,
  sendMessage,
  deleteMessage,
  markConversationRead,
  fetchUnreadCount
};