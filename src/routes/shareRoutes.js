// src/routes/sharerroutes.js
const express = require("express");
const router = express.Router();
const shareController = require("../controllers/sharecontroller");

// All public, no auth — crawlers (X, Tumblr, iMessage, Slack unfurl, etc.)
// never carry a session cookie, and these need to work for logged-out
// visitors pasting a link anywhere. Same "no auth" reasoning as GET / on
// the sprint room itself.

// ─── Sprint Room (live-generated image) ──
router.get("/og/sprint-room/:roomId.png", shareController.fetchSprintRoomOgImage);
router.get("/share/sprint/:roomId", shareController.fetchSprintRoomSharePage);

// ─── Brag card (upload-once, static image) ──
router.post("/brag/upload", shareController.uploadBragImage);
router.get("/share/brag/:id", shareController.fetchBragSharePage);

module.exports = router;