// src/services/draftFolderService.js
//
// Every WritingDraft lives inside a DraftFolder — there's no such thing as
// a loose draft file. Two flavors:
//
//   - Plan folder     (draftPlanId set)  — auto-created the moment a
//     DraftPlan is created (see createFolderForPlan, called from
//     draftplanservice.js right after the plan row is inserted). One per
//     plan. Can't be renamed or deleted directly — its display name always
//     comes live off the plan's storyTitle, and it only goes away if the
//     plan itself is deleted (cascade).
//
//   - General folder  (draftPlanId null) — exactly ONE per writer, for
//     drafts that aren't tied to any story plan. Auto-created at signup
//     (see createDefaultGeneralFolder, called from authController.js
//     signup right after the user row is created) — writers never create
//     this themselves. They CAN rename it, but can't delete it; there's
//     nothing to fall back to if they did, since it's the catch-all.

const prisma = require("../config/prismaClient");

const MAX_FOLDER_NAME_LENGTH = 80;
const DEFAULT_GENERAL_FOLDER_NAME = "General";

// ─── SHARED SHAPING ─────────────────────────────────────────────────────────

// percent of the plan's target that's been logged so far — same "totalSoFar
// vs targetLength" math used for the weekly-goal ring on the workspace
// dashboard, so the number a writer sees here always matches what they see
// there. Deliberately reads DraftProgressLog (what the writer has logged),
// not WritingDraft.wordCount (what's literally typed in the files) — those
// can diverge (e.g. progress logged from a sprint that didn't use the
// in-app editor), and the logged number is the plan's canonical progress.
function computePercentDrafted(plan) {
  if (!plan || !plan.targetLength) return 0;
  const totalLogged = (plan.progressLogs || []).reduce((a, l) => a + l.countLogged, 0);
  const totalSoFar = plan.wordsWrittenSoFar + totalLogged;
  return Math.min(Math.round((totalSoFar / plan.targetLength) * 100), 100);
}

