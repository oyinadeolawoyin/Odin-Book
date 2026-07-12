const draftService        = require("../services/draftservice");
const feedbackService     = require("../services/feedbackService");
const { notifyUser }      = require("../services/notificationService");

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * POST /drafts
 * Create a blank draft manually (or from sprint write editor on first open).
 */
async function createDraft(req, res) {
  const userId = Number(req.user.id);
  const { title, content } = req.body;

  try {
    const draft = await draftService.createDraft(userId, { title, content });
    res.status(201).json({ draft });
  } catch (error) {
    console.error("Create draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── READ ─────────────────────────────────────────────────────────────────────

/**
 * GET /drafts
 * Get all drafts for the logged-in writer (draft list page).
 */
async function getUserDrafts(req, res) {
  const userId = Number(req.user.id);
  const page   = Number(req.query.page)  || 1;
  const limit  = Number(req.query.limit) || 20;
  const starredOnly = req.query.starredOnly === "true";

  try {
    const result = await draftService.getUserDrafts(userId, { page, limit, starredOnly });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get drafts error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * PATCH /drafts/:draftId/star
 * Toggle whether a draft is starred (priority drafts sort to the top of
 * the drafts list and can be filtered to on their own).
 */
async function toggleStar(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  try {
    const draft = await draftService.toggleDraftStar(draftId, userId);
    res.status(200).json({ draft });
  } catch (error) {
    if (error.message === "Draft not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Toggle draft star error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * GET /drafts/sprint-picker
 * Lightweight list for the sprint modal "pick a draft" flow.
 */
async function getDraftsForSprintPicker(req, res) {
  const userId = Number(req.user.id);

  try {
    const drafts = await draftService.getDraftsForSprintPicker(userId);
    res.status(200).json({ drafts });
  } catch (error) {
    console.error("Sprint picker drafts error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * GET /drafts/:draftId
 * Get a single draft with full source submission comments (editor view).
 */
async function getDraftById(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  try {
    const draft = await draftService.getDraftById(draftId, userId);
    res.status(200).json({ draft });
  } catch (error) {
    if (error.message === "Draft not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Get draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────

/**
 * PATCH /drafts/:draftId
 * Save or auto-save draft content.
 */
async function updateDraft(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);
  const { title, content } = req.body;

  try {
    const draft = await draftService.updateDraft(draftId, userId, { title, content });
    res.status(200).json({ draft });
  } catch (error) {
    if (error.message === "Draft not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Update draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

/**
 * DELETE /drafts/:draftId
 * Delete a draft. Linked submission (if any) stays hidden but is not deleted.
 */
async function deleteDraft(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  try {
    await draftService.deleteDraft(draftId, userId);
    res.status(200).json({ deleted: true });
  } catch (error) {
    if (error.message === "Draft not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Delete draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── UNPUBLISH SUBMISSION → DRAFT ─────────────────────────────────────────────

/**
 * POST /drafts/unpublish/:submissionId
 * Unpublish a live critique submission and move it to the draft page.
 * All critiques and paragraph comments are preserved on the submission record.
 */
async function unpublishSubmission(req, res) {
  const userId       = Number(req.user.id);
  const submissionId = Number(req.params.submissionId);

  try {
    const draft = await draftService.unpublishSubmission(submissionId, userId);
    res.status(200).json({ draft, message: "Chapter moved to your drafts." });
  } catch (error) {
    if (
      error.message === "Submission not found." ||
      error.message === "Submission is already unpublished."
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Unpublish submission error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── REPUBLISH DRAFT → CRITIQUE HUB ──────────────────────────────────────────

/**
 * POST /drafts/:draftId/republish
 * Republish a draft that was previously unpublished from the critique hub.
 * Syncs edited content back to the submission and makes it live again.
 */
async function republishDraft(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  try {
    const result = await draftService.republishDraft(draftId, userId);

    // Notify the writer their chapter is live again
    await notifyUser(
      req.user,
      "Your chapter is back in the Critique Hub. Writers can now read and critique it 🌱",
      `/feedback/${result.submissionId}`,
      "submission_republished"
    );

    res.status(200).json(result);
  } catch (error) {
    if (
      error.message === "Draft not found." ||
      error.message === "This draft has no linked submission to republish." ||
      error.message.startsWith("You already have a chapter in the spotlight")
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Republish draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * GET /drafts/staged
 * Returns the writer's current "staged for feedback" draft, if any — a
 * chapter they finished writing and chose a tier for, but couldn't yet
 * afford to post. The homepage and drafts page use this (instead of just
 * checking "do they have any draft at all") to show an accurate "unlock
 * your post" nudge rather than a generic one.
 */
async function getStagedDraft(req, res) {
  const userId = Number(req.user.id);
  try {
    const draft = await draftService.getStagedDraft(userId);
    res.status(200).json({ draft });
  } catch (error) {
    console.error("Get staged draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * POST /drafts/stage-for-feedback
 * Saves a freshly-written chapter as a draft tagged "staged for feedback".
 * Used by the submission form when the writer doesn't have enough posting
 * points for the tier they picked — their chapter and submission details
 * (genre, summary, tier, draft stage, etc.) are preserved so it can be
 * posted in one click once they've earned enough points by critiquing.
 * Body: { draftId?, title, content, genre, summary, wordCountTier, draftStage, contentWarnings, feedbackWanted }
 */
async function stageDraftForFeedback(req, res) {
  const userId = Number(req.user.id);
  const {
    draftId,
    title,
    content,
    genre,
    summary,
    wordCountTier,
    draftStage,
    contentWarnings = [],
    feedbackWanted  = [],
  } = req.body;

  try {
    const draft = await draftService.stageDraftForFeedback(userId, {
      draftId: draftId ? Number(draftId) : null,
      title, content, genre, summary, wordCountTier, draftStage,
      contentWarnings, feedbackWanted,
    });
    res.status(200).json({ draft });
  } catch (error) {
    if (
      error.message === "Draft not found." ||
      error.message.startsWith("Your chapter is empty") ||
      error.message.startsWith("This draft is linked")
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Stage draft for feedback error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── POST DRAFT TO FEEDBACK HUB (fresh draft → new submission) ───────────────

/**
 * POST /drafts/:draftId/post-to-hub
 * Convert a fresh draft (not previously published) into a new FeedbackSubmission.
 *
 * Flow:
 * 1. Validate the draft belongs to this user and has no linked submission.
 * 2. Pass draft content + writer's submission metadata to feedbackService.createSubmission.
 * 3. On success, delete the draft.
 *
 * The writer fills in genre, summary, draftStage, feedbackWanted, wordCountTier
 * in the submission form on the frontend — those come in req.body.
 */
async function postDraftToHub(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  const {
    genre,
    summary,
    draftStage,
    wordCountTier,
    contentWarnings,
    feedbackWanted,
  } = req.body;

  try {
    // 1. Fetch and validate the draft
    const draft = await draftService.getDraftForPosting(draftId, userId);

    if (!draft.title?.trim()) {
      return res.status(400).json({ message: "Please add a title to your draft before posting." });
    }
    if (!draft.content?.trim()) {
      return res.status(400).json({ message: "Your draft is empty. Write something first." });
    }

    // If this draft was previously "staged for feedback", fall back to the
    // submission details captured at staging time for any field the caller
    // didn't send — this is what lets a writer unlock and post a staged
    // chapter directly from the drafts page in one click, without
    // re-entering the whole submission form.
    const resolved = {
      genre:           genre           ?? draft.stagedGenre,
      summary:         summary         ?? draft.stagedSummary,
      draftStage:      draftStage      ?? draft.stagedDraftStage,
      wordCountTier:   wordCountTier   ?? draft.stagedWordCountTier,
      contentWarnings: contentWarnings ?? draft.stagedContentWarnings ?? [],
      feedbackWanted:  feedbackWanted  ?? draft.stagedFeedbackWanted  ?? [],
    };

    // 2. Create the submission (handles points, validation, spotlight rule)
    const submission = await feedbackService.createSubmission(userId, {
      title:          draft.title,
      genre:          resolved.genre,
      summary:        resolved.summary,
      content:        draft.content,
      wordCountTier:  resolved.wordCountTier,
      draftStage:     resolved.draftStage,
      contentWarnings: resolved.contentWarnings,
      feedbackWanted:  resolved.feedbackWanted,
    });

    // 3. Delete the draft — it's now a live submission
    await draftService.deleteDraft(draftId, userId);

    // Notify all other users a new chapter is up (mirrors feedbackController pattern)
    const allUsers = await feedbackService.getAllUsersExcept(userId);
    await Promise.allSettled(
      allUsers.map((u) =>
        notifyUser(
          u,
          `A new chapter is in the Critique Hub: "${submission.title}"`,
          `/feedback/${submission.id}`,
          "new_submission"
        )
      )
    );

    res.status(201).json({ submission });
  } catch (error) {
    if (
      error.message.startsWith("You already have a chapter") ||
      error.message.startsWith("Summary must be") ||
      error.message.startsWith("Please add at least") ||
      error.message.startsWith("Your chapter is") ||
      error.message === "Draft not found." ||
      error.message.startsWith("This draft is linked") ||
      error.message.startsWith("Not enough points")
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Post draft to hub error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── SPRINT AUTO-SAVE ─────────────────────────────────────────────────────────

/**
 * POST /drafts/sprint-save
 * Called automatically when a sprint ends and the writer used the Inkwell editor.
 * Creates a new draft or updates an existing one.
 * Body: { draftId?, title?, content }
 */
async function sprintAutoSave(req, res) {
  const userId = Number(req.user.id);
  const { draftId, title, content } = req.body;

  if (!content && content !== "") {
    return res.status(400).json({ message: "Content is required for auto-save." });
  }

  try {
    const draft = await draftService.sprintAutoSave(userId, {
      draftId: draftId ? Number(draftId) : null,
      title,
      content,
    });
    res.status(200).json({ draft });
  } catch (error) {
    if (error.message === "Draft not found for auto-save.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Sprint auto-save error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── STICKY NOTES ─────────────────────────────────────────────────────────────

/**
 * GET /drafts/:draftId/sticky-notes
 * All sticky notes for a draft (both whole-draft and per-paragraph),
 * for the right-side panel to group and render.
 */
async function getStickyNotes(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);

  try {
    const notes = await draftService.getStickyNotes(draftId, userId);
    res.status(200).json({ notes });
  } catch (error) {
    if (error.message === "Draft not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Get sticky notes error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * POST /drafts/:draftId/sticky-notes
 * Create a sticky note. Body: { paragraphIndex?, color?, text?, items? }
 * Omit paragraphIndex (or send null) for a whole-draft note.
 */
async function createStickyNote(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);
  const { paragraphIndex, color, text, items } = req.body;

  try {
    const note = await draftService.createStickyNote(draftId, userId, {
      paragraphIndex, color, text, items,
    });
    res.status(201).json({ note });
  } catch (error) {
    if (
      error.message === "Draft not found." ||
      error.message.startsWith("A sticky note needs")
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Create sticky note error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * PATCH /drafts/:draftId/sticky-notes/:noteId
 * Body: { color?, text?, items? }
 */
async function updateStickyNote(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);
  const noteId  = Number(req.params.noteId);
  const { color, text, items } = req.body;

  try {
    const note = await draftService.updateStickyNote(draftId, noteId, userId, { color, text, items });
    res.status(200).json({ note });
  } catch (error) {
    if (error.message === "Draft not found." || error.message === "Sticky note not found.") {
      return res.status(404).json({ message: error.message });
    }
    if (error.message.startsWith("A sticky note needs")) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Update sticky note error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * DELETE /drafts/:draftId/sticky-notes/:noteId
 */
async function deleteStickyNote(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);
  const noteId  = Number(req.params.noteId);

  try {
    await draftService.deleteStickyNote(draftId, noteId, userId);
    res.status(200).json({ deleted: true });
  } catch (error) {
    if (error.message === "Draft not found." || error.message === "Sticky note not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Delete sticky note error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  createDraft,
  getUserDrafts,
  toggleStar,
  getDraftById,
  getDraftsForSprintPicker,
  updateDraft,
  deleteDraft,
  unpublishSubmission,
  republishDraft,
  postDraftToHub,
  getStagedDraft,
  stageDraftForFeedback,
  sprintAutoSave,
  getStickyNotes,
  createStickyNote,
  updateStickyNote,
  deleteStickyNote,
};