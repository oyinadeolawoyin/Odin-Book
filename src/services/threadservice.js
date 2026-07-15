const prisma = require("../config/prismaClient");

const AUTHOR_SELECT = {
  id: true,
  username: true,
  avatar: true,
};

/**
 * Thread._count.comments only counts top-level ThreadComment rows — it does
 * NOT include their ThreadReply children. For an accurate "N comments" total
 * on a thread card, we need comments + all replies under those comments.
 *
 * This takes an array of threads (each already carrying _count from a normal
 * Prisma `include`) and adds two convenience fields the frontend needs:
 *   - totalCommentCount  — comments + replies combined
 *   - likesCount         — alias of _count.likes (avoids drilling into _count on every card)
 *
 * Both are computed in a single grouped query rather than one extra query per
 * thread.
 */
async function attachCommentTotals(threads) {
  if (threads.length === 0) return threads;

  const threadIds = threads.map((t) => t.id);

  // One query: reply counts grouped by the comment's threadId.
  const replyCounts = await prisma.threadReply.groupBy({
    by: ["commentId"],
    where: { comment: { threadId: { in: threadIds } } },
    _count: { _all: true },
  });

  if (replyCounts.length === 0) {
    return threads.map((t) => ({
      ...t,
      totalCommentCount: t._count?.comments ?? 0,
      likesCount: t._count?.likes ?? 0,
    }));
  }

  // Map commentId -> threadId so we can roll reply counts up to the thread level.
  const commentIds = replyCounts.map((r) => r.commentId);
  const commentsWithThread = await prisma.threadComment.findMany({
    where: { id: { in: commentIds } },
    select: { id: true, threadId: true },
  });
  const commentIdToThreadId = new Map(commentsWithThread.map((c) => [c.id, c.threadId]));

  const replyCountByThreadId = new Map();
  for (const r of replyCounts) {
    const threadId = commentIdToThreadId.get(r.commentId);
    if (threadId == null) continue;
    replyCountByThreadId.set(threadId, (replyCountByThreadId.get(threadId) ?? 0) + r._count._all);
  }

  return threads.map((t) => ({
    ...t,
    totalCommentCount: (t._count?.comments ?? 0) + (replyCountByThreadId.get(t.id) ?? 0),
    likesCount: t._count?.likes ?? 0,
  }));
}

/** Same idea, for a single thread (thread page). */
async function attachCommentTotal(thread) {
  if (!thread) return thread;
  const [withTotals] = await attachCommentTotals([thread]);
  return withTotals;
}

// ─── Threads ──────────────────────────────────────────────────────────────────

async function createThread({ authorId, title, context, tag, mediaUrl, mediaUrls = [], link, isPinned, isDeprioritized }) {
  const thread = await prisma.thread.create({
    data: {
      authorId,
      title: title || null,
      context,
      tag: tag || null,
      mediaUrl: mediaUrl || mediaUrls[0] || null,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : [],
      link: link || null,
      isPinned: isPinned ?? false,
      isDeprioritized: isDeprioritized ?? false,
    },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
    },
  });
  // Brand-new thread — no comments or replies yet, so the total is always 0,
  // but we keep the same shape (totalCommentCount) the frontend expects.
  return { ...thread, totalCommentCount: 0 };
}

