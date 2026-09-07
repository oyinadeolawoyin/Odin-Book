// src/routes/profileRoutes.js

const express = require("express");
const router  = express.Router();
const {
  getProfile,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  likeProfile,
  unlikeProfile,
  updateMyProfile,
} = require("../controllers/profilecontroller");
const { authenticateJWT, optionalJWT } = require("../config/jwt");

// GET /api/profile/:userId
// Public — no auth required to view. optionalJWT attaches req.user when a
// valid token cookie is present (so isFollowing/isLiked reflect the real
// viewer) but never blocks the request when it's missing/invalid.
router.get("/:userId", optionalJWT, getProfile);

// GET /api/profile/:userId/followers
// GET /api/profile/:userId/following
router.get("/:userId/followers", getFollowers);
router.get("/:userId/following", getFollowing);

// POST/DELETE /api/profile/:userId/follow
// Auth required — the logged-in writer follows/unfollows :userId.
router.post("/:userId/follow", authenticateJWT, followUser);
router.delete("/:userId/follow", authenticateJWT, unfollowUser);

// POST/DELETE /api/profile/:userId/like
// Auth required — the logged-in writer likes/unlikes :userId's profile.
router.post("/:userId/like", authenticateJWT, likeProfile);
router.delete("/:userId/like", authenticateJWT, unlikeProfile);

// PATCH /api/profile/me
// Auth required — update your own country / genre / funFact / sprint prefs.
router.patch("/me", authenticateJWT, updateMyProfile);

module.exports = router;