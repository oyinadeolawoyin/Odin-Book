// src/services/feedbackService.js
const prisma               = require("../config/prismaClient");
const pointsService        = require("./pointService");
const { UPVOTE_REPUTATION_AWARD } = pointsService;
const { isBlocked }        = require("./userService");

// ─── WORD COUNT HELPERS ───────────────────────────────────────────────────────

const TIER_MAX_WORDS = {
  TIER_1000: 1000,
  TIER_2000: 2000,
  TIER_3000: 3000,
  TIER_4000: 4000,
  TIER_5000: 5000,
};

const GENERAL_FEEDBACK_MIN_WORDS_SHORT = 200; // for chapters ≤ TIER_3000
const GENERAL_FEEDBACK_MIN_WORDS_LONG  = 300; // for chapters ≥ TIER_4000

// Tiers that require the longer minimum
const LONG_CRITIQUE_TIERS = new Set(["TIER_4000", "TIER_5000"]);

// Postgres advisory lock key used to serialize any operation that reads the
// current SPOTLIGHT count and then decides whether to add another submission
// to it (new submissions, and the queue → spotlight fill-up on page load).
// Without this, two concurrent operations can each read the same "5 spotlighted"
// count before either commits, and both promote/assign a chapter to SPOTLIGHT —
// overshooting the intended 6-slot cap. Shared across both call sites so they
// can't race against each other either. Value is arbitrary — just needs to be
// unique within this app so it doesn't collide with an unrelated advisory lock.
const SPOTLIGHT_LOCK_KEY = 571003;

