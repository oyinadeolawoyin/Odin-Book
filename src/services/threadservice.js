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

// ─── Thread Categories ────────────────────────────────────────────────────────

/**
 * For each category we return:
 *   - id, name, slug, description, sortOrder
 *   - totalPosts      — total thread count
 *   - activePosts     — threads that received a comment or reply in the last 30 days,
 *                       OR were created in the last 30 days
 *   - latestThread    — { id, title, createdAt } of the most recently created thread
 *   - lastPostAt      — createdAt of that newest thread (null if no threads yet)
 *   - latestThreads   — the 3 most recent threads, full card data (author, counts,
 *                       totalCommentCount) for the category-grid preview on the forum page
 */
async function getCategories() {
  const categories = await prisma.threadCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      threads: {
        select: {
          id: true,
          title: true,
          createdAt: true,
          isDeprioritized: true,
          comments: {
            select: { createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Fetch the 3 latest full thread cards per category in parallel — one
  // query per category, but categories are few and this only runs on the
  // forum index, not on every list call.
  const latestThreadsByCategory = await Promise.all(
    categories.map((cat) =>
      prisma.thread.findMany({
        where: { categoryId: cat.id, isDeprioritized: false },
        orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
        take: 3,
        include: {
          author: { select: AUTHOR_SELECT },
          _count: { select: { likes: true, comments: true } },
        },
      })
    )
  );
  const allLatestThreads = latestThreadsByCategory.flat();
  const allLatestThreadsWithTotals = await attachCommentTotals(allLatestThreads);

  let cursor = 0;
  const latestThreadsWithTotalsByCategory = latestThreadsByCategory.map((group) => {
    const slice = allLatestThreadsWithTotals.slice(cursor, cursor + group.length);
    cursor += group.length;
    return slice;
  });

  return categories.map((cat, i) => {
    const { threads, ...rest } = cat;

    const totalPosts = threads.length;

    // A thread is "active" if it was created or had a comment within 30 days.
    // Deprioritized threads never count toward activePosts, but they do
    // still count toward totalPosts above.
    const activePosts = threads.filter((t) => {
      if (t.isDeprioritized) return false;
      if (t.createdAt >= thirtyDaysAgo) return true;
      const lastComment = t.comments[0];
      return lastComment && lastComment.createdAt >= thirtyDaysAgo;
    }).length;

    // Most recently created thread
    const sorted = [...threads].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const latest = sorted[0] ?? null;

    return {
      ...rest,
      totalPosts,
      activePosts,
      latestThread: latest
        ? { id: latest.id, title: latest.title, createdAt: latest.createdAt }
        : null,
      lastPostAt: latest ? latest.createdAt : null,
      latestThreads: latestThreadsWithTotalsByCategory[i] ?? [],
    };
  });
}

async function createCategory({ name, slug, description, sortOrder }) {
  return prisma.threadCategory.create({
    data: {
      name,
      slug,
      description: description ?? null,
      sortOrder:   sortOrder   ?? 0,
    },
  });
}

async function findCategory(categoryId) {
  return prisma.threadCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, name: true, slug: true },
  });
}

async function updateCategory(categoryId, { name, slug, description, sortOrder }) {
  return prisma.threadCategory.update({
    where: { id: categoryId },
    data: {
      ...(name        !== undefined && { name }),
      ...(slug        !== undefined && { slug }),
      ...(description !== undefined && { description }),
      ...(sortOrder   !== undefined && { sortOrder }),
    },
  });
}

async function deleteCategory(categoryId) {
  // Threads whose category is deleted will have categoryId set to null
  // because the schema uses onDelete: SetNull on the category relation.
  return prisma.threadCategory.delete({ where: { id: categoryId } });
}

// ─── Threads ──────────────────────────────────────────────────────────────────

async function createThread({ authorId, categoryId, title, context, mediaUrl, link, isPinned, isDeprioritized }) {
  const thread = await prisma.thread.create({
    data: {
      authorId,
      categoryId: categoryId ?? null,
      title,
      context,
      mediaUrl: mediaUrl || null,
      link: link || null,
      isPinned: isPinned ?? false,
      isDeprioritized: isDeprioritized ?? false,
    },
    include: {
      author:   { select: AUTHOR_SELECT },
      category: { select: { id: true, name: true, slug: true } },
      _count:   { select: { likes: true, comments: true } },
    },
  });
  // Brand-new thread — no comments or replies yet, so the total is always 0,
  // but we keep the same shape (totalCommentCount) the frontend expects.
  return { ...thread, totalCommentCount: 0 };
}

async function getThreads({ page = 1, limit = 20, categoryId } = {}) {
  const skip = (page - 1) * limit;

  const where = categoryId ? { categoryId } : {};

  const [threads, total] = await Promise.all([
    prisma.thread.findMany({
      where,
      skip,
      take: limit,
      // Pinned first, deprioritized threads pushed to the very bottom
      // (isDeprioritized "asc" puts false before true), newest first within
      // each group.
      orderBy: [{ isPinned: "desc" }, { isDeprioritized: "asc" }, { createdAt: "desc" }],
      include: {
        author:   { select: AUTHOR_SELECT },
        category: { select: { id: true, name: true, slug: true } },
        _count:   { select: { likes: true, comments: true } },
      },
    }),
    prisma.thread.count({ where }),
  ]);

  return { threads: await attachCommentTotals(threads), total, page, totalPages: Math.ceil(total / limit) };
}

/**
 * Threads for the "Latest" tab — threads posted in the last 2 days, newest
 * first, pinned threads excluded so they don't duplicate the Pinned tab.
 */
async function getLatestThreads({ page = 1, limit = 20, categoryId } = {}) {
  const skip = (page - 1) * limit;
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const where = {
    isPinned: false,
    isDeprioritized: false,
    createdAt: { gte: twoDaysAgo },
    ...(categoryId ? { categoryId } : {}),
  };

  const [threads, total] = await Promise.all([
    prisma.thread.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        author:   { select: AUTHOR_SELECT },
        category: { select: { id: true, name: true, slug: true } },
        _count:   { select: { likes: true, comments: true } },
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
        category: { select: { id: true, name: true, slug: true } },
        _count:   { select: { likes: true, comments: true } },
      },
    }),
    prisma.thread.findMany({
      where: { isPinned: false, isDeprioritized: false, createdAt: { gte: startOfToday } },
      orderBy: { createdAt: "desc" },
      include: {
        author:   { select: AUTHOR_SELECT },
        category: { select: { id: true, name: true, slug: true } },
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
      category: { select: { id: true, name: true, slug: true } },
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
      category: { select: { id: true, name: true, slug: true } },
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
      category: { select: { id: true, name: true, slug: true } },
      _count:   { select: { likes: true, comments: true } },
    },
  });
  return attachCommentTotal(thread);
}

