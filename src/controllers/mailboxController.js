// src/controllers/mailboxcontroller.js
const mailboxService = require("../services/mailboxService");
const { notifyUser } = require("../services/notificationService");

const VALID_CARD_TYPES = ["THANK_YOU", "WELL_DONE", "CONGRATS", "WELCOME", "BOOSTER", "BIRTHDAY"];

// Friendly copy per card type, used only for the notification text —
// the card's own `type` field stays the raw enum value everywhere else.
const CARD_TYPE_LABEL = {
  THANK_YOU: "a thank-you card",
  WELL_DONE: "a well-done card",
  CONGRATS:  "a congrats card",
  WELCOME:   "a welcome card",
  BOOSTER:   "a booster card",
  BIRTHDAY:  "a birthday card",
};

async function sendCard(req, res) {
  const senderId = Number(req.user.id);
  const { recipientId, type, note } = req.body;

  if (!recipientId || Number(recipientId) === senderId) {
    return res.status(400).json({ message: "A valid recipient is required." });
  }
  if (!VALID_CARD_TYPES.includes(type)) {
    return res.status(400).json({ message: "Invalid card type." });
  }
  if (!note || !note.trim()) {
    return res.status(400).json({ message: "A note is required to send a card." });
  }

  try {
    const { card, recipient } = await mailboxService.sendCard(senderId, Number(recipientId), type, note.trim());
    res.status(201).json({ card });

    // Notify the recipient (fire-and-forget) — type: "MAILBOX_CARD" so
    // notifyUser() skips writing an inbox/bell row (the Mailbox page +
    // sidebar badge already cover it) but still sends push/email per their
    // preferences. Same pattern as directMessageController.sendMessage.
    if (recipient) {
      const cardLabel = CARD_TYPE_LABEL[type] || "a card";

      notifyUser(
        recipient,
        `${card.sender.username} sent you ${cardLabel}`,
        `/mailbox`,
        "mailbox_card_received",
        "MAILBOX_CARD",
        card.sender.avatar,
        { kind: "mailbox_card", excerpt: note.trim() }
      ).catch(() => {});
    }
  } catch (error) {
    console.error("Send mailbox card error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchReceivedCards(req, res) {
  const userId = Number(req.user.id);
  const limit = Number(req.query.limit) || 30;
  const before = req.query.before || undefined;

  try {
    const cards = await mailboxService.fetchReceivedCards(userId, { limit, before });
    res.status(200).json({ cards });
  } catch (error) {
    console.error("Fetch received mailbox cards error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchSentCards(req, res) {
  const userId = Number(req.user.id);
  const limit = Number(req.query.limit) || 30;
  const before = req.query.before || undefined;

  try {
    const cards = await mailboxService.fetchSentCards(userId, { limit, before });
    res.status(200).json({ cards });
  } catch (error) {
    console.error("Fetch sent mailbox cards error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function markCardRead(req, res) {
  const cardId = Number(req.params.cardId);
  const recipientId = Number(req.user.id);

  try {
    const card = await mailboxService.markCardRead(cardId, recipientId);
    res.status(200).json({ card });
  } catch (error) {
    console.error("Mark mailbox card read error:", error);
    const status = error.message === "Not authorized to read this card" ? 403
      : error.message === "Card not found" ? 404
      : 500;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again later." });
  }
}

async function fetchUnreadCount(req, res) {
  const userId = Number(req.user.id);

  try {
    const count = await mailboxService.fetchUnreadCount(userId);
    res.status(200).json({ count });
  } catch (error) {
    console.error("Fetch mailbox unread count error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  sendCard,
  fetchReceivedCards,
  fetchSentCards,
  markCardRead,
  fetchUnreadCount,
};