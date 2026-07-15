const express = require("express");
const router  = express.Router();
const threadController = require("../controllers/threadcontroller");
const { authenticateJWT } = require("../config/jwt");
const upload = require("../config/multer");

// ─── Member search for @mention autocomplete ─────────────────────────────────

router.get("/members/search", authenticateJWT, threadController.searchMembers);

// ─── Daily challenge thread (public) ─────────────────────────────────────────

router.get("/daily-challenge", threadController.getDailyThread);

// ─── Profile stats (authenticated) ───────────────────────────────────────────

router.get("/stats/mine", authenticateJWT, threadController.getMyDiscussionStats);

// ─── Thread tags (public, fixed list) ────────────────────────────────────────

router.get("/tags", threadController.getTags);

// Shared multi-image upload config — up to five images per post, used for
// thread posts, comments, and replies alike.
const MEDIA_FIELDS = [
  { name: "media_0", maxCount: 1 },
  { name: "media_1", maxCount: 1 },
  { name: "media_2", maxCount: 1 },
  { name: "media_3", maxCount: 1 },
  { name: "media_4", maxCount: 1 },
];

// ─── Threads ──────────────────────────────────────────────────────────────────
// Any authenticated member can create a thread.
// Members can edit or delete their own threads (guard is in the controller).
// Admins can edit or delete any thread, and are the only ones who can pin
// or deprioritize a thread.
//
// Filter by tag: GET /threads?tag=Craft

router.get(   "/pinned-and-today", threadController.getPinnedAndTodayThreads);
router.get(   "/pinned",           threadController.getPinnedThreads);
router.get(   "/latest",           threadController.getLatestThreads);
router.get(   "/active",           threadController.getActiveThreads);
router.get(   "/",          threadController.getThreads);
router.get(   "/:threadId", threadController.getThread);
router.post(  "/",          authenticateJWT, upload.fields(MEDIA_FIELDS), threadController.createThread);
router.put(   "/:threadId", authenticateJWT, upload.fields(MEDIA_FIELDS), threadController.updateThread);
router.delete("/:threadId", authenticateJWT,                              threadController.deleteThread);

router.post("/:threadId/like", authenticateJWT, threadController.toggleLike);

// ─── Comments (public read, authenticated write) ───────────────────────────────

router.get(   "/:threadId/comments",              threadController.getComments);
router.post(  "/:threadId/comments",              authenticateJWT, upload.fields(MEDIA_FIELDS), threadController.addComment);
router.delete("/:threadId/comments/:commentId",   authenticateJWT, threadController.deleteComment);
router.post(  "/:threadId/comments/:commentId/like", authenticateJWT, threadController.toggleCommentLike);

// ─── Replies (public read, authenticated write) ────────────────────────────────

router.get(   "/:threadId/comments/:commentId/replies",                          threadController.getReplies);
router.post(  "/:threadId/comments/:commentId/replies",                          authenticateJWT, upload.fields(MEDIA_FIELDS), threadController.addReply);
router.delete("/:threadId/comments/:commentId/replies/:replyId",                 authenticateJWT, threadController.deleteReply);
router.post(  "/:threadId/comments/:commentId/replies/:replyId/like",            authenticateJWT, threadController.toggleReplyLike);

module.exports = router;