async function getThreads({ page = 1, limit = 20, tag, sort = "latest" } = {}) {
  const skip = (page - 1) * limit;
  const where = tag ? { tag } : {};

  // ── "Latest": newest first, pinned threads still float to the top ──
  // Ordinary indexed query — supports skip/take natively and stays fast
  // no matter how large the thread table gets.
  if (sort !== "active") {
    const [threads, total] = await Promise.all([
      prisma.thread.findMany({
        where,
        skip,
        take: limit,
        // Pinned first, deprioritized threads pushed to the very bottom
        // (isDeprioritized "asc" puts false before true), newest first within
        // each group — so within any group it's always newest-at-the-top,
        // descending down to oldest.
        orderBy: [{ isPinned: "desc" }, { isDeprioritized: "asc" }, { createdAt: "desc" }],
        include: {
          author: { select: AUTHOR_SELECT },
          _count: { select: { likes: true, comments: true } },
        },
      }),
      prisma.thread.count({ where }),
    ]);

    return { threads: await attachCommentTotals(threads), total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── "Active": ranked by total engagement (comments + replies) descending ──
  // Prisma can't ORDER BY a computed sum across two relations in one query,
  // so we pull every matching thread (no time window here — this is the
  // full paginated feed, not the homepage widget), attach totals, sort in
  // JS, then paginate the already-sorted list.
  const allThreads = await prisma.thread.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
    },
  });

  const withTotals = await attachCommentTotals(allThreads);

  withTotals.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.isDeprioritized !== b.isDeprioritized) return a.isDeprioritized ? 1 : -1;
    const engagementDiff = (b.totalCommentCount ?? 0) - (a.totalCommentCount ?? 0);
    if (engagementDiff !== 0) return engagementDiff;
    // Tie-break: newest first.
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const total = withTotals.length;
  const threads = withTotals.slice(skip, skip + limit);

  return { threads, total, page, totalPages: Math.ceil(total / limit) };
}

/**
 * Threads for the "Latest" tab — threads posted in the last 2 days, newest
 * first, pinned threads excluded so they don't duplicate the Pinned tab.
 */
async function getLatestThreads({ page = 1, limit = 20, tag } = {}) {
  const skip = (page - 1) * limit;
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const where = {
    isPinned: false,
    isDeprioritized: false,
    createdAt: { gte: twoDaysAgo },
    ...(tag ? { tag } : {}),
  };

  const [threads, total] = await Promise.all([
    prisma.thread.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: AUTHOR_SELECT },
        _count: { select: { likes: true, comments: true } },
      },
    }),
    prisma.thread.count({ where }),
  ]);

  return { threads: await attachCommentTotals(threads), total, page, totalPages: Math.ceil(total / limit) };
}

/**
 * Threads for the homepage "Pinned & Today" widget:
 *   - all pinned threads (any date), plus
 *   - all non-pinned threads created since local midnight today
 * Pinned threads are returned first, each group ordered newest first.
 * `limit` caps the combined result so the widget doesn't grow unbounded
 * on a busy day.
 */
async function getPinnedAndTodayThreads({ limit = 10 } = {}) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [pinned, today] = await Promise.all([
    prisma.thread.findMany({
      where: { isPinned: true },
      orderBy: { createdAt: "desc" },
      include: {
        author:   { select: AUTHOR_SELECT },
        _count:   { select: { likes: true, comments: true } },
      },
    }),
    prisma.thread.findMany({
      where: { isPinned: false, isDeprioritized: false, createdAt: { gte: startOfToday } },
      orderBy: { createdAt: "desc" },
      include: {
        author:   { select: AUTHOR_SELECT },
        _count:   { select: { likes: true, comments: true } },
      },
    }),
  ]);

  return (await attachCommentTotals([...pinned, ...today])).slice(0, limit);
}

/**
 * Threads for the homepage "Pinned" tab — only threads with isPinned: true,
 * newest pinned first. No mixing with today's/recent threads.
 */
async function getPinnedThreads({ limit = 10 } = {}) {
  const threads = await prisma.thread.findMany({
    where: { isPinned: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      author:   { select: AUTHOR_SELECT },
      _count:   { select: { likes: true, comments: true } },
    },
  });
  return attachCommentTotals(threads);
}

/**
 * "Active" threads — any thread that received a comment or reply in the last
 * 48 hours, OR was created in the last 48 hours.
 * Sorted by highest combined engagement (comments + replies) descending so the
 * busiest threads float to the top. Pinned threads still lead the list.
 *
 * Because Prisma can't ORDER BY a computed sum across two relations in one
 * query, we fetch a reasonable overcount (limit * 4), attach totals, then
 * sort and slice in JS — this is cheap because the dataset is small (active
 * window is only 48 h).
 */
