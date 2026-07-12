// src/services/pointService.js
const prisma = require("../config/prismaClient");

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BOOTSTRAP_FREE_SLOTS = 3;   // first 3 unique users to post get a free pass
const NEW_MEMBER_SEED      = 2;   // posting pts every new member starts with

// Full tier points per word-count bracket.
// SPOTLIGHT  → full points
// QUEUE      → full points - 2
// ARCHIVE    → half of full points
const TIER_COSTS = {
  TIER_1000: 10,   // ≤1000 words
  TIER_2000: 20,   // ≤2000 words
  TIER_3000: 30,   // ≤3000 words
  TIER_4000: 40,   // ≤4000 words
  TIER_5000: 50,   // ≤5000 words
};

// Multi-chapter surcharge: each active chapter (QUEUE or SPOTLIGHT) already
// held by the writer adds +2 to the cost of posting another.
const MULTI_CHAPTER_SURCHARGE = 2;

// QUEUE penalty: critiquing a QUEUE work earns 2 fewer points than full tier cost
const QUEUE_CRITIQUE_PENALTY = 2;

// Reputation points awarded (and deducted on un-upvote) per critique upvote
const UPVOTE_REPUTATION_AWARD = 2;

// Reputation tiers
const TIERS = [
  { name: "Bronze",   min: 0,    max: 99,       gem: "B", color: "#C87533" },
  { name: "Silver",   min: 100,  max: 299,      gem: "S", color: "#9EA3A8" },
  { name: "Gold",     min: 300,  max: 699,      gem: "G", color: "#D4A017" },
  { name: "Platinum", min: 700,  max: 1499,     gem: "P", color: "#7F77DD" },
  { name: "Diamond",  min: 1500, max: Infinity,  gem: "D", color: "#D85A30" },
];

/**
 * Calculate points a critic earns for a critique.
 *
 * Status rules:
 *   SPOTLIGHT → full tier points
 *   QUEUE     → full tier points - QUEUE_CRITIQUE_PENALTY (2)
 *   ARCHIVE   → half of full tier points
 *
 * @param {string}   wordCountTier    - Submission's word-count tier (TIER_1000, etc.)
 * @param {string}   submissionStatus - "QUEUE" | "SPOTLIGHT" | "ARCHIVE"
 *
 * Returns: { basePoints, totalPoints, isSpotlight }
 */
