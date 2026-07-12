const threadService = require("../services/threadservice");
const { uploadFile, deleteFile } = require("../utilis/fileUploader");
const { notifyUser } = require("../services/notificationService");

// ─── Word limit helper ────────────────────────────────────────────────────────

const COMMENT_WORD_LIMIT = 200;

function countWords(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Mention helpers ──────────────────────────────────────────────────────────

function extractMentions(content) {
  const matches = content.match(/@([a-zA-Z0-9_]+)/g) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

async function notifyMentions(content, authorId, linkUrl) {
  const usernames = extractMentions(content);
  if (usernames.length === 0) return;
  await Promise.allSettled(
    usernames.map(async (username) => {
      const mentioned = await threadService.getUserByUsername(username);
      if (!mentioned || mentioned.id === authorId) return;
      notifyUser(mentioned, `You were mentioned in a comment.`, linkUrl, "thread_mention").catch(() => {});
    })
  );
}

// ─── Thread Categories (admin write, public read) ─────────────────────────────

async function getCategories(req, res) {
  try {
    const categories = await threadService.getCategories();
    res.status(200).json({ categories });
  } catch (error) {
    console.error("Get categories error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function createCategory(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const { name, slug, description, sortOrder } = req.body;
  if (!name) return res.status(400).json({ message: "Category name is required." });
  if (!slug) return res.status(400).json({ message: "Category slug is required." });
  try {
    const category = await threadService.createCategory({
      name,
      slug,
      description,
      sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
    });
    res.status(201).json({ category });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "A category with that name or slug already exists." });
    }
    console.error("Create category error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updateCategory(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const categoryId = Number(req.params.categoryId);
  const { name, slug, description, sortOrder } = req.body;
  try {
    const existing = await threadService.findCategory(categoryId);
    if (!existing) return res.status(404).json({ message: "Category not found." });
    const category = await threadService.updateCategory(categoryId, {
      name,
      slug,
      description,
      sortOrder: sortOrder !== undefined ? Number(sortOrder) : undefined,
    });
    res.status(200).json({ category });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "A category with that name or slug already exists." });
    }
    console.error("Update category error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteCategory(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const categoryId = Number(req.params.categoryId);
  try {
    const existing = await threadService.findCategory(categoryId);
    if (!existing) return res.status(404).json({ message: "Category not found." });
    await threadService.deleteCategory(categoryId);
    res.status(200).json({ message: "Category deleted. Threads have been moved to Uncategorised." });
  } catch (error) {
    console.error("Delete category error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Threads ──────────────────────────────────────────────────────────────────

async function createThread(req, res) {
  const { title, context, isPinned, isDeprioritized, categoryId, link } = req.body;
  if (!title)   return res.status(400).json({ message: "Title is required." });
  if (!context) return res.status(400).json({ message: "Context is required." });

  const isAdmin = req.user.role === "ADMIN";
  const wantsPinned = (isPinned === "true" || isPinned === true) && isAdmin;
  // Only admins can post a thread as deprioritized (hidden from active/latest/
  // pinned feeds, still visible at the bottom of the plain thread list).
  const wantsDeprioritized = (isDeprioritized === "true" || isDeprioritized === true) && isAdmin;

  try {
    const fileFields = req.files && typeof req.files === "object" && !Array.isArray(req.files)
      ? Object.values(req.files).flat()
      : req.files ?? (req.file ? [req.file] : []);

    const mediaUrls = fileFields.length > 0
      ? await Promise.all(fileFields.map(f => uploadFile(f)))
      : [];

    const thread = await threadService.createThread({
      authorId:   req.user.id,
      categoryId: categoryId ? Number(categoryId) : null,
      title,
      context,
      mediaUrls,
      link:       link || null,
      isPinned: wantsPinned,
      isDeprioritized: wantsDeprioritized,
    });

    res.status(201).json({ thread });

    // Notify all members about every new thread (fire and forget)
    threadService.getAllUsers().then((users) => {
      const notifLink = `/threads/${thread.id}`;
      users.forEach((u) => {
        if (u.id === req.user.id) return;
        notifyUser(u, `New thread: "${title}"`, notifLink, "thread_new", "GENERAL", {
          kind: "new_thread", title,
        }).catch(() => {});
      });
    }).catch(() => {});
  } catch (error) {
    console.error("Create thread error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getThreads(req, res) {
  const page       = parseInt(req.query.page)       || 1;
  const limit      = parseInt(req.query.limit)      || 20;
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  try {
    const result = await threadService.getThreads({ page, limit, categoryId });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get threads error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getLatestThreads(req, res) {
  const page       = parseInt(req.query.page)       || 1;
  const limit      = parseInt(req.query.limit)      || 20;
  const categoryId = req.query.categoryId ? Number(req.query.categoryId) : undefined;
  try {
    const result = await threadService.getLatestThreads({ page, limit, categoryId });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get latest threads error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getPinnedThreads(req, res) {
  const limit = parseInt(req.query.limit) || 10;
  try {
    const threads = await threadService.getPinnedThreads({ limit });
    res.status(200).json({ threads });
  } catch (error) {
    console.error("Get pinned threads error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getPinnedAndTodayThreads(req, res) {
  const limit = parseInt(req.query.limit) || 10;
  try {
    const threads = await threadService.getPinnedAndTodayThreads({ limit });
    res.status(200).json({ threads });
  } catch (error) {
    console.error("Get pinned/today threads error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getActiveThreads(req, res) {
  const limit = parseInt(req.query.limit) || 20;
  try {
    const threads = await threadService.getActiveThreads({ limit });
    res.status(200).json({ threads });
  } catch (error) {
    console.error("Get active threads error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getThread(req, res) {
  const threadId = Number(req.params.threadId);
  try {
    const thread = await threadService.getThread(threadId);
    if (!thread) return res.status(404).json({ message: "Thread not found." });
    res.status(200).json({ thread });
  } catch (error) {
    console.error("Get thread error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updateThread(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const threadId = Number(req.params.threadId);
  const { title, context, isPinned, isDeprioritized, categoryId, link, existingMediaUrls } = req.body;
  try {
    const existing = await threadService.findThread(threadId);
    if (!existing) return res.status(404).json({ message: "Thread not found." });

    const fileFields = req.files && typeof req.files === "object" && !Array.isArray(req.files)
      ? Object.values(req.files).flat()
      : req.files ?? (req.file ? [req.file] : []);

    // existingMediaUrls (sent by the edit form as a JSON array) tells us which
    // of the thread's current images the writer kept vs. removed. Anything
    // removed gets deleted from storage; new uploads are appended on top,
    // capped at 5 total — same limit as comments/replies.
    let mediaUrl;
    let mediaUrls;
    if (fileFields.length > 0 || existingMediaUrls !== undefined) {
      const priorUrls = Array.isArray(existing.mediaUrls) ? existing.mediaUrls
        : (existing.mediaUrl ? [existing.mediaUrl] : []);
      let keptUrls = priorUrls;
      if (existingMediaUrls !== undefined) {
        try { keptUrls = JSON.parse(existingMediaUrls); } catch { keptUrls = priorUrls; }
      }
      const removedUrls = priorUrls.filter(u => !keptUrls.includes(u));
      await Promise.all(removedUrls.map(u => deleteFile(u)));

      const uploadedUrls = fileFields.length > 0
        ? await Promise.all(fileFields.map(f => uploadFile(f)))
        : [];
      mediaUrls = [...keptUrls, ...uploadedUrls].slice(0, 5);
      mediaUrl  = mediaUrls[0] ?? null;
    }

    const thread = await threadService.updateThread(threadId, {
      title,
      context,
      mediaUrl,
      mediaUrls,
      link:            link            !== undefined ? (link || null) : undefined,
      isPinned:        isPinned        !== undefined ? (isPinned === "true" || isPinned === true) : undefined,
      isDeprioritized: isDeprioritized !== undefined ? (isDeprioritized === "true" || isDeprioritized === true) : undefined,
      categoryId:      categoryId      !== undefined ? (categoryId ? Number(categoryId) : null) : undefined,
    });

    res.status(200).json({ thread });
  } catch (error) {
    console.error("Update thread error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteThread(req, res) {
  const threadId = Number(req.params.threadId);
  const userId   = req.user.id;
  const isAdmin  = req.user.role === "ADMIN";
  try {
    const existing = await threadService.findThread(threadId);
    if (!existing) return res.status(404).json({ message: "Thread not found." });
    if (existing.authorId !== userId && !isAdmin) {
      return res.status(403).json({ message: "Not authorized." });
    }
    const mediaUrl = await threadService.deleteThread(threadId);
    if (mediaUrl) await deleteFile(mediaUrl);
    res.status(200).json({ message: "Thread deleted successfully." });
  } catch (error) {
    console.error("Delete thread error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function toggleLike(req, res) {
  const threadId = Number(req.params.threadId);
  const userId   = req.user.id;
  try {
    const result = await threadService.toggleThreadLike(userId, threadId);
    res.status(200).json(result);

    if (result.liked) {
      threadService.findThread(threadId).then((thread) => {
        if (thread?.authorId && thread.authorId !== userId) {
          threadService.getUserById(thread.authorId).then((author) => {
            if (author) {
              const notifLink = `/threads/${threadId}`;
              notifyUser(author, `${req.user.username} liked your thread "${thread.title}".`, notifLink, "thread_like", "GENERAL", {
                kind: "reaction", title: thread.title,
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Toggle thread like error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Comments ─────────────────────────────────────────────────────────────────

async function getComments(req, res) {
  const threadId = Number(req.params.threadId);
  const page     = parseInt(req.query.page)  || 1;
  const limit    = parseInt(req.query.limit) || 20;
  try {
    const result = await threadService.getComments(threadId, { page, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get thread comments error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function addComment(req, res) {
  const threadId = Number(req.params.threadId);
  const authorId = req.user.id;
  const { content } = req.body;

  if (!content) return res.status(400).json({ message: "Content is required." });

  const wordCount = countWords(content);
  if (wordCount > COMMENT_WORD_LIMIT) {
    return res.status(400).json({
      message: `Comments must be ${COMMENT_WORD_LIMIT} words or fewer. Yours is ${wordCount} words.`,
    });
  }

  try {
    const fileFields = req.files && typeof req.files === "object" && !Array.isArray(req.files)
      ? Object.values(req.files).flat()
      : req.files ?? (req.file ? [req.file] : []);

    const mediaUrls = fileFields.length > 0
      ? await Promise.all(fileFields.map(f => uploadFile(f)))
      : [];

    const comment = await threadService.addComment(threadId, authorId, content, mediaUrls);
    res.status(201).json({ comment });

    const notifLink = `/threads/${threadId}?comment=${comment.id}`;

    // Notify thread author that someone commented (skip if commenting on own thread)
    threadService.findThread(threadId).then((thread) => {
      if (thread?.authorId && thread.authorId !== authorId) {
        threadService.getUserById(thread.authorId).then((threadAuthor) => {
          if (threadAuthor) {
            notifyUser(
              threadAuthor,
              `${req.user.username} commented on your thread "${thread.title}".`,
              notifLink,
              "thread_comment"
            ).catch(() => {});
          }
        }).catch(() => {});
      }
    }).catch(() => {});

    notifyMentions(content, authorId, notifLink).catch(() => {});
  } catch (error) {
    console.error("Add thread comment error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteComment(req, res) {
  const commentId = Number(req.params.commentId);
  const userId    = req.user.id;
  const isAdmin   = req.user.role === "ADMIN";
  try {
    const existing = await threadService.findComment(commentId);
    if (!existing) return res.status(404).json({ message: "Comment not found." });
    if (existing.authorId !== userId && !isAdmin) {
      return res.status(403).json({ message: "Not authorized." });
    }
    await threadService.deleteComment(commentId);
    res.status(200).json({ message: "Comment deleted successfully." });
  } catch (error) {
    console.error("Delete thread comment error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function toggleCommentLike(req, res) {
  const commentId = Number(req.params.commentId);
  const userId    = req.user.id;
  try {
    const result = await threadService.toggleCommentLike(userId, commentId);
    res.status(200).json(result);

    if (result.liked) {
      threadService.findCommentWithAuthor(commentId).then((comment) => {
        if (comment?.authorId && comment.authorId !== userId) {
          threadService.getUserById(comment.authorId).then((author) => {
            if (author) {
              const notifLink = `/threads/${comment.threadId}?comment=${commentId}`;
              notifyUser(author, `${req.user.username} liked your comment.`, notifLink, "thread_comment_like", "GENERAL", {
                kind: "reaction",
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Toggle comment like error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Replies ──────────────────────────────────────────────────────────────────

async function getReplies(req, res) {
  const commentId = Number(req.params.commentId);
  const page      = parseInt(req.query.page)  || 1;
  const limit     = parseInt(req.query.limit) || 20;
  try {
    const result = await threadService.getReplies(commentId, { page, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get thread replies error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function addReply(req, res) {
  const commentId = Number(req.params.commentId);
  const authorId  = req.user.id;
  const { content, parentId } = req.body;

  if (!content) return res.status(400).json({ message: "Content is required." });

  const wordCount = countWords(content);
  if (wordCount > COMMENT_WORD_LIMIT) {
    return res.status(400).json({
      message: `Replies must be ${COMMENT_WORD_LIMIT} words or fewer. Yours is ${wordCount} words.`,
    });
  }

  try {
    const comment = await threadService.findComment(commentId);
    if (!comment) return res.status(404).json({ message: "Comment not found." });

    // If this is a reply-to-a-reply, make sure the parent reply is real and
    // actually belongs to this comment thread before nesting under it.
    let normalizedParentId = null;
    if (parentId) {
      const parentReply = await threadService.findReply(Number(parentId));
      if (!parentReply || parentReply.commentId !== commentId) {
        return res.status(400).json({ message: "Invalid reply target." });
      }
      normalizedParentId = parentReply.id;
    }

    const fileFields = req.files && typeof req.files === "object" && !Array.isArray(req.files)
      ? Object.values(req.files).flat()
      : req.files ?? (req.file ? [req.file] : []);

    const mediaUrls = fileFields.length > 0
      ? await Promise.all(fileFields.map(f => uploadFile(f)))
      : [];

    const reply = await threadService.addReply(commentId, authorId, content, mediaUrls, normalizedParentId);
    res.status(201).json({ reply });

    if (comment.authorId && comment.authorId !== authorId) {
      threadService.getUserById(comment.authorId).then((commentAuthor) => {
        if (commentAuthor) {
          const notifLink = `/threads/${comment.threadId}?comment=${commentId}&reply=${reply.id}`;
          notifyUser(commentAuthor, `${req.user.username} replied to your comment.`, notifLink, "thread_reply").catch(() => {});
        }
      }).catch(() => {});
    }

    const mentionLink = `/threads/${comment.threadId}?comment=${commentId}&reply=${reply.id}`;
    notifyMentions(content, authorId, mentionLink).catch(() => {});
  } catch (error) {
    console.error("Add thread reply error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteReply(req, res) {
  const replyId = Number(req.params.replyId);
  const userId  = req.user.id;
  const isAdmin = req.user.role === "ADMIN";
  try {
    const existing = await threadService.findReply(replyId);
    if (!existing) return res.status(404).json({ message: "Reply not found." });
    if (existing.authorId !== userId && !isAdmin) {
      return res.status(403).json({ message: "Not authorized." });
    }
    await threadService.deleteReply(replyId);
    res.status(200).json({ message: "Reply deleted successfully." });
  } catch (error) {
    console.error("Delete thread reply error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function toggleReplyLike(req, res) {
  const replyId = Number(req.params.replyId);
  const userId  = req.user.id;
  try {
    const result = await threadService.toggleReplyLike(userId, replyId);
    res.status(200).json(result);

    if (result.liked) {
      threadService.findReplyWithAuthor(replyId).then((reply) => {
        if (reply?.authorId && reply.authorId !== userId) {
          threadService.getUserById(reply.authorId).then((author) => {
            if (author) {
              const notifLink = `/threads/${reply.comment?.threadId}?comment=${reply.commentId}&reply=${replyId}`;
              notifyUser(author, `${req.user.username} liked your reply.`, notifLink, "thread_reply_like", "GENERAL", {
                kind: "reaction",
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Toggle reply like error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Profile stats ────────────────────────────────────────────────────────────

async function getMyDiscussionStats(req, res) {
  const userId = req.user.id;
  try {
    const discussionCount = await threadService.getUserDiscussionCount(userId);
    res.status(200).json({ discussionCount });
  } catch (error) {
    console.error("Get discussion stats error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Daily challenge thread ───────────────────────────────────────────────────

async function getDailyThread(req, res) {
  try {
    const thread = await threadService.getDailyThread();
    if (!thread) return res.status(404).json({ message: "No daily challenge thread found." });
    res.status(200).json({ thread });
  } catch (error) {
    console.error("Get daily thread error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Member search (for @mention autocomplete) ────────────────────────────────

async function searchMembers(req, res) {
  const query = (req.query.q || "").trim();
  if (!query || query.length < 2) return res.status(200).json({ users: [] });
  try {
    const users = await threadService.searchUsersByUsername(query);
    res.status(200).json({ users });
  } catch (error) {
    console.error("Search members error:", error);
    res.status(500).json({ message: "Something went wrong." });
  }
}

module.exports = {
  // categories
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  // threads
  createThread,
  getThreads,
  getLatestThreads,
  getPinnedThreads,
  getPinnedAndTodayThreads,
  getActiveThreads,
  getThread,
  updateThread,
  deleteThread,
  toggleLike,
  getDailyThread,
  getMyDiscussionStats,
  // comments
  getComments,
  addComment,
  deleteComment,
  toggleCommentLike,
  // replies
  getReplies,
  addReply,
  deleteReply,
  toggleReplyLike,
  // search
  searchMembers,
};