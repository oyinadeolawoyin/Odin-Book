// prisma/seeds/bonusQuestPrompts.js
//
// Seed content for the BonusQuestPrompt table. This is the file to edit
// when you want to add, reorder, or tweak Bonus Quest prompts — nothing
// about the quest content lives in draftPlanService.js anymore.
//
// orderIndex is 1-based and defines DELIVERY ORDER within its questType —
// see DraftBonusQuestProgress in schema.prisma. A writer who lands on
// PROMPT_WRITE gets orderIndex 1 the first time, 2 the next time they land
// on PROMPT_WRITE, and so on — never random, never repeated — wrapping back
// to 1 once they've been through all of them for that type.
//
// targetCount is per-prompt (not just per-type) on purpose, so you can make
// an individual prompt lighter or heavier later without touching code —
// e.g. a two-character dialogue scene might reasonably ask for fewer words
// than a full sandbox scene.
//
// To add an 11th prompt to a type: append it with orderIndex 11. To remove
// one: delete it — openBonusQuest() falls back to orderIndex 1 for any plan
// whose cursor was sitting on a since-deleted index, so this is safe to do
// without a migration for existing writers' progress.

module.exports = [
  // ── PROMPT_WRITE — write ~400 words from a given prompt ───────────────────
  { questType: "PROMPT_WRITE", orderIndex: 1,  targetCount: 400, prompt: "A character finds a door in their house that wasn't there yesterday." },
  { questType: "PROMPT_WRITE", orderIndex: 2,  targetCount: 400, prompt: "Someone is handed a letter addressed to them, postmarked fifty years ago." },
  { questType: "PROMPT_WRITE", orderIndex: 3,  targetCount: 400, prompt: "Two strangers are the only ones who show up to a scheduled meeting." },
  { questType: "PROMPT_WRITE", orderIndex: 4,  targetCount: 400, prompt: "A character overhears a conversation they were never meant to hear." },
  { questType: "PROMPT_WRITE", orderIndex: 5,  targetCount: 400, prompt: "The last light in town goes out, except for one window." },
  { questType: "PROMPT_WRITE", orderIndex: 6,  targetCount: 400, prompt: "Someone finds an object in their pocket that isn't theirs." },
  { questType: "PROMPT_WRITE", orderIndex: 7,  targetCount: 400, prompt: "A character has to explain a scar they don't remember getting." },
  { questType: "PROMPT_WRITE", orderIndex: 8,  targetCount: 400, prompt: "It's the same day again, but one small thing is different." },
  { questType: "PROMPT_WRITE", orderIndex: 9,  targetCount: 400, prompt: "A character receives a package they never ordered." },
  { questType: "PROMPT_WRITE", orderIndex: 10, targetCount: 400, prompt: "Someone realizes they've been telling the same story wrong for years." },

  // ── SANDBOX_SCENE — draft a quick scene that doesn't need to fit the story ─
  { questType: "SANDBOX_SCENE", orderIndex: 1,  targetCount: 300, prompt: "Write a scene that happens entirely in an elevator." },
  { questType: "SANDBOX_SCENE", orderIndex: 2,  targetCount: 300, prompt: "Write a scene using only dialogue — no narration at all." },
  { questType: "SANDBOX_SCENE", orderIndex: 3,  targetCount: 300, prompt: "Write a scene where two characters want opposite things from the same conversation." },
  { questType: "SANDBOX_SCENE", orderIndex: 4,  targetCount: 300, prompt: "Write a scene set in the last place your character wants to be." },
  { questType: "SANDBOX_SCENE", orderIndex: 5,  targetCount: 300, prompt: "Write a scene that starts mid-argument, no setup." },
  { questType: "SANDBOX_SCENE", orderIndex: 6,  targetCount: 300, prompt: "Write a scene where nothing is said out loud, just gestures and glances." },
  { questType: "SANDBOX_SCENE", orderIndex: 7,  targetCount: 300, prompt: "Write a scene set five minutes before your story actually begins." },
  { questType: "SANDBOX_SCENE", orderIndex: 8,  targetCount: 300, prompt: "Write a scene from a minor character's point of view, just this once." },
  { questType: "SANDBOX_SCENE", orderIndex: 9,  targetCount: 300, prompt: "Write a scene where a character is lying and the reader can tell." },
  { questType: "SANDBOX_SCENE", orderIndex: 10, targetCount: 300, prompt: "Write a scene set during a storm, real or metaphorical." },

  // ── FUN_FACT — share something short, fun, and personal ───────────────────
  { questType: "FUN_FACT", orderIndex: 1,  targetCount: 100, prompt: "Share a fun fact about your morning routine." },
  { questType: "FUN_FACT", orderIndex: 2,  targetCount: 100, prompt: "Share a fun fact about a habit you have while writing." },
  { questType: "FUN_FACT", orderIndex: 3,  targetCount: 100, prompt: "Share a fun fact about the first story you ever tried to write." },
  { questType: "FUN_FACT", orderIndex: 4,  targetCount: 100, prompt: "Share a fun fact about a book or show that shaped how you write." },
  { questType: "FUN_FACT", orderIndex: 5,  targetCount: 100, prompt: "Share a fun fact about your favorite writing snack or drink." },
  { questType: "FUN_FACT", orderIndex: 6,  targetCount: 100, prompt: "Share a fun fact about where you like to write." },
  { questType: "FUN_FACT", orderIndex: 7,  targetCount: 100, prompt: "Share a fun fact about a character you can't stop thinking about." },
  { questType: "FUN_FACT", orderIndex: 8,  targetCount: 100, prompt: "Share a fun fact about how you picked your story's title." },
  { questType: "FUN_FACT", orderIndex: 9,  targetCount: 100, prompt: "Share a fun fact about a word you love saying out loud." },
  { questType: "FUN_FACT", orderIndex: 10, targetCount: 100, prompt: "Share a fun fact about a place you'd love to set a story in." },
];