async function findThread(threadId) {
  return prisma.thread.findUnique({
    where: { id: threadId },
    select: { id: true, authorId: true, title: true, mediaUrl: true, categoryId: true },
  });
}

async function updateThread(threadId, { title, context, mediaUrl, link, isPinned, isDeprioritized, categoryId }) {
  const thread = await prisma.thread.update({
    where: { id: threadId },
    data: {
      ...(title           !== undefined && { title }),
      ...(context         !== undefined && { context }),
      ...(mediaUrl        !== undefined && { mediaUrl }),
      ...(link            !== undefined && { link: link || null }),
      ...(isPinned        !== undefined && { isPinned }),
      ...(isDeprioritized !== undefined && { isDeprioritized }),
      ...(categoryId      !== undefined && { categoryId }),
    },
    include: {
      author:   { select: AUTHOR_SELECT },
      category: { select: { id: true, name: true, slug: true } },
      _count:   { select: { likes: true, comments: true } },
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

async function addReply(commentId, authorId, content, mediaUrls = []) {
  return prisma.threadReply.create({
    data: {
      commentId,
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

// ─── Daily challenge thread ───────────────────────────────────────────────────

async function getDailyThread() {
  const thread = await prisma.thread.findFirst({
    where: {
      isPinned: true,
      title:    { contains: "Daily Writing", mode: "insensitive" },
    },
    include: {
      author:   { select: AUTHOR_SELECT },
      category: { select: { id: true, name: true, slug: true } },
      _count:   { select: { likes: true, comments: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return attachCommentTotal(thread);
}

async function findReply(replyId) {
  return prisma.threadReply.findUnique({
    where: { id: replyId },
    select: { id: true, authorId: true, commentId: true },
  });
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
  // categories
  getCategories,
  createCategory,
  findCategory,
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