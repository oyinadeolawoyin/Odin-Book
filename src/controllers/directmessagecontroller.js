// src/controllers/directMessageController.js
const dmService = require("../services/directmessageservice");
const { notifyUser } = require("../services/notificationService");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function errStatus(msg) {
  if (msg.includes("not found") || msg.includes("Not found")) return 404;
  if (msg.includes("Not authorised"))                          return 403;
  if (msg.includes("yourself"))                               return 400;
  if (msg.includes("already deleted"))                        return 409;
  return 400;
}

// ─── CONVERSATIONS ────────────────────────────────────────────────────────────

// GET /direct-messages
// Returns a list of all the requesting user's conversations, newest activity first.
async function listConversations(req, res) {
  try {
    const conversations = await dmService.listConversations(req.user.id);
    res.json(conversations);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// POST /direct-messages/conversations/:userId
// Opens (or returns) the conversation room with a specific user.
// Safe to call repeatedly — returns the same room if it already exists.
async function getOrCreateConversation(req, res) {
  try {
    const otherUserId = parseInt(req.params.userId, 10);
    if (isNaN(otherUserId)) return res.status(400).json({ message: "Invalid user ID" });

    const conversation = await dmService.getOrCreateConversation(req.user.id, otherUserId);
    res.json(conversation);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

// GET /direct-messages/conversations/:conversationId/messages
// Paginated message history for a conversation, newest-first.
// Pass ?beforeId=<messageId> to load older messages (cursor pagination).
async function getMessages(req, res) {
  try {
    const conversationId = parseInt(req.params.conversationId, 10);
    if (isNaN(conversationId)) return res.status(400).json({ message: "Invalid conversation ID" });

    const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : undefined;

    const result = await dmService.getMessages(req.user.id, conversationId, { beforeId });
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// POST /direct-messages/conversations/:conversationId/messages
// Send a new message.
// Body: { content: string, quotedMessageId?: number }
async function sendMessage(req, res) {
  try {
    const conversationId = parseInt(req.params.conversationId, 10);
    if (isNaN(conversationId)) return res.status(400).json({ message: "Invalid conversation ID" });

    const { content, quotedMessageId } = req.body;

    const result = await dmService.sendMessage(req.user.id, conversationId, {
      content,
      quotedMessageId: quotedMessageId ? parseInt(quotedMessageId, 10) : undefined,
    });

    res.status(201).json(result.message);

    // Notify the recipient (fire-and-forget) — type: "MESSAGE" so notifyUser()
    // skips writing an inbox/bell row (the Messages page + sidebar badge
    // already cover it) but still sends push/email per their preferences.
    if (result.recipient) {
      const notifMessage = result.isReply
        ? `${result.senderName} replied to your message`
        : `${result.senderName} sent you a message`;

      notifyUser(
        result.recipient,
        notifMessage,
        `/messages/${conversationId}`,
        "direct_message",
        "MESSAGE",
        { kind: "direct_message", excerpt: result.message.content }
      ).catch(() => {});
    }
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// DELETE /direct-messages/messages/:messageId
// Soft-deletes a message. Only the sender can delete their own message.
async function deleteMessage(req, res) {
  try {
    const messageId = parseInt(req.params.messageId, 10);
    if (isNaN(messageId)) return res.status(400).json({ message: "Invalid message ID" });

    const result = await dmService.deleteMessage(req.user.id, messageId);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

/**
 * PATCH /direct-messages/conversations/:conversationId/read
 * Called when the user opens a conversation. Clears the unread badge for it.
 */
async function markConversationRead(req, res) {
  try {
    const conversationId = parseInt(req.params.conversationId, 10);
    if (isNaN(conversationId))
      return res.status(400).json({ message: "Invalid conversation ID" });
 
    const result = await dmService.markConversationRead(req.user.id, conversationId);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}
 

module.exports = {
  listConversations,
  getOrCreateConversation,
  getMessages,
  sendMessage,
  deleteMessage,
  markConversationRead
};