function countWords(text) {
  // Strip HTML tags (including the data-editor-styles wrapper) before counting
  const plain = text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  return plain.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Normalize paragraph spacing in chapter content.
 * Rules:
 *   - If no blank line between paragraphs → add one
 *   - More than one blank line → collapse to one
 * Works on both plain text and HTML (strips tags first to detect structure,
 * but operates on the raw text/HTML string from the editor).
 */
function normalizeSpacing(content) {
  if (!content) return content;

  // Detect HTML content
  const isHtml = /<[a-z][\s\S]*>/i.test(content);

  if (isHtml) {
    // For HTML: we normalize the spacing between block-level elements.
    // The WriteEditor wraps each "paragraph" in a <div> or <p>.
    // We strip the hidden editor-styles marker, then collapse consecutive
    // empty block elements (those with only whitespace inside).
    // 1. Remove the hidden style marker div
    let normalized = content.replace(/<div[^>]*data-editor-styles[^>]*>[\s\S]*?<\/div>/gi, "");

    // 2. Replace 3+ consecutive empty block tags with exactly 2 (one blank "paragraph")
    //    Empty block = <div></div>, <p></p>, <div><br></div>, <p><br></p>, etc.
    const emptyBlock = /(<(?:div|p)[^>]*>(?:<br\s*\/?>|&nbsp;|\s)*<\/(?:div|p)>)/gi;
    // Collapse runs of 3+ empty blocks to 2
    let prev;
    do {
      prev = normalized;
      normalized = normalized.replace(
        new RegExp(`(${emptyBlock.source})(\\s*${emptyBlock.source}){2,}`, "gi"),
        "$1$3"
      );
    } while (normalized !== prev);

    return normalized;
  }

  // Plain text: split on newlines, then rebuild with exactly one blank line between paragraphs
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  // Group into paragraphs (non-empty line runs)
  const paras = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paras.push(current.join("\n"));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paras.push(current.join("\n"));

  // Re-join with exactly one blank line between paragraphs
  return paras.join("\n\n");
}

function validateChapterWordCount(content, tier) {
  const count = countWords(content);
  const max   = TIER_MAX_WORDS[tier];
  if (!max) throw new Error(`Unknown tier: ${tier}`);
  if (count > max) {
    throw new Error(
      `Your chapter is ${count} words, which exceeds the ${max}-word limit for ${tier}.`
    );
  }
  return count;
}

function validateGeneralFeedback(text, wordCountTier = null) {
  const minWords = wordCountTier && LONG_CRITIQUE_TIERS.has(wordCountTier)
    ? GENERAL_FEEDBACK_MIN_WORDS_LONG
    : GENERAL_FEEDBACK_MIN_WORDS_SHORT;
  const words = countWords(text);
  if (words < minWords) {
    throw new Error(
      `Your general feedback is ${words} word${words === 1 ? "" : "s"}. ` +
      `Please write at least ${minWords} words — ` +
      `a good critique needs enough detail to genuinely help the writer.`
    );
  }
}

// ─── SHARED INCLUDES ─────────────────────────────────────────────────────────

const userSelect = {
  id: true,
  username: true,
  avatar: true,
  feedbackPoints: { select: { reputation: true } },
};

const submissionMeta = {
  user:   { select: userSelect },
  _count: { select: { responses: true, paragraphComments: true } },
};

// ─── USER HELPER (mirrors snippetService.getUserById) ────────────────────────

/**
 * Fetch a minimal user object { id, username, email } by ID.
 * Used by the controller to resolve notification recipients without
 * importing prisma directly into the controller.
 * Mirrors snippetService.getUserById.
 */
async function getUserById(userId) {
  return prisma.user.findUnique({
    where:  { id: Number(userId) },
    select: { id: true, username: true, email: true },
  });
}

/**
 * Fetch all users except the given one, with just enough fields for notifyUser.
 * Used by createSubmission to broadcast to all other users.
 */
async function getAllUsersExcept(excludeUserId) {
  return prisma.user.findMany({
    where:  { id: { not: Number(excludeUserId) } },
    select: { id: true, username: true, email: true },
  });
}

// ─── SUBMISSIONS ─────────────────────────────────────────────────────────────

async function createSubmission(userId, data) {
  const {
    title,
    genre,
    summary,
    content,
    wordCountTier,
    draftStage,
    contentWarnings = [],
    feedbackWanted  = [],
  } = data;

  if (!title?.trim())   throw new Error("Title is required.");
  if (!genre?.trim())   throw new Error("Genre is required.");
  if (!content?.trim()) throw new Error("Chapter content cannot be empty.");

  const summaryWords = countWords(summary ?? "");
  if (summaryWords < 25 || summaryWords > 60) {
    throw new Error(`Summary must be 25–60 words (yours is ${summaryWords}).`);
  }

  if (!Array.isArray(feedbackWanted) || feedbackWanted.length === 0) {
    throw new Error("Please add at least one specific feedback request.");
  }

  const actualWordCount = validateChapterWordCount(content, wordCountTier);

  // Count writer's current active chapters (QUEUE or SPOTLIGHT) to calculate surcharge
  const activeChapterCount = await prisma.feedbackSubmission.count({
    where: { userId, status: { in: ["QUEUE", "SPOTLIGHT"] } },
  });

  const { tierCost, surcharge, totalCost } = pointsService.calculatePostingCost(
    wordCountTier,
    activeChapterCount,
  );

  const submission = await prisma.$transaction(async (tx) => {
    let wallet = await tx.feedbackPoint.findUnique({ where: { userId } });
    if (!wallet) {
      wallet = await tx.feedbackPoint.create({
        data: { userId, postingBalance: 5, reputation: 0 },
      });
    }

    const isFreePost = await pointsService.checkAndClaimFreePost(userId, tx);

    if (!isFreePost) {
      await pointsService.deductPostingCost(userId, totalCost, tx);
    }

    // Assign to SPOTLIGHT only if (a) a slot is free AND (b) this author
    // doesn't already have a chapter in the spotlight. If the author is
    // already spotlighted, their new chapter must wait in QUEUE — even
    // when open slots exist — and will be promoted once their current
    // spotlight chapter is archived.
    //
    // Race-condition guard: two submissions arriving close together can
    // both read the same "5 spotlighted" count before either has committed
    // its insert, and both decide SPOTLIGHT — overshooting the 6-slot cap
    // (e.g. ending up with 7). A plain row lock (SELECT ... FOR UPDATE)
    // doesn't fully close this gap either, since there may be no existing
    // SPOTLIGHT rows yet to lock onto when the count is low. A Postgres
    // advisory lock serializes this whole check-then-insert sequence
    // regardless of current row count: a second concurrent transaction
    // simply waits here until the first one commits (releasing the lock),
    // so it sees the up-to-date count before making its own decision.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SPOTLIGHT_LOCK_KEY})`;

    const spotlightCount = await tx.feedbackSubmission.count({
      where: { status: "SPOTLIGHT" },
    });
    const authorAlreadyInSpotlight = await tx.feedbackSubmission.count({
      where: { userId, status: "SPOTLIGHT" },
    });
    const initialStatus =
      spotlightCount < 6 && authorAlreadyInSpotlight === 0 ? "SPOTLIGHT" : "QUEUE";

    return tx.feedbackSubmission.create({
      data: {
        userId,
        title:          title.trim(),
        genre:          genre.trim(),
        summary:        summary.trim(),
        content:        normalizeSpacing(content.trim()),
        wordCountTier,
        actualWordCount,
        draftStage,
        contentWarnings,
        feedbackWanted,
        pointsCost:  isFreePost ? 0 : totalCost,
        wasFreePost: isFreePost,
        status:      initialStatus,
      },
      include: {
        ...submissionMeta,
        user: { select: { id: true, username: true, email: true, avatar: true } },
      },
    });
  });

  return { ...submission, costBreakdown: { tierCost, surcharge, totalCost, activeChapterCount } };
}

async function getSubmissions({ page = 1, limit = 20, genre, status, userId } = {}) {
  const skip  = (page - 1) * limit;
  const where = {};
  // When a userId is given (profile page), show ALL their submissions.
  // status filter only applies to the global public feed.
  if (!userId && status) where.status = status;
  if (!userId && !status) where.status = { in: ["QUEUE", "SPOTLIGHT"] }; // default: active only
  if (!userId) where.isDraft = false; // never show draft-hidden submissions on public feed
  if (genre)  where.genre  = genre;
  if (userId) where.userId = userId;

  const [items, total] = await Promise.all([
    prisma.feedbackSubmission.findMany({
      where,
      include: submissionMeta,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.feedbackSubmission.count({ where }),
  ]);

  return { items, total, page, pages: Math.ceil(total / limit) };
}

async function getSubmissionById(id, requestingUserId = null) {
  const submission = await prisma.feedbackSubmission.findUnique({
    where: { id },
    include: {
      ...submissionMeta,
      responses: {
        include: {
          critic: { select: userSelect },
          _count: { select: { upvotes: true } },
          ...(requestingUserId && {
            upvotes: { where: { userId: requestingUserId }, select: { id: true } },
          }),
        },
        orderBy: { createdAt: "asc" },
      },
      paragraphComments: {
        include: {
          author: { select: userSelect },
          _count: { select: { upvotes: true } },
          ...(requestingUserId && {
            upvotes: { where: { userId: requestingUserId }, select: { id: true } },
          }),
          replies: {
            include: { author: { select: { id: true, username: true, avatar: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  if (!submission) throw new Error("Submission not found.");
  return submission;
}

async function deleteSubmission(submissionId, userId) {
  const sub = await prisma.feedbackSubmission.findUnique({ where: { id: submissionId } });
  if (!sub) throw new Error("Submission not found.");
  if (sub.userId !== userId) throw new Error("Not authorised.");

  // Points are never refunded on deletion — the cost is the price of posting,
  // regardless of whether the submission received critiques or not.
  await prisma.feedbackSubmission.delete({ where: { id: submissionId } });

  return { deleted: true };
}

// ─── UPDATE SUBMISSION ────────────────────────────────────────────────────────

/**
 * Update the editable fields of a submission.
 * wordCountTier and cost are intentionally excluded — they cannot change after posting.
 * Content word-count is still validated against the existing tier.
 */
async function updateSubmission(submissionId, userId, data) {
  const {
    title,
    genre,
    summary,
    content,
    draftStage,
    contentWarnings,
    feedbackWanted,
  } = data;

  const sub = await prisma.feedbackSubmission.findUnique({ where: { id: submissionId } });
  if (!sub)              throw new Error("Submission not found.");
  if (sub.userId !== userId) throw new Error("Not authorised.");

  // Validate title / genre / content presence
  if (title   !== undefined && !title.trim())   throw new Error("Title is required.");
  if (genre   !== undefined && !genre.trim())   throw new Error("Genre is required.");
  if (content !== undefined && !content.trim()) throw new Error("Chapter content cannot be empty.");

  // Summary word count (25–60) if provided
  if (summary !== undefined) {
    const summaryWords = countWords(summary);
    if (summaryWords < 25 || summaryWords > 60) {
      throw new Error(`Summary must be 25–60 words (yours is ${summaryWords}).`);
    }
  }

  // feedbackWanted must not be emptied
  if (feedbackWanted !== undefined) {
    if (!Array.isArray(feedbackWanted) || feedbackWanted.length === 0) {
      throw new Error("Please add at least one specific feedback request.");
    }
  }

  // Content word count must still fit the original tier
  if (content !== undefined) {
    validateChapterWordCount(content, sub.wordCountTier);
  }

  return prisma.feedbackSubmission.update({
    where: { id: submissionId },
    data: {
      ...(title           !== undefined && { title:           title.trim() }),
      ...(genre           !== undefined && { genre:           genre.trim() }),
      ...(summary         !== undefined && { summary:         summary.trim() }),
      ...(content         !== undefined && { content:         normalizeSpacing(content.trim()),
                                             actualWordCount: countWords(content) }),
      ...(draftStage      !== undefined && { draftStage }),
      ...(contentWarnings !== undefined && { contentWarnings }),
      ...(feedbackWanted  !== undefined && { feedbackWanted }),
    },
    include: submissionMeta,
  });
}

// 1. Fetch the Spotlight (Top 6 oldest that are in SPOTLIGHT status, one per user)
async function getSpotlightSubmissions() {
  // Fill any open spotlight slots from QUEUE before fetching — handles submissions
  // created before the slot-check logic was in place, or any edge-case gaps.
  //
  // This whole check-then-fill sequence is wrapped in a transaction guarded by
  // the same advisory lock used in createSubmission. Without it, two people
  // loading this page at nearly the same moment could both read the same
  // "spotlight has room" count and both promote overlapping QUEUE chapters —
  // overshooting the 6-slot cap the same way concurrent submissions could.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SPOTLIGHT_LOCK_KEY})`;

    const currentSpotlightCount = await tx.feedbackSubmission.count({
      where: { status: "SPOTLIGHT", isDraft: false },
    });

    const slotsToFill = 6 - currentSpotlightCount;

    if (slotsToFill > 0) {
      // Collect authors already occupying a spotlight slot so we don't
      // give them a second one while they still have a chapter there.
      const spotlightedAuthorIds = (
        await tx.feedbackSubmission.findMany({
          where:  { status: "SPOTLIGHT", isDraft: false },
          select: { userId: true },
        })
      ).map(s => s.userId);

      // Pick the oldest QUEUE chapters whose authors aren't already spotlighted,
      // one per author (deduplicate in JS after the DB fetch).
      const queueCandidates = await tx.feedbackSubmission.findMany({
        where: {
          status:  "QUEUE",
          isDraft: false,
          ...(spotlightedAuthorIds.length > 0 && {
            userId: { notIn: spotlightedAuthorIds },
          }),
        },
        orderBy: { createdAt: "asc" },
        // Fetch more than needed so we can deduplicate per-author in JS
        take: slotsToFill * 5,
      });

      // One chapter per author, oldest first, up to slotsToFill
      const seenAuthors = new Set();
      const nextInLine  = [];
      for (const s of queueCandidates) {
        if (!seenAuthors.has(s.userId)) {
          seenAuthors.add(s.userId);
          nextInLine.push(s);
        }
        if (nextInLine.length === slotsToFill) break;
      }

      if (nextInLine.length > 0) {
        await tx.feedbackSubmission.updateMany({
          where: { id: { in: nextInLine.map(s => s.id) } },
          data:  { status: "SPOTLIGHT" },
        });
      }
    }
  });

  // Now fetch the updated spotlight
  const candidates = await prisma.feedbackSubmission.findMany({
    where:   { status: "SPOTLIGHT", isDraft: false },
    include: submissionMeta,
    orderBy: { createdAt: "asc" },
  });
 
  // Keep only the single oldest submission per user
  const seen    = new Set();
  const deduped = [];
  for (const sub of candidates) {
    if (!seen.has(sub.userId)) {
      seen.add(sub.userId);
      deduped.push(sub);
    }
    if (deduped.length === 6) break;
  }

  return deduped;
}

// 2. Fetch Outdated (Archive) — supports optional genre filter
async function getOutdatedSubmissions({ page = 1, limit = 10, genre } = {}) {
  const skip = (page - 1) * limit;
  const baseWhere = { status: "ARCHIVE", isDraft: false };
  const where = genre ? { AND: [baseWhere, { genre }] } : baseWhere;

  const [items, total] = await Promise.all([
    prisma.feedbackSubmission.findMany({
      where,
      include: submissionMeta,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.feedbackSubmission.count({ where }),
  ]);

  return { items, total, page, pages: Math.ceil(total / limit) };
}

// 3. Get distinct genres present in the archive (for filter tabs)
async function getArchiveGenres() {
  const rows = await prisma.feedbackSubmission.findMany({
    where:   { status: "ARCHIVE", isDraft: false },
    distinct: ['genre'],
    orderBy: { genre: 'asc' },
  });
  return rows.map(r => r.genre).filter(Boolean);
}

// 4. Get distinct genres present in the queue (for filter tabs)
async function getQueueGenres() {
  const rows = await prisma.feedbackSubmission.findMany({
    where:    { status: "QUEUE", isDraft: false },
    distinct: ['genre'],
    orderBy:  { genre: 'asc' },
  });
  return rows.map(r => r.genre).filter(Boolean);
}

// 5. Fetch Queue — submissions waiting for their first critique (status = QUEUE)
async function getQueueSubmissions({ page = 1, limit = 10, genre } = {}) {
  const skip = (page - 1) * limit;
  const baseWhere = { status: "QUEUE", isDraft: false };
  const where = genre ? { AND: [baseWhere, { genre }] } : baseWhere;

  const [items, total] = await Promise.all([
    prisma.feedbackSubmission.findMany({
      where,
      include: submissionMeta,
      orderBy: { createdAt: 'asc' }, // oldest first — FIFO queue
      skip,
      take: limit,
    }),
    prisma.feedbackSubmission.count({ where }),
  ]);

  return { items, total, page, pages: Math.ceil(total / limit) };
}



async function createResponse(criticId, submissionId, data) {
  const {
    generalFeedback,
    tagResponses = {},   // optional: { [tagName]: feedbackString }
  } = data;

  if (!generalFeedback?.trim()) {
    throw new Error("General feedback cannot be empty.");
  }

  // Fetch submission to check status, tier, and feedbackWanted tags
  const submission = await prisma.feedbackSubmission.findUnique({
    where:   { id: submissionId },
    include: { user: { select: { id: true, username: true, email: true } } },
  });

  if (!submission)                    throw new Error("Submission not found.");
  if (submission.status === "ARCHIVE") throw new Error("This submission is no longer accepting feedback.");
  if (submission.userId === criticId) throw new Error("You cannot critique your own work.");

  // Validate general feedback word count using the submission's tier
  validateGeneralFeedback(generalFeedback, submission.wordCountTier);

  // Block check: submission author has blocked this critic, or critic has blocked author
  const blockedByAuthor = await isBlocked(submission.userId, criticId);
  if (blockedByAuthor) throw new Error("You cannot critique this submission.");
  const blockedAuthor = await isBlocked(criticId, submission.userId);
  if (blockedAuthor) throw new Error("You cannot critique a submission from someone you have blocked.");

  // Sanitise tagResponses: only keep keys that are actual feedbackWanted tags on this submission
  const allowedTags = new Set(submission.feedbackWanted ?? []);
  const sanitisedTagResponses = {};
  for (const [tag, value] of Object.entries(tagResponses)) {
    if (allowedTags.has(tag) && typeof value === "string" && value.trim()) {
      sanitisedTagResponses[tag] = value.trim();
    }
  }

  // Calculate critic's points
  const pointsBreakdown = pointsService.calculateCritiquePoints(
    submission.wordCountTier,
    submission.status,
  );

  const response = await prisma.$transaction(async (tx) => {
    // CREATE THE RESPONSE (with tagResponses stored as JSON)
    const resp = await tx.feedbackResponse.create({
      data: {
        submissionId,
        criticId,
        generalFeedback: generalFeedback.trim(),
        tagResponses:    Object.keys(sanitisedTagResponses).length > 0
                           ? sanitisedTagResponses
                           : undefined,
        pointsEarned: pointsBreakdown.totalPoints,
      },
      include: {
        critic: { select: userSelect },
        _count: { select: { upvotes: true } },
      },
    });

    // AWARD CRITIC POINTS
    await pointsService.awardCritiquePoints(criticId, pointsBreakdown.totalPoints, tx);

    // INCREMENT CRITIQUE COUNT
    const updatedSub = await tx.feedbackSubmission.update({
      where: { id: submissionId },
      data: { critiqueCount: { increment: 1 } }
    });

    // STATUS TRANSITIONS
    //    SPOTLIGHT → ARCHIVE when it hits 2 critiques, then promote oldest QUEUE item.
    //    QUEUE submissions stay in QUEUE until a spotlight slot opens — FIFO, no conditions.
    if (updatedSub.critiqueCount >= 2 && updatedSub.status !== "ARCHIVE") {
      await tx.feedbackSubmission.update({
        where: { id: submissionId },
        data:  { status: "ARCHIVE" },
      });

      // A spotlight slot just freed up — pull in the next eligible chapter
      // from QUEUE. FIFO order, but skip any author who still has another
      // chapter in the spotlight; they'll be promoted once that one is done.
      const spotlightedAuthorIds = (
        await tx.feedbackSubmission.findMany({
          where:  { status: "SPOTLIGHT", isDraft: false },
          select: { userId: true },
        })
      ).map(s => s.userId);

      const nextInLine = await tx.feedbackSubmission.findFirst({
        where: {
          status:  "QUEUE",
          isDraft: false,
          ...(spotlightedAuthorIds.length > 0 && {
            userId: { notIn: spotlightedAuthorIds },
          }),
        },
        orderBy: { createdAt: "asc" },
      });

      if (nextInLine) {
        await tx.feedbackSubmission.update({
          where: { id: nextInLine.id },
          data:  { status: "SPOTLIGHT" },
        });
      }
    }

    return resp;
  });

  return {
    ...response,
    submissionAuthor: submission.user,
    submissionTitle:  submission.title,
    pointsBreakdown,  // expose to controller so it can tell the critic about long-stay bonus
  };
}

async function updateResponse(responseId, criticId, data) {
  const response = await prisma.feedbackResponse.findUnique({
    where:   { id: responseId },
    include: { submission: { select: { wordCountTier: true, feedbackWanted: true } } },
  });
  if (!response)                      throw new Error("Response not found.");
  if (response.criticId !== criticId) throw new Error("Not authorised.");

  const { generalFeedback, tagResponses } = data;

  if (generalFeedback !== undefined) {
    validateGeneralFeedback(generalFeedback, response.submission.wordCountTier);
  }

  // Sanitise tagResponses if provided
  let sanitisedTagResponses;
  if (tagResponses !== undefined) {
    const allowedTags = new Set(response.submission.feedbackWanted ?? []);
    sanitisedTagResponses = {};
    for (const [tag, value] of Object.entries(tagResponses)) {
      if (allowedTags.has(tag) && typeof value === "string" && value.trim()) {
        sanitisedTagResponses[tag] = value.trim();
      }
    }
  }

  return prisma.feedbackResponse.update({
    where: { id: responseId },
    data: {
      ...(generalFeedback      !== undefined && { generalFeedback: generalFeedback.trim() }),
      ...(sanitisedTagResponses !== undefined && { tagResponses: sanitisedTagResponses }),
    },
  });
}

async function toggleResponseUpvote(userId, responseId) {
  const response = await prisma.feedbackResponse.findUnique({
    where:   { id: responseId },
    include: { submission: { select: { userId: true, title: true } } },
  });
  if (!response) throw new Error("Response not found.");
  if (response.criticId === userId) {
    throw new Error("You cannot upvote your own critique.");
  }

  const existing = await prisma.feedbackResponseUpvote.findUnique({
    where: { userId_responseId: { userId, responseId } },
  });

  if (existing) {
    // Remove upvote and deduct the 2 reputation points previously awarded
    await prisma.$transaction([
      prisma.feedbackResponseUpvote.delete({ where: { id: existing.id } }),
      prisma.feedbackPoint.upsert({
        where:  { userId: response.criticId },
        update: { reputation: { decrement: UPVOTE_REPUTATION_AWARD } },
        create: { userId: response.criticId, postingBalance: 0, reputation: 0 },
      }),
    ]);
    return { upvoted: false };
  }

  // Add upvote and award +2 reputation to the critic (not posting points)
  await prisma.$transaction([
    prisma.feedbackResponseUpvote.create({ data: { userId, responseId } }),
    prisma.feedbackPoint.upsert({
      where:  { userId: response.criticId },
      update: { reputation: { increment: UPVOTE_REPUTATION_AWARD } },
      create: { userId: response.criticId, postingBalance: 0, reputation: UPVOTE_REPUTATION_AWARD },
    }),
  ]);

  return {
    upvoted:         true,
    criticId:        response.criticId,
    submissionId:    response.submissionId,
    submissionTitle: response.submission?.title,
  };
}

// ─── PARAGRAPH COMMENTS ──────────────────────────────────────────────────────

async function createParagraphComment(authorId, submissionId, data) {
  const { paragraphIndex, content } = data;

  if (typeof paragraphIndex !== "number" || paragraphIndex < 0) {
    throw new Error("paragraphIndex must be a non-negative integer.");
  }
  if (!content?.trim()) {
    throw new Error("Comment cannot be empty.");
  }

  const submission = await prisma.feedbackSubmission.findUnique({
    where:   { id: submissionId },
    // Include email so the controller can pass the author directly to notifyUser
    include: { user: { select: { id: true, username: true, email: true } } },
  });
  if (!submission)        throw new Error("Submission not found.");
  // Note: paragraph comments are intentionally allowed on ARCHIVE submissions.
  // Full critiques (responses) are gated separately on the frontend via canCritique.

  // Block check: submission author has blocked this commenter, or commenter has blocked author
  if (submission.user.id !== authorId) {
    const blockedByAuthor = await isBlocked(submission.user.id, authorId);
    if (blockedByAuthor) throw new Error("You cannot comment on this submission.");
    const blockedAuthor = await isBlocked(authorId, submission.user.id);
    if (blockedAuthor) throw new Error("You cannot comment on a submission from someone you have blocked.");
  }

  const commenter = await prisma.user.findUnique({
    where:  { id: authorId },
    select: { username: true },
  });

  const comment = await prisma.paragraphComment.create({
    data: { submissionId, authorId, paragraphIndex, content: content.trim() },
    include: {
      author:  { select: userSelect },
      _count:  { select: { upvotes: true } },
      replies: {
        include: { author: { select: { id: true, username: true, avatar: true } } },
      },
    },
  });

  return {
    ...comment,
    submissionAuthor: submission.user,   // full { id, username, email } for notifyUser
    submissionTitle:  submission.title,
    commenterName:    commenter?.username ?? "Someone",
  };
}

async function getParagraphComments(submissionId, paragraphIndex = null, requestingUserId = null) {
  const where = { submissionId };
  if (paragraphIndex !== null) where.paragraphIndex = paragraphIndex;

  return prisma.paragraphComment.findMany({
    where,
    include: {
      author: { select: userSelect },
      _count: { select: { upvotes: true } },
      ...(requestingUserId && {
        upvotes: { where: { userId: requestingUserId }, select: { id: true } },
      }),
      replies: {
        include: { author: { select: { id: true, username: true, avatar: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
  });
}

async function updateParagraphComment(commentId, authorId, content) {
  const comment = await prisma.paragraphComment.findUnique({ where: { id: commentId } });
  if (!comment)                      throw new Error("Comment not found.");
  if (comment.authorId !== authorId) throw new Error("Not authorised.");
  if (!content?.trim())              throw new Error("Comment cannot be empty.");
  return prisma.paragraphComment.update({
    where: { id: commentId },
    data:  { content: content.trim() },
  });
}

async function deleteParagraphComment(commentId, authorId) {
  const comment = await prisma.paragraphComment.findUnique({ where: { id: commentId } });
  if (!comment)                      throw new Error("Comment not found.");
  if (comment.authorId !== authorId) throw new Error("Not authorised.");
  await prisma.paragraphComment.delete({ where: { id: commentId } });
  return { deleted: true };
}

async function toggleParagraphCommentUpvote(userId, commentId) {
  const comment = await prisma.paragraphComment.findUnique({
    where:   { id: commentId },
    include: { submission: { select: { id: true, title: true } } },
  });
  if (!comment)                    throw new Error("Comment not found.");
  if (comment.authorId === userId) throw new Error("You cannot upvote your own comment.");

  const existing = await prisma.paragraphCommentUpvote.findUnique({
    where: { userId_commentId: { userId, commentId } },
  });

  if (existing) {
    await prisma.paragraphCommentUpvote.delete({ where: { id: existing.id } });
    return { upvoted: false };
  }

  await prisma.paragraphCommentUpvote.create({ data: { userId, commentId } });
  return { upvoted: true };
}

// ─── PARAGRAPH COMMENT REPLIES ───────────────────────────────────────────────

async function createParagraphCommentReply(authorId, commentId, content) {
  if (!content?.trim()) {
    throw new Error("Reply cannot be empty.");
  }

  const comment = await prisma.paragraphComment.findUnique({
    where:   { id: commentId },
    // Include email so the controller can pass the comment author directly to notifyUser
    include: {
      submission: { select: { id: true, title: true } },
      author:     { select: { id: true, username: true, email: true } },
    },
  });
  if (!comment) throw new Error("Comment not found.");

  const replier = await prisma.user.findUnique({
    where:  { id: authorId },
    select: { username: true },
  });

  const reply = await prisma.paragraphCommentReply.create({
    data:    { commentId, authorId, content: content.trim() },
    include: { author: { select: { id: true, username: true, avatar: true } } },
  });

  return {
    ...reply,
    commentAuthor:   comment.author,           // full { id, username, email } for notifyUser
    submissionId:    comment.submission.id,
    submissionTitle: comment.submission.title,
    replierName:     replier?.username ?? "Someone",
    paragraphIndex:  comment.paragraphIndex,   // so controller can name the paragraph in notification
  };
}

async function deleteParagraphCommentReply(replyId, authorId) {
  const reply = await prisma.paragraphCommentReply.findUnique({ where: { id: replyId } });
  if (!reply)                      throw new Error("Reply not found.");
  if (reply.authorId !== authorId) throw new Error("Not authorised.");
  await prisma.paragraphCommentReply.delete({ where: { id: replyId } });
  return { deleted: true };
}


// ─── RESPONSES BY USER (for profile page) ────────────────────────────────────

async function getResponsesByUser(userId, { page = 1, limit = 10 } = {}) {
  const skip = (page - 1) * limit;

  const [responses, total] = await Promise.all([
    prisma.feedbackResponse.findMany({
      where:   { criticId: userId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        submission: {
          select: { id: true, title: true, genre: true },
        },
        _count: { select: { upvotes: true } },
      },
    }),
    prisma.feedbackResponse.count({ where: { criticId: userId } }),
  ]);

  // Normalise field names so the frontend CritiqueRow component works:
  // it reads response.content but the model stores generalFeedback
  const normalised = responses.map(r => ({
    ...r,
    content: r.generalFeedback,
  }));

  return {
    responses:  normalised,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

module.exports = {
  getResponsesByUser,
  getUserById,
  getAllUsersExcept,
  createSubmission,
  getSubmissions,
  getSubmissionById,
  deleteSubmission,
  updateSubmission,
  getSpotlightSubmissions,
  getOutdatedSubmissions,
  getQueueSubmissions,
  getArchiveGenres,
  getQueueGenres,
  createResponse,
  updateResponse,
  toggleResponseUpvote,
  createParagraphComment,
  getParagraphComments,
  updateParagraphComment,
  deleteParagraphComment,
  toggleParagraphCommentUpvote,
  createParagraphCommentReply,
  deleteParagraphCommentReply,
};