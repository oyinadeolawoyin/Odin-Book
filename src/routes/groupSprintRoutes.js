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
// Draft switch mid-sprint — same sprint row, re-anchors its baseline. Not a
// rejoin/join call, since the writer never left the sprint.
router.post("/:sprintId/rebaseline", authenticateJWT, groupSprintController.rebaselineSprint);
router.post("/:sprintId/leave", authenticateJWT, groupSprintController.leaveSprint);
// Fire-and-forget background sync while a sprint is still running — persists
// the live word count so it isn't lost if the writer closes the tab or
// navigates away before checking out properly.
router.post("/:sprintId/progress", authenticateJWT, groupSprintController.updateSprintProgress);

// ─── Dynamic routes last ──────────────────────────────────────
router.get("/:groupSprintId/livekit-token", authenticateJWT, groupSprintController.getLiveKitToken);
router.get("/:groupSprintId", authenticateJWT, groupSprintController.fetchGroupSprint);
router.post("/:groupSprintId/endGroupSprint", authenticateJWT, groupSprintController.endGroupSprint);

module.exports = router;