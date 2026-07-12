const express = require("express");
const router = express.Router();
const groupSprintController = require("../controllers/groupSprintController");
const { authenticateJWT } = require("../config/jwt");

// ─── Bot secret middleware ────────────────────────────────────

function requireBotSecret(req, res, next) {
  if (req.headers["x-bot-secret"] !== process.env.BOT_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// ─── GROUP SPRINT ─────────────────────────────────────────────
router.get("/activeGroupSprints", groupSprintController.fetchAllActiveGroupSprints);
router.get("/lastGroupSprint", groupSprintController.fetchLastGroupSprint);
router.post("/startGroupSprint", authenticateJWT, groupSprintController.startGroupSprint);

// ─── SPRINT ───────────────────────────────────────────────────
router.get("/loginUserSession", authenticateJWT, groupSprintController.fetchLoginUserSprint);
router.get("/history", authenticateJWT, groupSprintController.fetchUserSprintHistory);
router.get("/heatmap", authenticateJWT, groupSprintController.fetchUserSprintHeatmap);
router.post("/join", authenticateJWT, groupSprintController.joinSprint);
router.post("/:sprintId/checkout", authenticateJWT, groupSprintController.checkoutSprint);

// ─── Dynamic routes last ──────────────────────────────────────
router.get("/:groupSprintId/livekit-token", authenticateJWT, groupSprintController.getLiveKitToken);
router.get("/:groupSprintId", authenticateJWT, groupSprintController.fetchGroupSprint);
router.post("/:groupSprintIdendGroupSprint", authenticateJWT, groupSprintController.endGroupSprint);

module.exports = router;