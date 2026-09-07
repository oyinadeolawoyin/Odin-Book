// src/routes/draftPlanRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/draftplancontroller");

const { authenticateJWT } = require("../config/jwt");
const upload = require("../config/multer");

// Note: "/weekly-target" moved to GET /api/workspace/weekly-target — see
// workspaceroutes.js. "Working toward weekly target" is a workspace concept
// now (it's the base list the draft-plan/workspace split is built from).
//
// Multi-plan note: a writer can now hold several draft plans at once, so
// every plan-scoped route below is nested under /:planId. Ownership of
// planId is re-checked on every request in the service layer (see
// resolvePlan in draftplanservice.js) — a stale/foreign planId 404s the
// same way a missing plan always did.

// ─── PLAN LIST (authenticated) ────────────────────────────────────────────────
router.get("/mine", authenticateJWT, ctrl.getMyPlans);

// ─── PLAN CRUD (authenticated) ─────────────────────────────────────────────────

router.post("/",              authenticateJWT, ctrl.createPlan);
router.get("/:planId",        authenticateJWT, ctrl.getMyPlan);
router.patch("/:planId",      authenticateJWT, ctrl.updatePlan);
router.delete("/:planId",     authenticateJWT, ctrl.deletePlan);

// ─── TIMELINE ─────────────────────────────────────────────────────────────────
router.get("/:planId/timeline",  authenticateJWT, ctrl.getTimeline);
router.get("/:planId/history",   authenticateJWT, ctrl.getPlanHistory);
router.patch("/:planId/day-plan", authenticateJWT, ctrl.planDay);

// ─── MOODBOARD IMAGE UPLOAD ───────────────────────────────────────────────────
router.post("/:planId/upload-image", authenticateJWT, upload.single("image"), ctrl.uploadMoodboardImage);

// ─── PROGRESS LOGGING (authenticated) ────────────────────────────────────────
router.post("/:planId/progress", authenticateJWT, ctrl.logProgress);

// ─── BONUS QUEST ──────────────────────────────────────────────────────────────
// Opt-in "mystery chest" for days that AREN'T one of the writer's planned
// writing days — see DraftBonusQuest in schema.prisma. Kept fully outside
// /progress and DraftProgressLog on purpose: quest words never touch the
// story's word count.

router.post("/:planId/bonus-quest",          authenticateJWT, ctrl.openBonusQuest);
router.post("/:planId/bonus-quest/pick",     authenticateJWT, ctrl.pickBonusQuestPrompt);
router.post("/:planId/bonus-quest/decline",  authenticateJWT, ctrl.declineBonusQuest);
router.get("/:planId/bonus-quest/today",     authenticateJWT, ctrl.getTodaysBonusQuest);
router.post("/:planId/bonus-quest/progress", authenticateJWT, ctrl.logBonusQuestProgress);

module.exports = router;