const draftService        = require("../services/draftservice");

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * POST /drafts
 * Create a draft file inside a folder (or from the sprint write editor on
 * first open). Every draft lives in a folder — if folderId is omitted or
 * doesn't belong to the caller, it falls back to their default "General"
 * folder (see draftservice.resolveFolderId).
 */
async function createDraft(req, res) {
  const userId = Number(req.user.id);
  const { folderId, title, content } = req.body;

  try {
    const draft = await draftService.createDraft(userId, { folderId, title, content });
    res.status(201).json({ draft });
  } catch (error) {
    console.error("Create draft error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── READ ─────────────────────────────────────────────────────────────────────

/**
 * GET /drafts
 * Get all drafts for the logged-in writer (draft list page). Pass
 * ?folderId= to scope the list to a single folder — though for viewing one
 * folder's contents, GET /draftfolders/:folderId already returns this.
 */
async function getUserDrafts(req, res) {
  const userId = Number(req.user.id);
  const page   = Number(req.query.page)  || 1;
  const limit  = Number(req.query.limit) || 20;
  const starredOnly = req.query.starredOnly === "true";
  const folderId = req.query.folderId ? Number(req.query.folderId) : null;

  try {
    const result = await draftService.getUserDrafts(userId, { page, limit, starredOnly, folderId });
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
 * Get a single draft for the editor view, including its folder context
 * (so the frontend can show an "Overview" button back to the draft plan
 * when the draft lives in a plan folder).
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
 * Delete a draft file.
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

// ─── SPRINT AUTO-SAVE ─────────────────────────────────────────────────────────

/**
 * POST /drafts/sprint-save
 * Called automatically when a sprint ends and the writer used the Inkwell editor.
 * Creates a new draft or updates an existing one.
 * Body: { draftId?, folderId?, title?, content }
 */
async function sprintAutoSave(req, res) {
  const userId = Number(req.user.id);
  const { draftId, folderId, title, content } = req.body;

  if (!content && content !== "") {
    return res.status(400).json({ message: "Content is required for auto-save." });
  }

  try {
    const draft = await draftService.sprintAutoSave(userId, {
      draftId: draftId ? Number(draftId) : null,
      folderId: folderId ? Number(folderId) : null,
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
 * Body: { color?, text?, items?, paragraphIndex? }
 * paragraphIndex lets the client re-pin a note whose paragraph shifted
 * position (insertion/deletion above it) — omit it to leave the note's
 * pin untouched.
 */
async function updateStickyNote(req, res) {
  const userId  = Number(req.user.id);
  const draftId = Number(req.params.draftId);
  const noteId  = Number(req.params.noteId);
  const { color, text, items, paragraphIndex } = req.body;

  try {
    const note = await draftService.updateStickyNote(draftId, noteId, userId, { color, text, items, paragraphIndex });
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
  sprintAutoSave,
  getStickyNotes,
  createStickyNote,
  updateStickyNote,
  deleteStickyNote,
};