async function getActiveThreads({ limit = 20 } = {}) {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const threads = await prisma.thread.findMany({
    where: {
      isDeprioritized: false,
      OR: [
        { createdAt: { gte: twoDaysAgo } },
        { comments: { some: { createdAt: { gte: twoDaysAgo } } } },
        { comments: { some: { replies: { some: { createdAt: { gte: twoDaysAgo } } } } } },
      ],
    },
    take: limit * 4, // overfetch so sorting has enough to work with
    include: {
      author:   { select: AUTHOR_SELECT },
      _count:   { select: { likes: true, comments: true } },
    },
  });

  const withTotals = await attachCommentTotals(threads);

  // Sort: pinned first, then by totalCommentCount desc (comments + replies)
  withTotals.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.totalCommentCount ?? 0) - (a.totalCommentCount ?? 0);
  });

  return withTotals.slice(0, limit);
}

async function getThread(threadId) {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      author:   { select: AUTHOR_SELECT },
      _count:   { select: { likes: true, comments: true } },
    },
  });
  return attachCommentTotal(thread);
}

async function findThread(threadId) {
  return prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, authorId: true, title: true, mediaUrl: true, mediaUrls: true },
  });
}

async function updateThread(threadId, { title, context, mediaUrl, mediaUrls, link, tag, isPinned, isDeprioritized }) {
  const thread = await prisma.thread.update({
    where: { id: threadId },
    data: {
      ...(title           !== undefined && { title }),
      ...(context         !== undefined && { context }),
      ...(mediaUrl        !== undefined && { mediaUrl }),
      ...(mediaUrls       !== undefined && { mediaUrls }),
      ...(link            !== undefined && { link: link || null }),
      ...(tag             !== undefined && { tag }),
      ...(isPinned        !== undefined && { isPinned }),
      ...(isDeprioritized !== undefined && { isDeprioritized }),
    },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, comments: true } },
    },
  });
  return attachCommentTotal(thread);
}

async function deleteThread(threadId) {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    select: { mediaUrl: true },
  });
  await prisma.thread.delete({ where: { id: threadId } });
  return thread?.mediaUrl || null;
}

// ─── Thread Likes ─────────────────────────────────────────────────────────────

async function toggleThreadLike(userId, threadId) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.threadLike.findUnique({
      where: { userId_threadId: { userId, threadId } },
    });

    if (existing) {
      await tx.threadLike.delete({
        where: { userId_threadId: { userId, threadId } },
      });
    } else {
      await tx.threadLike.create({ data: { userId, threadId } });
    }

    const likesCount = await tx.threadLike.count({ where: { threadId } });
    return { liked: !existing, likesCount };
  });
}

// ─── Comments ─────────────────────────────────────────────────────────────────

async function getComments(threadId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;

  const [comments, total] = await Promise.all([
    prisma.threadComment.findMany({
      where: { threadId },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: AUTHOR_SELECT },
        _count: { select: { likes: true, replies: true } },
      },
    }),
    prisma.threadComment.count({ where: { threadId } }),
  ]);

  return { comments, total, page, totalPages: Math.ceil(total / limit) };
}

async function addComment(threadId, authorId, content, mediaUrls = []) {
  return prisma.threadComment.create({
    data: {
      threadId,
      authorId,
      content,
      mediaUrl:  mediaUrls[0] ?? null,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : [],
    },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true, replies: true } },
    },
  });
}

async function findComment(commentId) {
  return prisma.threadComment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, threadId: true },
  });
}

async function deleteComment(commentId) {
  await prisma.threadComment.delete({ where: { id: commentId } });
}

// ─── Comment Likes ────────────────────────────────────────────────────────────

async function toggleCommentLike(userId, commentId) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.threadCommentLike.findUnique({
      where: { userId_commentId: { userId, commentId } },
    });

    if (existing) {
      await tx.threadCommentLike.delete({
        where: { userId_commentId: { userId, commentId } },
      });
    } else {
      await tx.threadCommentLike.create({ data: { userId, commentId } });
    }

    const likesCount = await tx.threadCommentLike.count({ where: { commentId } });
    return { liked: !existing, likesCount };
  });
}

// ─── Replies ──────────────────────────────────────────────────────────────────

