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

// ─── DRAFT CRUD ───────────────────────────────────────────────────────────────

router.get("/",                     authenticateJWT, ctrl.getUserDrafts);
router.post("/",                    authenticateJWT, ctrl.createDraft);
router.patch("/:draftId/star",      authenticateJWT, ctrl.toggleStar);
router.get("/:draftId",             authenticateJWT, ctrl.getDraftById);
router.patch("/:draftId",           authenticateJWT, ctrl.updateDraft);
router.delete("/:draftId",          authenticateJWT, ctrl.deleteDraft);

// ─── STICKY NOTES (writer-private "what to fix/add" notes) ──────────────────
// Only ever exist on WritingDraft rows — cascade-deleted along with the draft.

router.get("/:draftId/sticky-notes",           authenticateJWT, ctrl.getStickyNotes);
router.post("/:draftId/sticky-notes",          authenticateJWT, ctrl.createStickyNote);
router.patch("/:draftId/sticky-notes/:noteId", authenticateJWT, ctrl.updateStickyNote);
router.delete("/:draftId/sticky-notes/:noteId",authenticateJWT, ctrl.deleteStickyNote);

module.exports = router;