const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/draftcontroller");
const { authenticateJWT } = require("../config/jwt");

// All draft routes require authentication — drafts are always private to the writer.

// ─── SPRINT FLOWS (specific routes first to avoid param conflicts) ─────────────

// Lightweight draft list for "pick a draft" modal in sprint room
router.get("/sprint-picker",        authenticateJWT, ctrl.getDraftsForSprintPicker);

// Auto-save when sprint ends with Inkwell editor content
router.post("/sprint-save",         authenticateJWT, ctrl.sprintAutoSave);

// ─── STAGED FOR FEEDBACK (written, but not enough points to post yet) ───────

// The writer's current chapter waiting on points, if any — powers the
// "unlock your post" nudge on the homepage and drafts page.
router.get("/staged",               authenticateJWT, ctrl.getStagedDraft);

// Save (or update) a fresh chapter as "staged for feedback" from the
// submission form, when the writer doesn't yet have enough posting points.
router.post("/stage-for-feedback",  authenticateJWT, ctrl.stageDraftForFeedback);

// ─── UNPUBLISH (submission → draft) ──────────────────────────────────────────

// Move a live critique submission to drafts
router.post("/unpublish/:submissionId", authenticateJWT, ctrl.unpublishSubmission);

// ─── DRAFT CRUD ───────────────────────────────────────────────────────────────

router.get("/",                     authenticateJWT, ctrl.getUserDrafts);
router.post("/",                    authenticateJWT, ctrl.createDraft);
router.patch("/:draftId/star",      authenticateJWT, ctrl.toggleStar);
router.get("/:draftId",             authenticateJWT, ctrl.getDraftById);
router.patch("/:draftId",           authenticateJWT, ctrl.updateDraft);
router.delete("/:draftId",          authenticateJWT, ctrl.deleteDraft);

// ─── DRAFT ACTIONS ────────────────────────────────────────────────────────────

// Republish a previously-unpublished submission back to the critique hub
router.post("/:draftId/republish",  authenticateJWT, ctrl.republishDraft);

// Post a fresh draft as a new critique hub submission
router.post("/:draftId/post-to-hub", authenticateJWT, ctrl.postDraftToHub);

// ─── STICKY NOTES (writer-private "what to fix/add" notes) ──────────────────
// Only ever exist on WritingDraft rows — cascade-deleted the moment a draft
// becomes a live submission, so they never show up in the feedback stage.

router.get("/:draftId/sticky-notes",           authenticateJWT, ctrl.getStickyNotes);
router.post("/:draftId/sticky-notes",          authenticateJWT, ctrl.createStickyNote);
router.patch("/:draftId/sticky-notes/:noteId", authenticateJWT, ctrl.updateStickyNote);
router.delete("/:draftId/sticky-notes/:noteId",authenticateJWT, ctrl.deleteStickyNote);

module.exports = router;