async function getReplies(commentId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;

  const [replies, total] = await Promise.all([
    prisma.threadReply.findMany({
      where: { commentId },
      skip,
      take: limit,
      orderBy: { createdAt: "asc" },
      include: {
        author: { select: AUTHOR_SELECT },
        _count: { select: { likes: true } },
      },
    }),
    prisma.threadReply.count({ where: { commentId } }),
  ]);

  return { replies, total, page, totalPages: Math.ceil(total / limit) };
}

async function addReply(commentId, authorId, content, mediaUrls = [], parentId = null) {
  return prisma.threadReply.create({
    data: {
      commentId,
      parentId: parentId ?? null,
      authorId,
      content,
      mediaUrl:  mediaUrls[0] ?? null,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : [],
    },
    include: {
      author: { select: AUTHOR_SELECT },
      _count: { select: { likes: true } },
    },
  });
}

/** Looks up a reply's authorId/commentId — used both to validate that a
 * parentId being replied to actually belongs to the comment thread the
 * request claims, and to check ownership before a delete. */
async function findReply(replyId) {
  return prisma.threadReply.findUnique({
    where: { id: replyId },
    select: { id: true, authorId: true, commentId: true },
  });
}

// ─── Daily challenge thread ───────────────────────────────────────────────────

async function getDailyThread() {
  const thread = await prisma.thread.findFirst({
    where: {
      isPinned: true,
      title:    { contains: "Daily Writing", mode: "insensitive" },
    },
    include: {
      author:   { select: AUTHOR_SELECT },
      _count:   { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return attachCommentTotal(thread);
}

async function deleteReply(replyId) {
  await prisma.threadReply.delete({ where: { id: replyId } });
}

// ─── Reply Likes ──────────────────────────────────────────────────────────────

async function toggleReplyLike(userId, replyId) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.threadReplyLike.findUnique({
      where: { userId_replyId: { userId, replyId } },
    });

    if (existing) {
      await tx.threadReplyLike.delete({
        where: { userId_replyId: { userId, replyId } },
      });
    } else {
      await tx.threadReplyLike.create({ data: { userId, replyId } });
    }

    const likesCount = await tx.threadReplyLike.count({ where: { replyId } });
    return { liked: !existing, likesCount };
  });
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function getUserById(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true },
  });
}

async function getAllUsers() {
  return prisma.user.findMany({
    select: { id: true, username: true, email: true },
  });
}

async function getUserDiscussionCount(userId) {
  return prisma.threadComment.count({ where: { authorId: userId } });
}

async function getAdminUsers() {
  return prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true, username: true, email: true },
  });
}

// ─── Mention / like notification helpers ─────────────────────────────────────

async function getUserByUsername(username) {
  return prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" }, isDeleted: false },
    select: { id: true, username: true, email: true },
  });
}

async function searchUsersByUsername(query) {
  return prisma.user.findMany({
    where: {
      username: { contains: query, mode: "insensitive" },
      isDeleted: false,
    },
    select: { id: true, username: true, avatar: true },
    take: 8,
    orderBy: { username: "asc" },
  });
}

async function findCommentWithAuthor(commentId) {
  return prisma.threadComment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, threadId: true },
  });
}

async function findReplyWithAuthor(replyId) {
  return prisma.threadReply.findUnique({
    where: { id: replyId },
    select: {
      id: true,
      authorId: true,
      commentId: true,
      comment: { select: { threadId: true } },
    },
  });
}

module.exports = {
  // threads
  createThread,
  getThreads,
  getLatestThreads,
  getPinnedThreads,
  getPinnedAndTodayThreads,
  getActiveThreads,
  getThread,
  findThread,
  updateThread,
  deleteThread,
  toggleThreadLike,
  getDailyThread,
  // comments
  getComments,
  addComment,
  findComment,
  deleteComment,
  toggleCommentLike,
  // replies
  getReplies,
  addReply,
  findReply,
  deleteReply,
  toggleReplyLike,
  // users
  getUserById,
  getAdminUsers,
  getAllUsers,
  getUserDiscussionCount,
  getUserByUsername,
  searchUsersByUsername,
  findCommentWithAuthor,
  findReplyWithAuthor,
};