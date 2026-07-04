const express = require("express");
const router  = express.Router();
const miniChallengeController = require("../controllers/minichallengecontroller");
const { authenticateJWT } = require("../config/jwt");

// ─── Templates ─────────────────────────────────────────────────────────────────
// Read requires login so req.user is populated — needed for the admin-only
// includeInactive view (paused templates are hidden from everyone else
// anyway, so this doesn't remove any real public capability); write is
// further gated to ADMIN in the controller.

router.get(   "/templates",              authenticateJWT, miniChallengeController.getTemplates);
router.post(  "/templates",              authenticateJWT, miniChallengeController.createTemplate);
router.put(   "/templates/:templateId",  authenticateJWT, miniChallengeController.updateTemplate);
router.patch( "/templates/:templateId/active", authenticateJWT, miniChallengeController.setTemplateActive);

// ─── Current challenge + progress ──────────────────────────────────────────────

router.get("/current",      miniChallengeController.getCurrentChallenge);
router.get("/leaderboard",  miniChallengeController.getLeaderboard); // public — recently-active writers' progress
router.get("/my-progress",  authenticateJWT, miniChallengeController.getMyProgress);
router.post("/progress",    authenticateJWT, miniChallengeController.getProgressForUsers); // admin batch view

// ─── Badges ────────────────────────────────────────────────────────────────────

router.get( "/badges/my",           authenticateJWT, miniChallengeController.getMyBadges);
router.post("/badges/:badgeId/claim", authenticateJWT, miniChallengeController.claimBadge);

module.exports = router;