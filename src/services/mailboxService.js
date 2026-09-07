// src/services/mailboxservice.js
const prisma = require("../config/prismaClient");

const CARD_INCLUDE_SENDER = {
  sender: { select: { id: true, username: true, avatar: true } },
};
const CARD_INCLUDE_RECIPIENT = {
  recipient: { select: { id: true, username: true, avatar: true } },
};

async function sendCard(senderId, recipientId, type, note) {
  return prisma.mailboxCard.create({
    data: { senderId, recipientId, type, note },
    include: CARD_INCLUDE_SENDER,
  });
}

// Newest first, same before-cursor pagination style as
// sprintroomservice.fetchRoomMessages.
async function fetchReceivedCards(userId, { limit = 30, before } = {}) {
  return prisma.mailboxCard.findMany({
    where: {
      recipientId: userId,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: CARD_INCLUDE_SENDER,
  });
}

async function fetchSentCards(userId, { limit = 30, before } = {}) {
  return prisma.mailboxCard.findMany({
    where: {
      senderId: userId,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: CARD_INCLUDE_RECIPIENT,
  });
}

// Only the recipient can mark their own card read — matches the
// senderId-ownership check pattern sprintroomservice.deleteMessage uses.
async function markCardRead(cardId, recipientId) {
  const card = await prisma.mailboxCard.findUnique({ where: { id: cardId } });
  if (!card) throw new Error("Card not found");
  if (card.recipientId !== recipientId) throw new Error("Not authorized to read this card");
  if (card.readAt) return card; // already read — no-op, not an error

  return prisma.mailboxCard.update({
    where: { id: cardId },
    data: { readAt: new Date() },
  });
}

// Powers a mailbox badge, same idea as
// sprintroomservice.fetchUnreadNotificationCount.
async function fetchUnreadCount(userId) {
  return prisma.mailboxCard.count({
    where: { recipientId: userId, readAt: null },
  });
}

module.exports = {
  sendCard,
  fetchReceivedCards,
  fetchSentCards,
  markCardRead,
  fetchUnreadCount,
};