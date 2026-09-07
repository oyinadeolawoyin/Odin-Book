// scripts/backfillDraftFolders.js
//
// One-time backfill for the WritingDraft → DraftFolder migration.
//
// WritingDraft.folderId is a required field in the final schema, but
// existing draft rows don't have one yet — so this has to run as the
// middle step of a two-phase deploy:
//
//   1. In schema.prisma, temporarily make it optional:
//        folderId  Int?
//      Run the migration:  npx prisma migrate dev --name add_draft_folder_optional
//
//   2. Run this script:    node scripts/backfillDraftFolders.js
//
//   3. Flip schema.prisma back to required:
//        folderId  Int
//      Run the second migration:  npx prisma migrate dev --name make_draft_folder_required
//      (This step will fail if any WritingDraft row still has a null
//      folderId — which means step 2 didn't finish cleanly. Re-run this
//      script and check its output before retrying.)
//
// What it does, per user (not just users with orphaned drafts — every
// user gets a General folder, matching the new signup behavior):
//   1. Ensures they have a General folder (creates one if they don't —
//      matches draftFolderService.getOrCreateDefaultGeneralFolder, but
//      done here directly so this script has no other dependencies).
//   2. Points every one of their WritingDraft rows that has no folderId
//      yet at that folder.
//   3. NEW — ensures every DraftPlan they already own has a matching
//      plan folder (draftPlanId set), mirroring
//      draftFolderService.createFolderForPlan. Plans created before the
//      folder system existed never got this automatically, so without
//      this step getMyFolders()/getFolderWithDrafts() would have nothing
//      to return for them.
//
// NOTE on scope: this step only ensures the plan folder itself exists —
// it does NOT move any drafts into it. WritingDraft has no draftPlanId
// of its own, so there's no reliable link left in the data to say "this
// orphaned draft belongs to that plan"; any draft with a null folderId
// still lands in General, same as before. If your pre-folder schema DID
// track a draft's plan some other way (a draftPlanId column that got
// dropped, a join table, chapters carrying the link, etc.), say so and
// I'll add a step that re-homes those specific drafts into the right
// plan folder instead of leaving them in General.
//
// Idempotent — safe to re-run if it's interrupted partway through.

const prisma = require("../src/config/prismaClient");

async function ensureGeneralFolder(userId) {
  const existing = await prisma.draftFolder.findFirst({
    where: { userId, draftPlanId: null },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return prisma.draftFolder.create({ data: { userId, name: "General" } });
}

// Mirrors draftFolderService.createFolderForPlan, but find-or-create so
// it's safe to re-run without double-creating a folder for a plan that
// already has one (from the app itself, or a previous partial run).
async function ensureFolderForPlan(plan) {
  const existing = await prisma.draftFolder.findFirst({ where: { draftPlanId: plan.id } });
  if (existing) return { folder: existing, created: false };
  const folder = await prisma.draftFolder.create({
    data: { userId: plan.userId, draftPlanId: plan.id },
  });
  return { folder, created: true };
}

async function run() {
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  console.log(`Backfilling draft folders for ${users.length} user(s)...`);

  let generalFoldersCreated = 0;
  let planFoldersCreated = 0;
  let draftsMoved = 0;

  for (const user of users) {
    // ── General folder ──────────────────────────────────────────────────
    const existingGeneralCount = await prisma.draftFolder.count({
      where: { userId: user.id, draftPlanId: null },
    });
    const generalFolder = await ensureGeneralFolder(user.id);
    if (existingGeneralCount === 0) generalFoldersCreated += 1;

    const result = await prisma.writingDraft.updateMany({
      where: { userId: user.id, folderId: null },
      data: { folderId: generalFolder.id },
    });
    if (result.count > 0) {
      draftsMoved += result.count;
      console.log(`  ${user.username}: moved ${result.count} draft(s) into "${generalFolder.name}"`);
    }

    // ── Plan folders ─────────────────────────────────────────────────────
    const plans = await prisma.draftPlan.findMany({
      where: { userId: user.id },
      select: { id: true, userId: true, storyTitle: true },
    });
    for (const plan of plans) {
      const { created } = await ensureFolderForPlan(plan);
      if (created) {
        planFoldersCreated += 1;
        console.log(`  ${user.username}: created plan folder for "${plan.storyTitle}"`);
      }
    }
  }

  console.log(
    `\nDone. ${generalFoldersCreated} General folder(s) created, ${planFoldersCreated} plan folder(s) created, ${draftsMoved} draft(s) backfilled into General.`
  );

  const stillOrphaned = await prisma.writingDraft.count({ where: { folderId: null } });
  if (stillOrphaned > 0) {
    console.warn(`\n⚠ ${stillOrphaned} draft(s) still have no folderId — do NOT run the "make required" migration yet.`);
  } else {
    console.log(`\nEvery draft now has a folder — safe to run the "make folderId required" migration.`);
  }

  await prisma.$disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  prisma.$disconnect().finally(() => process.exit(1));
});