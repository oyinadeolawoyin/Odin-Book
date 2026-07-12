// src/services/draftService.js
const prisma = require("../config/prismaClient");

// ─── SHARED INCLUDES ──────────────────────────────────────────────────────────

const draftWithSource = {
  sourceSubmission: {
    include: {
      responses: {
        include: {
          critic: { select: { id: true, username: true, avatar: true } },
          _count: { select: { upvotes: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      paragraphComments: {
        include: {
          author: { select: { id: true, username: true, avatar: true } },
          _count: { select: { upvotes: true } },
          replies: {
            include: { author: { select: { id: true, username: true, avatar: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
        orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
      },
    },
  },
};

// ─── CREATE ───────────────────────────────────────────────────────────────────

async function createDraft(userId, { title = null, content = "" } = {}) {
  const wordCount = countWords(content);
  return prisma.writingDraft.create({
    data: {
      userId,
      title:     title?.trim() || null,
      content,
      wordCount,
    },
  });
}

// ─── READ ─────────────────────────────────────────────────────────────────────

async function getUserDrafts(userId, { page = 1, limit = 20, starredOnly = false } = {}) {
  const skip = (page - 1) * limit;
  const where = { userId, ...(starredOnly ? { isStarred: true } : {}) };

  const [items, total] = await Promise.all([
    prisma.writingDraft.findMany({
      where,
      orderBy: [{ isStarred: "desc" }, { updatedAt: "desc" }],
      skip,
      take: limit,
      select: {
        id:                  true,
        title:               true,
        wordCount:           true,
        createdAt:           true,
        updatedAt:           true,
        sourceSubmissionId:  true,
        isStarred:           true,
        // Staging fields — let the drafts page tell a chapter that's
        // genuinely staged-and-waiting-on-points apart from an ordinary
        // work-in-progress draft, and post it directly without re-opening
        // the submission form.
        isStagedForFeedback:    true,
        stagedGenre:             true,
        stagedSummary:           true,
        stagedWordCountTier:     true,
        stagedDraftStage:        true,
        stagedContentWarnings:   true,
        stagedFeedbackWanted:    true,
        sourceSubmission: {
          select: {
            id:            true,
            title:         true,
            genre:         true,
            isDraft:       true,
            critiqueCount: true,
            _count: { select: { responses: true, paragraphComments: true } },
          },
        },
      },
    }),
    prisma.writingDraft.count({ where }),
  ]);

  return { items, total, page, pages: Math.ceil(total / limit) };
}

// ─── STAR ─────────────────────────────────────────────────────────────────────

async function toggleDraftStar(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
    select: { isStarred: true },
  });
  if (!draft) throw new Error("Draft not found.");

  return prisma.writingDraft.update({
    where: { id: draftId },
    data: { isStarred: !draft.isStarred },
    select: { id: true, isStarred: true },
  });
}

async function getDraftById(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where:   { id: draftId, userId },
    include: draftWithSource,
  });
  if (!draft) throw new Error("Draft not found.");
  return draft;
}

async function getDraftsForSprintPicker(userId) {
  return prisma.writingDraft.findMany({
    where:   { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id:        true,
      title:     true,
      wordCount: true,
      updatedAt: true,
      sourceSubmission: {
        select: { id: true, title: true, genre: true },
      },
    },
  });
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

async function updateDraft(draftId, userId, { title, content }) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
  });
  if (!draft) throw new Error("Draft not found.");

  const data = {};
  if (title   !== undefined) data.title     = title?.trim() || null;
  if (content !== undefined) {
    data.content   = content;
    data.wordCount = countWords(content);
  }

  return prisma.writingDraft.update({ where: { id: draftId }, data });
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function deleteDraft(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
  });
  if (!draft) throw new Error("Draft not found.");

  if (draft.sourceSubmissionId) {
    await prisma.feedbackSubmission.delete({
      where: { id: draft.sourceSubmissionId },
    });
  } else {
    await prisma.writingDraft.delete({ where: { id: draftId } });
  }

  return { deleted: true };
}

// ─── UNPUBLISH → DRAFT ────────────────────────────────────────────────────────

async function unpublishSubmission(submissionId, userId) {
  const submission = await prisma.feedbackSubmission.findFirst({
    where: { id: submissionId, userId },
  });
  if (!submission) throw new Error("Submission not found.");
  if (submission.isDraft) throw new Error("Submission is already unpublished.");

  const [, draft] = await prisma.$transaction(async (tx) => {
    // Mark submission as a hidden draft
    const updated = await tx.feedbackSubmission.update({
      where: { id: submissionId },
      data: {
        isDraft:       true,
        unpublishedAt: new Date(),
      },
    });

    // Create draft mirror — idempotent via upsert
    const writingDraft = await tx.writingDraft.upsert({
      where:  { sourceSubmissionId: submissionId },
      update: {},
      create: {
        userId,
        title:              submission.title,
        content:            submission.content,
        wordCount:          submission.actualWordCount,
        sourceSubmissionId: submissionId,
      },
    });

    return [updated, writingDraft];
  });

  return draft;
}

// ─── REPUBLISH FROM DRAFT ─────────────────────────────────────────────────────

async function republishDraft(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
  });
  if (!draft)                    throw new Error("Draft not found.");
  if (!draft.sourceSubmissionId) throw new Error("This draft has no linked submission to republish.");

  const submission = await prisma.feedbackSubmission.findFirst({
    where: { id: draft.sourceSubmissionId, userId },
  });
  if (!submission)        throw new Error("Linked submission not found.");
  if (!submission.isDraft) throw new Error("Submission is already published.");

  // Check one-spotlight-at-a-time rule
  const existingSpotlight = await prisma.feedbackSubmission.findFirst({
    where: {
      userId,
      isDraft:    false,
      status:     { in: ["QUEUE", "SPOTLIGHT"] },
      id:         { not: submission.id },
    },
    select: { id: true, title: true },
  });
  if (existingSpotlight) {
    throw new Error(
      `You already have a chapter in the spotlight: "${existingSpotlight.title}". ` +
      `It needs to receive 3 critiques before you can republish.`
    );
  }

  // Decide which status to give it when it goes back live
  const spotlightCount = await prisma.feedbackSubmission.count({
    where: { status: "SPOTLIGHT" },
  });
  const newStatus = spotlightCount < 6 ? "SPOTLIGHT" : "QUEUE";

  await prisma.$transaction(async (tx) => {
    await tx.feedbackSubmission.update({
      where: { id: submission.id },
      data: {
        title:           draft.title || submission.title,
        content:         draft.content,
        actualWordCount: draft.wordCount,
        isDraft:         false,
        status:          newStatus,
        unpublishedAt:   null,
      },
    });

    await tx.writingDraft.delete({ where: { id: draftId } });
  });

  return { republished: true, submissionId: submission.id };
}

