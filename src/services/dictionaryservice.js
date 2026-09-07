// src/services/dictionaryService.js
const prisma = require("../config/prismaClient");

// ─── ADD ──────────────────────────────────────────────────────────────────────

async function addEntry(userId, { word, meaning }) {
  const cleanWord    = word?.trim();
  const cleanMeaning = meaning?.trim();

  if (!cleanWord)    throw new Error("Word is required");
  if (!cleanMeaning) throw new Error("Meaning is required");
  if (cleanWord.length > 100)     throw new Error("Word must be 100 characters or fewer");
  if (cleanMeaning.length > 2000) throw new Error("Meaning must be 2,000 characters or fewer");

  // Case-insensitive duplicate check — "Elf" and "elf" are the same entry
  // to a writer, even though the DB unique constraint below is case-sensitive.
  const existing = await prisma.dictionaryEntry.findFirst({
    where: {
      userId,
      word: { equals: cleanWord, mode: "insensitive" },
    },
  });
  if (existing) throw new Error(`"${cleanWord}" is already in your dictionary`);

  try {
    return await prisma.dictionaryEntry.create({
      data: { userId, word: cleanWord, meaning: cleanMeaning },
    });
  } catch (err) {
    if (err.code === "P2002") {
      throw new Error(`"${cleanWord}" is already in your dictionary`);
    }
    throw err;
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function deleteEntry(userId, entryId) {
  const entry = await prisma.dictionaryEntry.findFirst({
    where: { id: entryId, userId },
  });
  if (!entry) throw new Error("Dictionary entry not found");

  await prisma.dictionaryEntry.delete({ where: { id: entryId } });
  return { deleted: true };
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
// Returns the writer's whole dictionary, alphabetical by word. Optional
// `search` filters to words starting with the given text (case-insensitive) —
// handy once the list gets long.

async function getDictionary(userId, { search } = {}) {
  const where = {
    userId,
    ...(search?.trim() && {
      word: { startsWith: search.trim(), mode: "insensitive" },
    }),
  };

  return prisma.dictionaryEntry.findMany({
    where,
    orderBy: { word: "asc" },
  });
}

module.exports = {
  addEntry,
  deleteEntry,
  getDictionary,
};