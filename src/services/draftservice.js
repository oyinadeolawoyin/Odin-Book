// src/services/draftService.js
const prisma = require("../config/prismaClient");
const { todayInTimezone } = require("../utilis/timezone");
const { recordDraftActivity } = require("./writingactivityservice");
const draftFolderService = require("./draftfolderservice");

// ─── CREATE ───────────────────────────────────────────────────────────────────

// Every draft file has to live in a folder now. If the caller doesn't pass
// one (or passes one that isn't theirs), fall back to their default
// "General" folder rather than failing outright — a draft should never end
// up with nowhere to live.
async function resolveFolderId(userId, folderId) {
  if (folderId) {
    const folder = await prisma.draftFolder.findFirst({ where: { id: Number(folderId), userId } });
    if (folder) return folder.id;
  }
  const general = await draftFolderService.getOrCreateDefaultGeneralFolder(userId);
  return general.id;
}

async function createDraft(userId, { folderId, title = null, content = "" } = {}) {
  const resolvedFolderId = await resolveFolderId(userId, folderId);
  const wordCount = countWords(content);
  return prisma.writingDraft.create({
    data: {
      userId,
      folderId: resolvedFolderId,
      title:     title?.trim() || null,
      content,
      wordCount,
    },
  });
}

// ─── READ ─────────────────────────────────────────────────────────────────────

async function getUserDrafts(userId, { page = 1, limit = 20, starredOnly = false, folderId = null } = {}) {
  const skip = (page - 1) * limit;
  const where = {
    userId,
    ...(starredOnly ? { isStarred: true } : {}),
    ...(folderId ? { folderId: Number(folderId) } : {}),
  };

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
        isStarred:           true,
        folderId:            true,
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
    where: { id: draftId, userId },
    include: {
      folder: { select: { id: true, name: true, draftPlanId: true } },
    },
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
      folderId:  true,
      folder:    { select: { name: true, draftPlanId: true } },
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
  let newWordCount;
  if (title   !== undefined) data.title     = title?.trim() || null;
  if (content !== undefined) {
    newWordCount   = countWords(content);
    data.content   = content;
    data.wordCount = newWordCount;
  }

  const updated = await prisma.writingDraft.update({ where: { id: draftId }, data });

  // Workspace output tracking — net positive word delta only (trims/edits
  // that shrink the count aren't "output"). Fire-and-forget: never let a
  // stats-tracking hiccup block the actual save.
  if (newWordCount !== undefined) {
    const delta = newWordCount - draft.wordCount;
    if (delta > 0) {
      const user     = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
      const timezone = user?.timezone ?? "UTC";
      recordDraftActivity(userId, todayInTimezone(timezone), delta).catch((err) =>
        console.error("recordDraftActivity error:", err)
      );
    }
  }

  return updated;
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function deleteDraft(draftId, userId) {
  const draft = await prisma.writingDraft.findFirst({
    where: { id: draftId, userId },
  });
  if (!draft) throw new Error("Draft not found.");

  await prisma.writingDraft.delete({ where: { id: draftId } });
  return { deleted: true };
}

// ─── SPRINT AUTO-SAVE ─────────────────────────────────────────────────────────

async function sprintAutoSave(userId, { draftId, folderId, title, content }) {
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

  const resolvedFolderId = await resolveFolderId(userId, folderId);

  return prisma.writingDraft.create({
    data: {
      userId,
      folderId: resolvedFolderId,
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
// ever exist on WritingDraft rows and are cascade-deleted along with the
// draft itself.
//
// updateStickyNote also accepts paragraphIndex (see below) so the client can
// re-pin a note after a paragraph insertion/deletion shifts everything below
// it — see useDraftStickyNotes.js's resyncParagraphIndex for the client side
// of this.

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

async function updateStickyNote(draftId, noteId, userId, { color, text, items, paragraphIndex } = {}) {
  await assertOwnsDraft(draftId, userId);
  const note = await prisma.stickyNote.findFirst({ where: { id: noteId, draftId } });
  if (!note) throw new Error("Sticky note not found.");

  const data = {};
  if (color !== undefined) data.color = STICKY_NOTE_COLORS.includes(color) ? color : note.color;
  if (text  !== undefined) data.text  = (text || "").trim();
  if (items !== undefined) data.items = normalizeItems(items);
  // Lets the client re-pin a note after paragraph insertion/deletion shifts
  // everything below it — same clamping createStickyNote already applies.
  // null clears it back to a whole-draft note; any other value clamps to
  // a non-negative int.
  if (paragraphIndex !== undefined) {
    data.paragraphIndex = paragraphIndex === null
      ? null
      : Math.max(0, Number(paragraphIndex) || 0);
  }

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
  sprintAutoSave,
  getStickyNotes,
  createStickyNote,
  updateStickyNote,
  deleteStickyNote,
};