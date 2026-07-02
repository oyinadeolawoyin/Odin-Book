const blogService = require("../services/blogService");
const { uploadFile, deleteFile } = require("../utilis/fileUploader");
const { notifyUser } = require("../services/notificationService");

// ─── Inline image upload (for rich-text editor content) ───────────────────────

async function uploadImage(req, res) {
  if (!req.file) return res.status(400).json({ message: "No file provided." });
  try {
    const url = await uploadFile(req.file);
    res.status(200).json({ url });
  } catch (error) {
    console.error("Inline image upload error:", error);
    res.status(500).json({ message: "Upload failed. Please try again." });
  }
}

// ─── Posts (Admin only for mutations) ────────────────────────────────────────

// Keep this in sync with POST_CATEGORIES in adminBlog.jsx and CATEGORIES in
// blog.jsx — a post's category must be one of these or it won't show up on
// the Community page's category sections.
const VALID_POST_CATEGORIES = [
  "Stories from Writers",
  "Writing Tips",
  "Finished Drafts",
  "Behind the Drafts",
  "Opinion Columns",
  "Community Update & News",
];

async function createPost(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }

  const { title, content, link, seriesId, seriesOrder, category, tag } = req.body;
  if (!content) return res.status(400).json({ message: "Content is required." });
  if (!category) return res.status(400).json({ message: "Category is required." });
  if (!VALID_POST_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: "Invalid category." });
  }

  try {
    let mediaUrl = null;
    if (req.file) {
      mediaUrl = await uploadFile(req.file);
    }

    let resolvedSeriesId = null;
    if (seriesId !== undefined && seriesId !== null && seriesId !== "") {
      resolvedSeriesId = Number(seriesId);
      const series = await blogService.findSeries(resolvedSeriesId);
      if (!series) return res.status(404).json({ message: "Series not found." });
    }

    const resolvedSeriesOrder =
      seriesOrder !== undefined && seriesOrder !== null && seriesOrder !== ""
        ? Number(seriesOrder)
        : undefined;

    const post = await blogService.createPost({
      title,
      content,
      mediaUrl,
      link,
      seriesId: resolvedSeriesId,
      seriesOrder: resolvedSeriesOrder,
      category: category || null,
      tag: tag || null,
    });

    res.status(201).json({ post });

    // Notify all members about the new community post (fire and forget).
    // Push/email only reach users who've opted in to "community_new_post"
    // (see OPT_IN_REQUIRED_KEYS in notificationService) — this is a
    // broadcast to every user, so unlike a single-recipient notice it
    // should be opt-in rather than opt-out. type: "COMMUNITY_UPDATE" also
    // means notifyUser() skips writing a bell-page row — the Community
    // Updates page + sidebar badge already cover that.
    blogService.getAllUsers().then((users) => {
      const notifLink = `/blog/${post.id}`;
      const postTitle = post.title ? `"${post.title}"` : "a new community post";
      users.forEach((user) => {
        if (user.id === req.user.id) return;
        notifyUser(
          user,
          `A new post has been published: ${postTitle}`,
          notifLink,
          "community_new_post",
          "COMMUNITY_UPDATE"
        ).catch(() => {});
      });
    }).catch(() => {});
  } catch (error) {
    console.error("Create blog post error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getPinnedPosts(req, res) {
  try {
    const posts = await blogService.getPinnedPosts();
    res.status(200).json({ posts });
  } catch (error) {
    console.error("Get pinned posts error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getPosts(req, res) {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const category = req.query.category || undefined;
  const tag = req.query.tag || undefined;
  try {
    const result = await blogService.getPosts({ page, limit, category, tag });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get blog posts error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getPost(req, res) {
  const postId = Number(req.params.postId);
  try {
    const post = await blogService.getPost(postId);
    if (!post) return res.status(404).json({ message: "Post not found." });
    res.status(200).json({ post });
  } catch (error) {
    console.error("Get blog post error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updatePost(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }

  const postId = Number(req.params.postId);
  const { title, content, link, seriesId, seriesOrder, category, tag } = req.body;

  // The admin form always sends category as a controlled <select>, so if it's
  // present in the request at all, it must be non-empty and valid — this is
  // what stops a post from silently losing its category during an edit.
  if (category !== undefined && (!category || !VALID_POST_CATEGORIES.includes(category))) {
    return res.status(400).json({ message: "Invalid category." });
  }

  try {
    const existing = await blogService.findPost(postId);
    if (!existing) return res.status(404).json({ message: "Post not found." });

    let mediaUrl;
    if (req.file) {
      if (existing.mediaUrl) await deleteFile(existing.mediaUrl);
      mediaUrl = await uploadFile(req.file);
    }

    let resolvedSeriesId;
    if (seriesId !== undefined) {
      if (seriesId === null || seriesId === "" || seriesId === "null") {
        resolvedSeriesId = null;
      } else {
        resolvedSeriesId = Number(seriesId);
        const series = await blogService.findSeries(resolvedSeriesId);
        if (!series) return res.status(404).json({ message: "Series not found." });
      }
    }

    const resolvedSeriesOrder =
      seriesOrder !== undefined && seriesOrder !== null && seriesOrder !== ""
        ? Number(seriesOrder)
        : undefined;

    const post = await blogService.updatePost(postId, {
      title,
      content,
      mediaUrl,
      link,
      seriesId: resolvedSeriesId,
      seriesOrder: resolvedSeriesOrder,
      category: category !== undefined ? (category || null) : undefined,
      tag: tag !== undefined ? (tag || null) : undefined,
    });
    res.status(200).json({ post });
  } catch (error) {
    console.error("Update blog post error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deletePost(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }

  const postId = Number(req.params.postId);
  try {
    const existing = await blogService.findPost(postId);
    if (!existing) return res.status(404).json({ message: "Post not found." });
    const mediaUrl = await blogService.deletePost(postId);
    if (mediaUrl) await deleteFile(mediaUrl);
    res.status(200).json({ message: "Post deleted successfully." });
  } catch (error) {
    console.error("Delete blog post error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function togglePin(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const postId = Number(req.params.postId);
  try {
    const result = await blogService.togglePostPin(postId);
    if (!result) return res.status(404).json({ message: "Post not found." });
    res.status(200).json(result);
  } catch (error) {
    console.error("Toggle pin error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function toggleLike(req, res) {
  const postId = Number(req.params.postId);
  const userId = req.user.id;
  try {
    const result = await blogService.togglePostLike(userId, postId);
    res.status(200).json(result);
  } catch (error) {
    console.error("Toggle blog like error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Comments ─────────────────────────────────────────────────────────────────

async function getComments(req, res) {
  const postId = Number(req.params.postId);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  try {
    const result = await blogService.getComments(postId, { page, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get blog comments error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function addComment(req, res) {
  const postId = Number(req.params.postId);
  const authorId = req.user.id;
  const { content } = req.body;

  if (!content) return res.status(400).json({ message: "Content is required." });

  try {
    const comment = await blogService.addComment(postId, authorId, content);
    res.status(201).json({ comment });

    // Notify all admins about the new comment (fire and forget)
    blogService.getAdminUsers().then((admins) => {
      const notifLink = `/blog/${postId}`;
      admins.forEach((admin) =>
        notifyUser(
          admin,
          `${req.user.username} commented on a community post.`,
          notifLink,
          "community_comment"
        ).catch(() => {})
      );
    }).catch(() => {});
  } catch (error) {
    console.error("Add blog comment error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteComment(req, res) {
  const commentId = Number(req.params.commentId);
  const userId = req.user.id;
  const isAdmin = req.user.role === "ADMIN";
  try {
    const existing = await blogService.findComment(commentId);
    if (!existing) return res.status(404).json({ message: "Comment not found." });
    if (existing.authorId !== userId && !isAdmin) return res.status(403).json({ message: "Not authorized." });
    await blogService.deleteComment(commentId);
    res.status(200).json({ message: "Comment deleted successfully." });
  } catch (error) {
    console.error("Delete blog comment error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Replies ──────────────────────────────────────────────────────────────────

async function getReplies(req, res) {
  const commentId = Number(req.params.commentId);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  try {
    const result = await blogService.getReplies(commentId, { page, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get blog replies error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function addReply(req, res) {
  const commentId = Number(req.params.commentId);
  const authorId = req.user.id;
  const { content } = req.body;

  if (!content) return res.status(400).json({ message: "Content is required." });

  try {
    const comment = await blogService.findComment(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found." });

    const reply = await blogService.addReply(commentId, authorId, content);
    res.status(201).json({ reply });

    // Notify comment author about the reply (skip if replying to own comment)
    if (comment.authorId !== authorId) {
      blogService.getUserById(comment.authorId).then((commentAuthor) => {
        if (commentAuthor) {
          const notifLink = `/blog/${comment.blogPostId}`;
          notifyUser(
            commentAuthor,
            `${req.user.username} replied to your comment.`,
            notifLink,
            "community_reply"
          ).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Add blog reply error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteReply(req, res) {
  const replyId = Number(req.params.replyId);
  const userId = req.user.id;
  const isAdmin = req.user.role === "ADMIN";
  try {
    const existing = await blogService.findReply(replyId);
    if (!existing) return res.status(404).json({ message: "Reply not found." });
    if (existing.authorId !== userId && !isAdmin) return res.status(403).json({ message: "Not authorized." });
    await blogService.deleteReply(replyId);
    res.status(200).json({ message: "Reply deleted successfully." });
  } catch (error) {
    console.error("Delete blog reply error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Series ──────────────────────────────────────────────────────────────────

async function createSeries(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const body = req.body || {};
  const { title, slug, description, coverUrl, category } = body;
  if (!title || !slug) {
    return res.status(400).json({ message: "Title and slug are required." });
  }
  try {
    let resolvedCoverUrl = coverUrl || null;
    if (req.file) resolvedCoverUrl = await uploadFile(req.file);
    const series = await blogService.createSeries({ title, slug, description, coverUrl: resolvedCoverUrl, category: category || null });
    res.status(201).json({ series });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "A series with that slug already exists." });
    }
    console.error("Create blog series error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getSeriesList(req, res) {
  try {
    const series = await blogService.getSeriesList();
    res.status(200).json({ series });
  } catch (error) {
    console.error("Get blog series error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getSeries(req, res) {
  const { slug } = req.params;
  try {
    const series = await blogService.getSeriesBySlug(slug);
    if (!series) return res.status(404).json({ message: "Series not found." });
    res.status(200).json({ series });
  } catch (error) {
    console.error("Get blog series error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updateSeries(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const seriesId = Number(req.params.seriesId);
  const body = req.body || {};
  const { title, slug, description, coverUrl, category } = body;
  try {
    const existing = await blogService.findSeries(seriesId);
    if (!existing) return res.status(404).json({ message: "Series not found." });
    let resolvedCoverUrl = coverUrl !== undefined ? (coverUrl || null) : undefined;
    if (req.file) {
      if (existing.coverUrl) await deleteFile(existing.coverUrl);
      resolvedCoverUrl = await uploadFile(req.file);
    }
    const series = await blogService.updateSeries(seriesId, { title, slug, description, coverUrl: resolvedCoverUrl, category: category !== undefined ? (category || null) : undefined });
    res.status(200).json({ series });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "A series with that slug already exists." });
    }
    console.error("Update blog series error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteSeries(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const seriesId = Number(req.params.seriesId);
  try {
    const existing = await blogService.findSeries(seriesId);
    if (!existing) return res.status(404).json({ message: "Series not found." });
    await blogService.deleteSeries(seriesId);
    res.status(200).json({ message: "Series deleted successfully. Its posts remain as standalone posts." });
  } catch (error) {
    console.error("Delete blog series error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * POST /blog/mark-seen
 * Called when the user visits the Community Updates page.
 * Clears the sidebar badge.
 */
async function markCommunityUpdatesRead(req, res) {
  try {
    await blogService.markCommunityUpdatesRead(req.user.id);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("markCommunityUpdatesRead error:", error);
    res.status(500).json({ message: "Failed to update last seen" });
  }
}

module.exports = {
  uploadImage,
  createPost,
  getPosts,
  getPinnedPosts,
  getPost,
  updatePost,
  deletePost,
  toggleLike,
  togglePin,
  getComments,
  addComment,
  deleteComment,
  getReplies,
  addReply,
  deleteReply,
  createSeries,
  getSeriesList,
  getSeries,
  updateSeries,
  deleteSeries,
  markCommunityUpdatesRead
};