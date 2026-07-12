// src/services/profileService.js
//
// Aggregates all public profile data in a single Prisma query fan-out.
// Used by GET /api/profile/:userId
//
// What's returned:
//   - user (public fields: id, username, bio, avatar, role, createdAt, socialLinks)
//   - submissionCount + submissions (up to 10 latest, public)
//   - critiquesGiven count + recent critique items (public)
//   - reputationTier (public — Bronze / Silver / Gold / Platinum / Diamond)
//   - threads posted (up to 10 latest, public)
//   - threadsCommentedOn (up to 10 latest distinct threads the user commented in)
//   - threadCommentCount (public)
//   - draftPlan (story title, premise, characters — visible to all)
//   - daysChallenge (active only — title, duration, startDate, status, focuses)
//   - sprintCount (total Sprint rows for this user — covers solo-started AND
//     group-joined sprints, since joining a group sprint also creates a
//     Sprint row for the joiner)
//   - draftCount (total WritingDraft rows for this user)
//
// Owner-only fields are fetched separately via their own authenticated routes
// (posting balance, blocked users, full plan details).

const prisma = require("../config/prismaClient");

// Mirror of the tier table in pointService — kept local so profileService has
// no hard dependency on pointService.
const TIERS = [
  { name: "Bronze",   min: 0,    max: 99,       gem: "B", color: "#C87533" },
  { name: "Silver",   min: 100,  max: 299,      gem: "S", color: "#9EA3A8" },
  { name: "Gold",     min: 300,  max: 699,      gem: "G", color: "#D4A017" },
  { name: "Platinum", min: 700,  max: 1499,     gem: "P", color: "#7F77DD" },
  { name: "Diamond",  min: 1500, max: Infinity,  gem: "D", color: "#D85A30" },
];

function getTier(reputation) {
  return TIERS.find((t) => reputation >= t.min && reputation <= t.max) ?? TIERS[0];
}

async function getPublicProfile(targetUserId) {
  const userId = Number(targetUserId);

  const [
    user,
    submissions,
    critiqueCount,
    recentCritiques,
    wallet,
    threads,
    commentedThreadRows,
    threadCommentCount,
    draftPlan,
    daysChallenge,
    sprintCount,
    draftCount,
  ] = await Promise.all([
    // ── User ──────────────────────────────────────────────────────────────────
    prisma.user.findUnique({
      where:  { id: userId, isDeleted: false },
      select: {
        id: true, username: true, bio: true, avatar: true,
        role: true, createdAt: true, socialLinks: true,
      },
    }),

    // ── Submissions (chapters posted, public) ─────────────────────────────────
    prisma.feedbackSubmission.findMany({
      where:   { userId, isDraft: false },
      orderBy: { createdAt: "desc" },
      take:    10,
      select:  {
        id: true, title: true, genre: true, status: true,
        critiqueCount: true, wordCountTier: true, createdAt: true,
      },
    }),

    // ── Total critiques given ─────────────────────────────────────────────────
    prisma.feedbackResponse.count({ where: { criticId: userId } }),

    // ── Recent critiques given (for the card list) ────────────────────────────
    prisma.feedbackResponse.findMany({
      where:   { criticId: userId },
      orderBy: { createdAt: "desc" },
      take:    5,
      select:  {
        id: true, pointsEarned: true, createdAt: true,
        submission: { select: { id: true, title: true } },
      },
    }),

    // ── Wallet — reputation only (posting balance stays private) ──────────────
    prisma.feedbackPoint.findUnique({
      where:  { userId },
      select: { reputation: true },
    }),

    // ── Threads posted ────────────────────────────────────────────────────────
    prisma.thread.findMany({
      where:   { authorId: userId },
      orderBy: { createdAt: "desc" },
      take:    10,
      select:  {
        id: true, title: true, createdAt: true,
        category: { select: { id: true, name: true } },
        _count:   { select: { comments: true, likes: true } },
      },
    }),

    // ── Threads the user commented on (distinct, most recent comment first) ───
    // We grab the user's most recent comments, then pull the distinct threads.
    prisma.threadComment.findMany({
      where:    { authorId: userId },
      orderBy:  { createdAt: "desc" },
      take:     50, // over-fetch so we get 10 distinct threads after dedup
      distinct: ["threadId"],
      select:   {
        createdAt: true,
        thread: {
          select: {
            id: true, title: true, createdAt: true,
            author:   { select: { id: true, username: true } },
            category: { select: { id: true, name: true } },
            _count:   { select: { comments: true, likes: true } },
          },
        },
      },
    }),

    // ── Thread comment count (total comments left by this user) ───────────────
    prisma.threadComment.count({ where: { authorId: userId } }),

    // ── Draft plan (public — story identity fields only) ──────────────────────
    prisma.draftPlan.findUnique({
      where:  { userId },
      select: {
        id: true, storyTitle: true, premise: true, isCompleted: true,
        characters: { select: { id: true, name: true, description: true } },
      },
    }),

    // ── Active days challenge (if any) ────────────────────────────────────────
    prisma.daysChallenge.findUnique({
      where:  { userId },
      select: {
        id: true, duration: true, status: true,
        startDate: true, endDate: true,
        storyTitle: true, workingGoal: true,
        goalType: true, dailyGoal: true,
        focuses: { select: { focus: true } },
      },
    }),

    // ── Sprint count (covers both starting a solo sprint and joining a group
    //    sprint — both create a Sprint row for the user) — powers the
    //    "Start your first sprint" checklist item ──────────────────────────
    prisma.sprint.count({ where: { userId } }),

    // ── Writing draft count — powers the "Create your first draft" checklist
    //    item ──────────────────────────────────────────────────────────────
    prisma.writingDraft.count({ where: { userId } }),
  ]);

  if (!user) throw new Error("User not found");

  // Deduplicate and cap at 10 threads commented on, excluding threads the user
  // also authored (those appear in "threads posted" already).
  const postedIds = new Set(threads.map((t) => t.id));
  const threadsCommentedOn = commentedThreadRows
    .map((row) => ({ ...row.thread, lastCommentAt: row.createdAt }))
    .filter((t) => !postedIds.has(t.id))
    .slice(0, 10);

  // Build reputation tier (public)
  const reputation = wallet?.reputation ?? 0;
  const reputationTier = getTier(reputation);

  return {
    user,
    submissions,
    submissionCount: submissions.length,
    critiquesGiven:  critiqueCount,
    recentCritiques,
    reputation,
    reputationTier,
    threads,
    threadsCommentedOn,
    threadCommentCount,
    draftPlan:    draftPlan  ?? null,
    daysChallenge: (daysChallenge?.status === "ACTIVE") ? daysChallenge : null,
    sprintCount,
    draftCount,
  };
}

module.exports = { getPublicProfile };