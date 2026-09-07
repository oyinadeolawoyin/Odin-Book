// src/routes/mailboxroutes.js
const express = require("express");
const router = express.Router();
const mailboxController = require("../controllers/mailboxController");
const { authenticateJWT } = require("../config/jwt");

// Everything here requires auth — unlike Sprint Room's GET /, there's no
// "lurker" view of someone's mailbox; sent/received cards are private to
// that writer.
router.get("/received", authenticateJWT, mailboxController.fetchReceivedCards);
router.get("/sent", authenticateJWT, mailboxController.fetchSentCards);
router.get("/unread-count", authenticateJWT, mailboxController.fetchUnreadCount);
router.post("/cards", authenticateJWT, mailboxController.sendCard);
router.post("/cards/:cardId/read", authenticateJWT, mailboxController.markCardRead);

module.exports = router;