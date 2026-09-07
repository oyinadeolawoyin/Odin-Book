// src/routes/workspaceRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/workspacecontroller");
const { authenticateJWT } = require("../config/jwt");

// ─── COMMUNITY FEEDS ─────────────────────────────────────────────────────────
// Public — req.user only used (when present) to flag the caller's own entry.

// All writers actively working toward their weekly target (base list —
// moved here from /draftplan/weekly-target).
router.get("/weekly-target", ctrl.getWeeklyTargetFeed);

// ...of those, the ones who haven't written yet today.
router.get("/draftplan-feed", ctrl.getDraftPlanFeed);

// ...of those, the ones who HAVE written today. Lightweight — no per-member
// streaks/history/totals, see workspacecontroller.js.
router.get("/", ctrl.getWorkspaceFeed);

// Writers who've already met their weekly target this week. Frontend only
// surfaces this on Sundays — endpoint itself isn't day-gated, since "whose
// Sunday" depends on the viewer's own local time.
router.get("/weekly-winners", ctrl.getWeeklyWinners);

// Writers who've completed a draft plan in the last couple weeks.
router.get("/finished-drafts", ctrl.getFinishedDraftsFeed);

// Top 6 current streaks workspace-wide, 6-day minimum to qualify.
router.get("/top-streaks", ctrl.getTopStreaks);

// ─── OWN STATS / PROFILE (authenticated) ──────────────────────────────────

router.get("/me/stats",             authenticateJWT, ctrl.getMyStats);
router.get("/me/weekly-goal-plan",  authenticateJWT, ctrl.getMyWeeklyGoalPlan);
router.get("/me/activity-series",   authenticateJWT, ctrl.getMyActivitySeries);
router.post("/send-card",           authenticateJWT, ctrl.sendCard);
router.get("/me/profile",   authenticateJWT, ctrl.getMyProfile);
router.patch("/me/profile", authenticateJWT, ctrl.updateMyProfile);

module.exports = router;