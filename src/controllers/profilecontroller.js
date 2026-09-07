// src/controllers/profileController.js
//
// NOTE ON AUTH: protected routes use `authenticateJWT` (src/config/jwt.js);
// GET /:userId uses `optionalJWT` instead so it stays public but still picks
// up `req.user` when the viewer happens to be logged in (cookie `token`,
// payload has `.id`). Both are confirmed against src/config/jwt.js.

const profileService = require("../services/profileservice");
const prisma = require("../config/prismaClient");
const { notifyUser } = require("../services/notificationService");

/**
 * GET /api/profile/:userId
 * Public — no auth required. If the requester is logged in, pass their id
 * along so we can tell them whether they already follow/like this profile.
 */
async function getProfile(req, res) {
  const userId = Number(req.params.userId);

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  const viewerId = req.user?.id;

  try {
    const data = await profileService.getPublicProfile(userId, viewerId);
    res.json(data);
  } catch (err) {
    if (err.message === "User not found") {
      return res.status(404).json({ message: "Writer not found." });
    }
    console.error("Profile fetch error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * POST /api/profile/:userId/follow
 * Auth required. Follows the target user as the logged-in user.
 */
async function followUser(req, res) {
  const followingId = Number(req.params.userId);
  const followerId  = req.user?.id;

  if (!followerId) return res.status(401).json({ message: "Please log in." });
  if (!followingId || isNaN(followingId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    await profileService.followUser(followerId, followingId);
    res.status(201).json({ message: "Followed." });

    // Notify the writer who just got a new follower (fire-and-forget) —
    // gently nudges toward a Thank You card, but stays optional-sounding.
    // actorId is the follower, so clicking the notification opens the
    // follower's own profile popup (see notification.jsx), where "Send a
    // card" is right there if they feel like it.
    prisma.user.findUnique({
      where:  { id: followingId },
      select: { id: true, username: true, email: true },
    })
      .then((recipient) => {
        if (!recipient) return;
        return notifyUser(
          recipient,
          `${req.user.username} started following you. Feel free to send a Thank You card if you'd like to say hi back.`,
          `/${followerId}/user`,
          "new_follower",
          "GENERAL",
          req.user.avatar,
          { kind: "challenge_update", actorId: followerId },
          "COMMUNITY"
        );
      })
      .catch(() => {});
  } catch (err) {
    if (err.message === "You can't follow yourself.") {
      return res.status(400).json({ message: err.message });
    }
    console.error("Follow error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * DELETE /api/profile/:userId/follow
 * Auth required. Unfollows the target user.
 */
async function unfollowUser(req, res) {
  const followingId = Number(req.params.userId);
  const followerId  = req.user?.id;

  if (!followerId) return res.status(401).json({ message: "Please log in." });
  if (!followingId || isNaN(followingId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    await profileService.unfollowUser(followerId, followingId);
    res.status(200).json({ message: "Unfollowed." });
  } catch (err) {
    console.error("Unfollow error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * GET /api/profile/:userId/followers
 * Public. Paginated with ?limit= & ?cursor=
 */
async function getFollowers(req, res) {
  const userId = Number(req.params.userId);
  const limit  = req.query.limit ? Number(req.query.limit) : 20;
  const cursor = req.query.cursor ? Number(req.query.cursor) : undefined;

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    const followers = await profileService.getFollowers(userId, { limit, cursor });
    res.json({ followers });
  } catch (err) {
    console.error("Get followers error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * GET /api/profile/:userId/following
 * Public. Paginated with ?limit= & ?cursor=
 */
async function getFollowing(req, res) {
  const userId = Number(req.params.userId);
  const limit  = req.query.limit ? Number(req.query.limit) : 20;
  const cursor = req.query.cursor ? Number(req.query.cursor) : undefined;

  if (!userId || isNaN(userId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    const following = await profileService.getFollowing(userId, { limit, cursor });
    res.json({ following });
  } catch (err) {
    console.error("Get following error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * POST /api/profile/:userId/like
 * Auth required. Likes the target user's profile.
 */
async function likeProfile(req, res) {
  const likedUserId = Number(req.params.userId);
  const likerId      = req.user?.id;

  if (!likerId) return res.status(401).json({ message: "Please log in." });
  if (!likedUserId || isNaN(likedUserId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    await profileService.likeProfile(likerId, likedUserId);
    res.status(201).json({ message: "Liked." });

    // Notify the writer whose profile just got liked (fire-and-forget) —
    // same gentle, optional-sounding nudge as the new-follower notice.
    // actorId is the liker, so clicking opens their profile popup, where
    // "Send a card" is right there if they feel like it.
    prisma.user.findUnique({
      where:  { id: likedUserId },
      select: { id: true, username: true, email: true },
    })
      .then((recipient) => {
        if (!recipient) return;
        return notifyUser(
          recipient,
          `${req.user.username} liked your profile. Feel free to send a Thank You card if you'd like to.`,
          `/${likerId}/user`,
          "profile_liked",
          "GENERAL",
          req.user.avatar,
          { kind: "challenge_update", actorId: likerId },
          "COMMUNITY"
        );
      })
      .catch(() => {});
  } catch (err) {
    if (err.message === "You can't like your own profile.") {
      return res.status(400).json({ message: err.message });
    }
    console.error("Like profile error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * DELETE /api/profile/:userId/like
 * Auth required. Removes a like from the target user's profile.
 */
async function unlikeProfile(req, res) {
  const likedUserId = Number(req.params.userId);
  const likerId      = req.user?.id;

  if (!likerId) return res.status(401).json({ message: "Please log in." });
  if (!likedUserId || isNaN(likedUserId)) {
    return res.status(400).json({ message: "Invalid user ID." });
  }

  try {
    await profileService.unlikeProfile(likerId, likedUserId);
    res.status(200).json({ message: "Unliked." });
  } catch (err) {
    console.error("Unlike profile error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

/**
 * PATCH /api/profile/me
 * Auth required. Updates the logged-in user's own profile extras:
 * country, genre, funFact, favoriteSprintTime, favoriteSprintDays.
 */
async function updateMyProfile(req, res) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: "Please log in." });

  const { country, genre, funFact, favoriteSprintTime, favoriteSprintDays, allowAskMeAnything } = req.body;

  try {
    const updated = await profileService.updateProfileExtras(userId, {
      country, genre, funFact, favoriteSprintTime, favoriteSprintDays, allowAskMeAnything,
    });
    res.json(updated);
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Something went wrong." });
  }
}

module.exports = {
  getProfile,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  likeProfile,
  unlikeProfile,
  updateMyProfile,
};