const express = require("express");
const router = express.Router();
const sprintRoomController = require("../controllers/sprintroomcontroller");
const { authenticateJWT } = require("../config/jwt");

// ─── ROOM ──────────────────────────────────────────────────────
router.get("/", sprintRoomController.fetchRoom); // no auth — lurkers can see there's a room + current timer, per the two-tier visibility design

// ─── CHAT NOTIFICATIONS (badge — mentions/replies only, never the bell page) ─
// Static routes, kept above the /:sprintRoomId param block below.
router.get("/notifications/unread-count", authenticateJWT, sprintRoomController.getUnreadNotificationCount);
router.post("/notifications/read", authenticateJWT, sprintRoomController.markNotificationsRead);

// ─── PRESENCE ──────────────────────────────────────────────────
router.post("/:sprintRoomId/join", authenticateJWT, sprintRoomController.joinRoom);
router.post("/:sprintRoomId/heartbeat", authenticateJWT, sprintRoomController.heartbeat);
router.post("/:sprintRoomId/leave", authenticateJWT, sprintRoomController.leaveRoom);
router.patch("/:sprintRoomId/status", authenticateJWT, sprintRoomController.setStatus);
router.get("/:sprintRoomId/members", authenticateJWT, sprintRoomController.fetchRoomMembers);

// ─── MESSAGES ────────────────────────────────────────────────
router.get("/:sprintRoomId/messages", authenticateJWT, sprintRoomController.fetchRoomMessages);
router.post("/:sprintRoomId/messages", authenticateJWT, sprintRoomController.postMessage);
router.delete("/messages/:messageId", authenticateJWT, sprintRoomController.deleteMessage);

// ─── GIFS (Tenor) ────────────────────────────────────────────
// query-only path ("gifs/search"), so it never collides with the
// /:sprintRoomId/... param routes above.
router.get("/gifs/search", authenticateJWT, sprintRoomController.searchGifs);

module.exports = router;