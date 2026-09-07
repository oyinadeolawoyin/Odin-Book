const express = require("express");
const router  = express.Router();
const notificationsController = require("../controllers/notificationController");
const { authenticateJWT }     = require("../config/jwt");

// ── IMPORTANT: static routes must come before param routes ───────────────────
router.get("/unread-counts",      authenticateJWT, notificationsController.getUnreadCounts);
router.get("/preferences",        authenticateJWT, notificationsController.getPreferences);

router.get("/",                   authenticateJWT, notificationsController.getNotifications);
router.post("/save-subscription", authenticateJWT, notificationsController.saveSubscription);
router.post("/preferences",       authenticateJWT, notificationsController.savePreferences);

// ── Param route last — so "/unread-counts" etc. are never treated as :userId ─
router.post("/:userId/read",      authenticateJWT, notificationsController.markRead);
module.exports = router;