// ─── POST DRAFT TO FEEDBACK HUB ──────────────────────────────────────────────

async function getDraftForPosting(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
  });
  if (!draft) throw new Error("Draft not found.");
  if (draft.sourceSubmissionId) {
    throw new Error(
      "This draft is linked to an existing submission. Use republish instead."
    );
  }
  return draft;
}

// ─── STAGE DRAFT FOR FEEDBACK (written, but not enough points to post yet) ──

/**
 * Save a freshly-written chapter as "staged for feedback".
 *
 * This is the path the submission form falls back to when the writer has
 * finished a chapter and chosen a tier, but doesn't have enough posting
 * points to send it to the Critique Hub right now. Instead of losing their
 * work, it's saved as a WritingDraft with isStagedForFeedback = true, and
 * the submission metadata (genre, summary, tier, draft stage, etc.) is
 * stored alongside it so the chapter can be posted in one click later —
 * once the writer earns enough points by critiquing — without re-filling
 * the whole form.
 *
 * isStagedForFeedback is what lets the frontend tell "a chapter is genuinely
 * waiting to be unlocked" apart from an ordinary work-in-progress draft the
 * writer is just drafting on their own with no submission intent yet.
 *
 * @param {number} userId
 * @param {object} data
 * @param {number|null} data.draftId  — pass the previously-staged draft's id to update it in place
 */
async function stageDraftForFeedback(userId, {
  draftId = null,
  title,
  content,
  genre,
  summary,
  wordCountTier,
  draftStage,
  contentWarnings = [],
  feedbackWanted  = [],
} = {}) {
  if (!content?.trim()) throw new Error("Your chapter is empty. Write something first.");

  const stagedFields = {
    title:                  title?.trim() || null,
    content,
    wordCount:              countWords(content),
    isStagedForFeedback:    true,
    stagedGenre:            genre || null,
    stagedSummary:          summary || null,
    stagedWordCountTier:    wordCountTier || null,
    stagedDraftStage:       draftStage || null,
    stagedContentWarnings:  contentWarnings,
    stagedFeedbackWanted:   feedbackWanted,
    stagedAt:               new Date(),
  };

  if (draftId) {
    const existing = await prisma.writingDraft.findFirst({ where: { id: draftId, userId } });
    if (!existing) throw new Error("Draft not found.");
    if (existing.sourceSubmissionId) {
      throw new Error("This draft is linked to a live submission — use unpublish/republish instead.");
    }
    return prisma.writingDraft.update({ where: { id: draftId }, data: stagedFields });
  }

  return prisma.writingDraft.create({ data: { userId, ...stagedFields } });
}