function shapeFolder(folder) {
  const isPlanFolder = folder.draftPlanId !== null;
  return {
    id: folder.id,
    isPlanFolder,
    draftPlanId: folder.draftPlanId,
    name: isPlanFolder ? folder.draftPlan.storyTitle : folder.name,
    goalType: isPlanFolder ? folder.draftPlan.goalType : null,
    percentDrafted: isPlanFolder ? computePercentDrafted(folder.draftPlan) : null,
    planCompleted: isPlanFolder ? folder.draftPlan.isCompleted : null,
    draftCount: folder._count?.drafts ?? undefined,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

async function assertOwnsFolder(folderId, userId) {
  const folder = await prisma.draftFolder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw new Error("Folder not found.");
  return folder;
}

// ─── PLAN HOOK ──────────────────────────────────────────────────────────────
// Call right after a DraftPlan row is created, e.g.:
//   const plan = await prisma.draftPlan.create({ data: {...} });
//   await draftFolderService.createFolderForPlan(plan);

async function createFolderForPlan(plan) {
  return prisma.draftFolder.create({
    data: { userId: plan.userId, draftPlanId: plan.id },
  });
}

// ─── GENERAL FOLDER — created once, at signup ──────────────────────────────

// Call from authController.js signup, right after the user row is created:
//   const user = await userService.createUser({...});
//   await draftFolderService.createDefaultGeneralFolder(user.id);
async function createDefaultGeneralFolder(userId) {
  return prisma.draftFolder.create({
    data: { userId, name: DEFAULT_GENERAL_FOLDER_NAME },
  });
}

// Fallback for accounts that predate the signup hook (backfill script) or
// any other edge case where a draft would otherwise have nowhere to go.
// Finds-or-creates, never duplicates — safe to call from anywhere.
async function getOrCreateDefaultGeneralFolder(userId) {
  const existing = await prisma.draftFolder.findFirst({
    where: { userId, draftPlanId: null },
    orderBy: { createdAt: "asc" }, // the original one, if more than one somehow exists
  });
  if (existing) return existing;
  return createDefaultGeneralFolder(userId);
}

// ─── LIST ───────────────────────────────────────────────────────────────────

async function getMyFolders(userId) {
  const folders = await prisma.draftFolder.findMany({
    where: { userId },
    include: {
      _count: { select: { drafts: true } },
      draftPlan: {
        select: {
          storyTitle: true,
          goalType: true,
          targetLength: true,
          wordsWrittenSoFar: true,
          isCompleted: true,
          progressLogs: { select: { countLogged: true } },
        },
      },
    },
  });

  // Plan folders first (most people's real "projects"), each group then
  // by most recently touched — sorted in JS rather than the DB query so we
  // don't have to reason about how a given database orders NULLs on a
  // DESC/ASC nullable foreign key.
  return folders
    .slice()
    .sort((a, b) => {
      const aPlan = a.draftPlanId !== null;
      const bPlan = b.draftPlanId !== null;
      if (aPlan !== bPlan) return aPlan ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    })
    .map(shapeFolder);
}

// Lightweight — id + display name only, for a "pick a folder" dropdown when
// starting a new draft file.
async function getMyFolderOptions(userId) {
  const folders = await prisma.draftFolder.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      draftPlanId: true,
      draftPlan: { select: { storyTitle: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return folders.map((f) => ({
    id: f.id,
    isPlanFolder: f.draftPlanId !== null,
    name: f.draftPlanId ? f.draftPlan.storyTitle : f.name,
  }));
}

// Folder detail + its draft files — the "open a folder" screen. For a plan
// folder this is also everything the "Overview" button needs (draftPlanId
// to link to /draftplan/:id, percentDrafted for the header).
async function getFolderWithDrafts(folderId, userId) {
  const folder = await prisma.draftFolder.findFirst({
    where: { id: folderId, userId },
    include: {
      draftPlan: {
        select: {
          id: true,
          storyTitle: true,
          goalType: true,
          targetLength: true,
          wordsWrittenSoFar: true,
          isCompleted: true,
          progressLogs: { select: { countLogged: true } },
        },
      },
      drafts: {
        orderBy: [{ isStarred: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          title: true,
          wordCount: true,
          isStarred: true,
          createdAt: true,
          updatedAt: true,
          // Most recent completed sprint written in this file, if any —
          // just the one row needed for "last sprint" on the drafts page.
          sprints: {
            where: { isActive: false },
            orderBy: { completedAt: "desc" },
            take: 1,
            select: { duration: true },
          },
        },
      },
    },
  });
  if (!folder) throw new Error("Folder not found.");

  const isPlanFolder = folder.draftPlanId !== null;

  return {
    id: folder.id,
    isPlanFolder,
    name: isPlanFolder ? folder.draftPlan.storyTitle : folder.name,
    draftPlanId: isPlanFolder ? folder.draftPlan.id : null,
    goalType: isPlanFolder ? folder.draftPlan.goalType : null,
    percentDrafted: isPlanFolder ? computePercentDrafted(folder.draftPlan) : null,
    planCompleted: isPlanFolder ? folder.draftPlan.isCompleted : null,
    draftCount: folder.drafts.length,
    drafts: folder.drafts.map(({ sprints, ...draft }) => ({
      ...draft,
      // .duration is the sprint's set length in minutes, not necessarily
      // exact time spent (a writer can end early) — the closest thing to
      // "time spent" the data model tracks today.
      lastSprintMinutes: sprints[0]?.duration ?? null,
    })),
  };
}

// ─── RENAME GENERAL FOLDER ──────────────────────────────────────────────────
// The only folder-editing action writers get directly. Plan folders are
// excluded — they're managed entirely through the plan's own lifecycle and
// always mirror the plan's storyTitle.

async function renameGeneralFolder(folderId, userId, name) {
  const folder = await assertOwnsFolder(folderId, userId);
  if (folder.draftPlanId !== null) {
    throw new Error("This folder belongs to a draft plan — rename the story itself to rename it.");
  }
  const clean = (name || "").trim().slice(0, MAX_FOLDER_NAME_LENGTH);
  if (!clean) throw new Error("Give the folder a name.");
  return prisma.draftFolder.update({ where: { id: folderId }, data: { name: clean } });
}

module.exports = {
  createFolderForPlan,
  createDefaultGeneralFolder,
  getOrCreateDefaultGeneralFolder,
  getMyFolders,
  getMyFolderOptions,
  getFolderWithDrafts,
  renameGeneralFolder,
  assertOwnsFolder,
};