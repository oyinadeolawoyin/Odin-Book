// src/routes/directMessageRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/directmessagecontroller");
const { authenticateJWT } = require("../config/jwt");

// All DM routes require authentication
router.use(authenticateJWT);

// ─── INBOX ───────────────────────────────────────────────────────────────────

// GET /direct-messages
// All conversations the logged-in user is part of, sorted by latest activity.
// Use this to render the inbox / conversation list.
router.get("/", ctrl.listConversations);

// GET /direct-messages/unread-count
// Powers the Inbox sidebar badge on its own — same dedicated-endpoint
// pattern as GET /mailbox/unread-count, so this badge doesn't depend on
// (or break with) the shared /notifications/unread-counts endpoint.
router.get("/unread-count", ctrl.fetchUnreadCount);

// ─── CONVERSATION ROOM ────────────────────────────────────────────────────────

// POST /direct-messages/conversations/:userId
// Open (or return) the private room between the logged-in user and :userId.
// Safe to call on every page load — idempotent, returns the same room if it
// already exists. The frontend calls this when a user clicks "Message" on
// someone's profile, then redirects to /messages/:conversationId.
router.post("/conversations/:userId", ctrl.getOrCreateConversation);

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

// GET /direct-messages/conversations/:conversationId/messages
// Paginated message history, newest first.
// Optional query param: ?beforeId=<messageId> for loading older messages.
// Response: { messages: [...], hasMore: boolean, nextCursor: number | null }
router.get("/conversations/:conversationId/messages", ctrl.getMessages);

// POST /direct-messages/conversations/:conversationId/messages
// Send a message.
// Body: { content: string, quotedMessageId?: number }
// If quotedMessageId is set, the response includes a quotedMessage object so
// the frontend can render the quote bubble immediately without a refetch.
router.post("/conversations/:conversationId/messages", ctrl.sendMessage);

// DELETE /direct-messages/messages/:messageId
// Soft-delete a message (only the sender can do this).
// The message stays in the conversation with content replaced by a placeholder.
router.delete("/messages/:messageId", ctrl.deleteMessage);

// PATCH /direct-messages/conversations/:conversationId/read
// Call this whenever the user opens a conversation to clear its unread count.
router.patch("/conversations/:conversationId/read", ctrl.markConversationRead);

module.exports = router;