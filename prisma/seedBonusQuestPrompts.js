// prisma/seeds/seedBonusQuestPrompts.js
//
// Run with: node prisma/seeds/seedBonusQuestPrompts.js
// (adjust the require path below if your prisma client lives elsewhere)
//
// Upserts on the [questType, orderIndex] unique constraint, so this is safe
// to re-run any time bonusQuestPrompts.js changes — editing prompt #4's
// wording and re-running won't create a duplicate, it just updates that row
// in place. Existing writers' DraftBonusQuestProgress cursors are untouched
// either way, since those only ever store an orderIndex, not a prompt id.

const prisma = require("../src/config/prismaClient");
const prompts = require("./bonusQuestPrompts");

async function seedBonusQuestPrompts() {
  let created = 0;
  let updated = 0;

  for (const p of prompts) {
    const existing = await prisma.bonusQuestPrompt.findUnique({
      where: { questType_orderIndex: { questType: p.questType, orderIndex: p.orderIndex } },
    });

    await prisma.bonusQuestPrompt.upsert({
      where: { questType_orderIndex: { questType: p.questType, orderIndex: p.orderIndex } },
      create: {
        questType:   p.questType,
        orderIndex:  p.orderIndex,
        prompt:      p.prompt,
        targetCount: p.targetCount,
      },
      update: {
        prompt:      p.prompt,
        targetCount: p.targetCount,
      },
    });

    existing ? updated++ : created++;
  }

  console.log(`Bonus Quest prompts seeded: ${created} created, ${updated} updated (${prompts.length} total).`);
}

seedBonusQuestPrompts()
  .catch((err) => {
    console.error("Bonus Quest prompt seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());