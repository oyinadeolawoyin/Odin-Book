// src/routes/draftPlanRoutes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/draftplancontroller");

const { authenticateJWT } = require("../config/jwt");
const upload = require("../config/multer");

// ─── COMMUNITY FEEDS ─────────────────────────────────────────────────────────

router.get("/active",       ctrl.getActiveDraftWriters);
router.get("/logged-today", ctrl.getWritersWhoLoggedToday);

// Same-day writing peers — requires auth since it's scoped to writers who
// share today as a writing day with the requesting user (checked in service).
// Includes peers who've already logged today (marked hasLoggedToday) as
// well as those still getting ready.
router.get("/scheduled-today", authenticateJWT, ctrl.getWritersScheduledToday);

// ─── PLAN (authenticated) ─────────────────────────────────────────────────────

router.post("/",    authenticateJWT, ctrl.createPlan);
router.get("/mine", authenticateJWT, ctrl.getMyPlan);
router.patch("/",   authenticateJWT, ctrl.updatePlan);
router.delete("/",  authenticateJWT, ctrl.deletePlan);

// ─── MOODBOARD IMAGE UPLOAD ───────────────────────────────────────────────────
// Uses the same multer + fileUploader pattern as thread media uploads.
// Returns { url } — the frontend appends it to moodboardImages then PATCHes /draftplan.
router.post("/upload-image", authenticateJWT, upload.single("image"), ctrl.uploadMoodboardImage);

// ─── PROGRESS LOGGING (authenticated) ────────────────────────────────────────

router.post("/progress", authenticateJWT, ctrl.logProgress);

module.exports = router;