const express = require("express");
const router = express.Router();
const sprintController = require("../controllers/sprintcontroller");
const { authenticateJWT } = require("../config/jwt");

// ─── SOLO SPRINT (minimal) ──────────────────────────────────────
// Duration in, check in when done. No group, no LiveKit, no bot.
router.get("/active", authenticateJWT, sprintController.fetchActiveSprint);
router.post("/start", authenticateJWT, sprintController.startSprint);
router.post("/:sprintId/checkin", authenticateJWT, sprintController.checkinSprint);

module.exports = router;