function calculateCritiquePoints(wordCountTier, submissionStatus) {
  const full = TIER_COSTS[wordCountTier] || 1;

  let base;
  if (submissionStatus === "ARCHIVE") {
    base = Math.floor(full / 2);
  } else if (submissionStatus === "QUEUE") {
    base = Math.max(0, full - QUEUE_CRITIQUE_PENALTY);
  } else {
    // SPOTLIGHT
    base = full;
  }

  const isSpotlight = submissionStatus === "SPOTLIGHT";

  return { basePoints: base, totalPoints: base, isSpotlight };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getTier(reputation) {
  return TIERS.find((t) => reputation >= t.min && reputation <= t.max) ?? TIERS[0];
}

function getTierCost(wordCountTier) {
  const cost = TIER_COSTS[wordCountTier];
  if (!cost) throw new Error(`Unknown word count tier: ${wordCountTier}`);
  return cost;
}

/**
 * Calculate the full posting cost for a writer, including the multi-chapter surcharge.
 * activeChapters = number of submissions the writer currently has in QUEUE or SPOTLIGHT.
 * Formula: tierCost + (activeChapters × MULTI_CHAPTER_SURCHARGE)
 *
 * @param {string} wordCountTier
 * @param {number} activeChapters  — count of writer's current QUEUE + SPOTLIGHT submissions
 * @returns {{ tierCost, surcharge, totalCost }}
 */
function calculatePostingCost(wordCountTier, activeChapters = 0) {
  const tierCost  = getTierCost(wordCountTier);
  const surcharge = activeChapters * MULTI_CHAPTER_SURCHARGE;
  return { tierCost, surcharge, totalCost: tierCost + surcharge };
}

// Returns the new tier name if reputation crossed a tier boundary, else null.
function detectTierChange(oldReputation, newReputation) {
  const oldTier = getTier(oldReputation);
  const newTier = getTier(newReputation);
  return oldTier.name !== newTier.name ? newTier : null;
}

// ─── WALLET INIT ─────────────────────────────────────────────────────────────

async function initWallet(userId) {
  return prisma.feedbackPoint.upsert({
    where:  { userId },
    update: {},
    // reputation starts at 0 — only upvotes build reputation, not seed pts
    create: { userId, postingBalance: NEW_MEMBER_SEED, reputation: 0 },
  });
}

// ─── GET WALLET ──────────────────────────────────────────────────────────────

async function getWallet(userId) {
  let wallet = await prisma.feedbackPoint.findUnique({ where: { userId } });
  if (!wallet) wallet = await initWallet(userId);

  // Check if this user can still claim a free post.
  let freePostAvailable = false;
  if (!wallet.usedFreePost) {
    const bootstrap = await prisma.feedbackHubBootstrap.findUnique({ where: { id: 1 } });
    const posterCount = bootstrap?.posterCount ?? 0;
    freePostAvailable = posterCount < BOOTSTRAP_FREE_SLOTS;
  }

  // Count writer's active chapters (QUEUE or SPOTLIGHT) so the frontend
  // can show the real posting cost before they click "Post".
  const activeChapterCount = await prisma.feedbackSubmission.count({
    where: { userId, status: { in: ["QUEUE", "SPOTLIGHT"] } },
  });

  return {
    ...wallet,
    tier: getTier(wallet.reputation),
    TIER_COSTS,
    MULTI_CHAPTER_SURCHARGE,
    activeChapterCount,
    freePostAvailable,
  };
}

// ─── BOOTSTRAP CHECK ─────────────────────────────────────────────────────────
// Returns true if this user qualifies for a free first post.
// Conditions:
//   1. The global bootstrap counter is still under BOOTSTRAP_FREE_SLOTS (3)
//   2. This specific user has never used their free post

async function checkAndClaimFreePost(userId, tx = prisma) {
  let bootstrap = await tx.feedbackHubBootstrap.findUnique({ where: { id: 1 } });
  if (!bootstrap) {
    bootstrap = await tx.feedbackHubBootstrap.create({ data: { id: 1, posterCount: 0 } });
  }

  if (bootstrap.posterCount >= BOOTSTRAP_FREE_SLOTS) return false;

  const wallet = await tx.feedbackPoint.findUnique({ where: { userId } });
  if (!wallet || wallet.usedFreePost) return false;

  await tx.feedbackHubBootstrap.update({
    where: { id: 1 },
    data:  { posterCount: { increment: 1 } },
  });
  await tx.feedbackPoint.update({
    where: { userId },
    data:  { usedFreePost: true },
  });

  return true;
}

// ─── DEDUCT POSTING COST ─────────────────────────────────────────────────────

/**
 * Deduct the full posting cost (tier cost + multi-chapter surcharge) from the writer's wallet.
 * The caller must pass the pre-calculated totalCost from calculatePostingCost().
 *
 * @param {number} userId
 * @param {number} totalCost   — result of calculatePostingCost().totalCost
 * @param {object} tx          — prisma transaction client
 */
async function deductPostingCost(userId, totalCost, tx = prisma) {
  const wallet = await tx.feedbackPoint.findUnique({ where: { userId } });
  if (!wallet) throw new Error("Wallet not found. User may not be initialised.");
  if (wallet.postingBalance < totalCost) {
    throw new Error(
      `Not enough points. You need ${totalCost} pts to post but only have ${wallet.postingBalance}.`
    );
  }
  return tx.feedbackPoint.update({
    where: { userId },
    data:  { postingBalance: { decrement: totalCost } },
  });
}

// ─── AWARD CRITIQUE POINTS ───────────────────────────────────────────────────

// Updated to take the actual points calculated above
async function awardCritiquePoints(criticId, pointsToAward, tx = prisma) {
  return tx.feedbackPoint.upsert({
    where:  { userId: criticId },
    update: {
      postingBalance: { increment: pointsToAward },
    },
    create: {
      userId:         criticId,
      postingBalance: NEW_MEMBER_SEED + pointsToAward,
      reputation:     0,
    },
  });
}

// (Extra-word bonus removed — critiques earn a flat amount based on submission status only.)

// Note: Upvote point rewards have been removed from the system.
// Upvotes on critiques and paragraph comments are purely social signals now.

module.exports = {
  TIER_COSTS,
  MULTI_CHAPTER_SURCHARGE,
  QUEUE_CRITIQUE_PENALTY,
  BOOTSTRAP_FREE_SLOTS,
  TIERS,
  UPVOTE_REPUTATION_AWARD,
  calculateCritiquePoints,
  calculatePostingCost,
  getTier,
  getTierCost,
  detectTierChange,
  initWallet,
  getWallet,
  checkAndClaimFreePost,
  deductPostingCost,
  awardCritiquePoints,
};