// Returns the writer's current staged-for-feedback draft (most recent), or null.
// Used to power accurate "unlock your post" messaging — never a generic guess.
async function getStagedDraft(userId) {
  return prisma.writingDraft.findFirst({
    where:   { userId, isStagedForFeedback: true, sourceSubmissionId: null },
    orderBy: { stagedAt: "desc" },
  });
}

// ─── SPRINT AUTO-SAVE ─────────────────────────────────────────────────────────

async function sprintAutoSave(userId, { draftId, title, content }) {
  if (draftId) {
    const draft = await prisma.writingDraft.findFirst({
      where: { id: draftId, userId },
    });
    if (!draft) throw new Error("Draft not found for auto-save.");

    return prisma.writingDraft.update({
      where: { id: draftId },
      data: {
        title:     title?.trim() || draft.title,
        content,
        wordCount: countWords(content),
      },
    });
  }

  return prisma.writingDraft.create({
    data: {
      userId,
      title:     title?.trim() || null,
      content,
      wordCount: countWords(content),
    },
  });
}

// ─── STICKY NOTES ─────────────────────────────────────────────────────────────
//
// Writer-private scratch notes on a draft. paragraphIndex === null/undefined
// means a whole-draft note; any other integer is a paragraph note. These only
// ever exist on WritingDraft rows, so they naturally vanish (cascade delete)
// the moment a draft becomes a live submission (postDraftToHub / republishDraft
// both delete the WritingDraft row) — that's what keeps them out of the
// feedback/critique stage without any extra flag to check.

const STICKY_NOTE_COLORS = ["YELLOW", "PINK", "BLUE", "GREEN", "PURPLE", "ORANGE"];

async function assertOwnsDraft(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({ where: { id: draftId, userId } });
  if (!draft) throw new Error("Draft not found.");
  return draft;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(i => String(i).trim()).filter(Boolean).slice(0, 50);
}

async function getStickyNotes(draftId, userId) {
  await assertOwnsDraft(draftId, userId);
  return prisma.stickyNote.findMany({
    where:   { draftId },
    orderBy: [{ paragraphIndex: "asc" }, { createdAt: "asc" }],
  });
}

async function createStickyNote(draftId, userId, {
  paragraphIndex = null,
  color = "YELLOW",
  text = "",
  items = [],
} = {}) {
  await assertOwnsDraft(draftId, userId);

  const cleanText  = (text || "").trim();
  const cleanItems = normalizeItems(items);
  if (!cleanText && cleanItems.length === 0) {
    throw new Error("A sticky note needs some text or at least one list item.");
  }

  const cleanColor = STICKY_NOTE_COLORS.includes(color) ? color : "YELLOW";
  const cleanIndex = paragraphIndex === null || paragraphIndex === undefined
    ? null
    : Math.max(0, Number(paragraphIndex) || 0);

  return prisma.stickyNote.create({
    data: {
      draftId,
      userId,
      paragraphIndex: cleanIndex,
      color:          cleanColor,
      text:           cleanText,
      items:          cleanItems,
    },
  });
}

async function updateStickyNote(draftId, noteId, userId, { color, text, items } = {}) {
  await assertOwnsDraft(draftId, userId);
  const note = await prisma.stickyNote.findFirst({ where: { id: noteId, draftId } });
  if (!note) throw new Error("Sticky note not found.");

  const data = {};
  if (color !== undefined) data.color = STICKY_NOTE_COLORS.includes(color) ? color : note.color;
  if (text  !== undefined) data.text  = (text || "").trim();
  if (items !== undefined) data.items = normalizeItems(items);

  // Guard against ending up with a fully empty note
  const nextText  = data.text  !== undefined ? data.text  : note.text;
  const nextItems = data.items !== undefined ? data.items : note.items;
  if (!nextText && nextItems.length === 0) {
    throw new Error("A sticky note needs some text or at least one list item.");
  }

  return prisma.stickyNote.update({ where: { id: noteId }, data });
}

async function deleteStickyNote(draftId, noteId, userId) {
  await assertOwnsDraft(draftId, userId);
  const note = await prisma.stickyNote.findFirst({ where: { id: noteId, draftId } });
  if (!note) throw new Error("Sticky note not found.");
  await prisma.stickyNote.delete({ where: { id: noteId } });
  return { deleted: true };
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

function countWords(text = "") {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createDraft,
  getUserDrafts,
  toggleDraftStar,
  getDraftById,
  getDraftsForSprintPicker,
  updateDraft,
  deleteDraft,
  unpublishSubmission,
  republishDraft,
  getDraftForPosting,
  stageDraftForFeedback,
  getStagedDraft,
  sprintAutoSave,
  getStickyNotes,
  createStickyNote,
  updateStickyNote,
  deleteStickyNote,
};