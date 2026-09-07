// src/services/profileService.js
//
// Public profile bundle + the follow/like graph between writers.
//
// GET /api/profile/:userId returns:
//   - user (public fields: id, username, bio, avatar, role, createdAt,
//     socialLinks, country, genre, funFact, favoriteSprintTime,
//     favoriteSprintDays)
//   - followerCount / followingCount / isFollowing (isFollowing only means
//     anything when a viewerId is passed in — i.e. someone is logged in)
//   - likeCount / isLiked (same deal — needs a viewerId)
//   - currentStreak / longestStreak, via writingActivityService.getStreaks()
//     — timezone-aware, same helper the rest of the app uses
//   - cardsSentCount (Mailbox cards this writer has sent)
//   - draftPlans (every current plan, with a title + % complete)
//
// Everything else that used to live here (submissions, critiques, threads,
// reputation, days challenge, sprint/draft totals) has been stripped out for
// now — bring any of it back the same way if it's needed again later.

const prisma = require("../config/prismaClient");
const writingActivityService = require("./writingactivityservice");

async function getPublicProfile(targetUserId, viewerId) {
  const userId = Number(targetUserId);

  const [
    user,
    followerCount,
    followingCount,
    followRow,
    likeCount,
    likeRow,
    cardsSentCount,
    draftPlansRaw,
  ] = await Promise.all([
    // ── User (public fields) ────────────────────────────────────────────────
    prisma.user.findUnique({
      where:  { id: userId, isDeleted: false },
      select: {
        id: true, username: true, bio: true, avatar: true,
        role: true, createdAt: true, socialLinks: true,
        country: true, genre: true, funFact: true,
        favoriteSprintTime: true, favoriteSprintDays: true,
        allowAskMeAnything: true,
        timezone: true, // needed to compute this writer's streak correctly below
      },
    }),

    // ── Follow counts ────────────────────────────────────────────────────────
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.follow.count({ where: { followerId: userId } }),

    // ── Is the viewer following this profile? ──────────────────────────────
    viewerId
      ? prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: userId } },
        })
      : null,

    // ── Like count ────────────────────────────────────────────────────────
    prisma.profileLike.count({ where: { likedUserId: userId } }),

    // ── Has the viewer liked this profile? ─────────────────────────────────
    viewerId
      ? prisma.profileLike.findUnique({
          where: { likerId_likedUserId: { likerId: viewerId, likedUserId: userId } },
        })
      : null,

    // ── Mailbox cards sent ────────────────────────────────────────────────
    prisma.mailboxCard.count({ where: { senderId: userId } }),

    // ── Draft plans (current, with enough to compute % complete) ───────────
    prisma.draftPlan.findMany({
      where:   { userId },
      orderBy: { updatedAt: "desc" },
      select:  {
        id: true, storyTitle: true, goalType: true,
        targetLength: true, wordsWrittenSoFar: true, isCompleted: true,
        progressLogs: {
          orderBy: { logDate: "desc" },
          take:    1,
          select:  { totalSoFar: true },
        },
      },
    }),
  ]);

  if (!user) throw new Error("User not found");

  // Timezone-aware streaks, from the same helper the rest of the app uses
  // (workspaceService, etc.) — see writingActivityService.getStreaks.
  const { currentStreak, longestStreak } = await writingActivityService.getStreaks(
    userId,
    user.timezone ?? "UTC"
  );

  // timezone was only selected to feed getStreaks above — not part of the
  // public profile payload.
  const { timezone, ...publicUser } = user;

  const draftPlans = draftPlansRaw.map((plan) => {
    const current = plan.progressLogs[0]?.totalSoFar ?? plan.wordsWrittenSoFar;
    const percentage = plan.targetLength > 0
      ? Math.min(100, Math.round((current / plan.targetLength) * 100))
      : 0;

    return {
      id:          plan.id,
      storyTitle:  plan.storyTitle,
      goalType:    plan.goalType,
      current,
      target:      plan.targetLength,
      percentage,
      isCompleted: plan.isCompleted,
    };
  });

  return {
    user: publicUser,
    followerCount,
    followingCount,
    isFollowing: !!followRow,
    likeCount,
    isLiked: !!likeRow,
    currentStreak,
    longestStreak,
    cardsSentCount,
    draftPlans,
  };
}

// ── Follow graph ─────────────────────────────────────────────────────────────

async function followUser(followerId, followingId) {
  if (followerId === followingId) {
    throw new Error("You can't follow yourself.");
  }

  return prisma.follow.upsert({
    where:  { followerId_followingId: { followerId, followingId } },
    update: {},
    create: { followerId, followingId },
  });
}

async function unfollowUser(followerId, followingId) {
  await prisma.follow.deleteMany({ where: { followerId, followingId } });
}

async function getFollowers(userId, { limit = 20, cursor } = {}) {
  const rows = await prisma.follow.findMany({
    where:   { followingId: userId },
    orderBy: { createdAt: "desc" },
    take:    limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select:  {
      id: true, createdAt: true,
      follower: { select: { id: true, username: true, avatar: true, bio: true } },
    },
  });

  return rows.map((r) => ({ ...r.follower, followedAt: r.createdAt, followRowId: r.id }));
}

async function getFollowing(userId, { limit = 20, cursor } = {}) {
  const rows = await prisma.follow.findMany({
    where:   { followerId: userId },
    orderBy: { createdAt: "desc" },
    take:    limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select:  {
      id: true, createdAt: true,
      following: { select: { id: true, username: true, avatar: true, bio: true } },
    },
  });

  return rows.map((r) => ({ ...r.following, followedAt: r.createdAt, followRowId: r.id }));
}

// ── Profile likes ────────────────────────────────────────────────────────────

async function likeProfile(likerId, likedUserId) {
  if (likerId === likedUserId) {
    throw new Error("You can't like your own profile.");
  }

  return prisma.profileLike.upsert({
    where:  { likerId_likedUserId: { likerId, likedUserId } },
    update: {},
    create: { likerId, likedUserId },
  });
}

async function unlikeProfile(likerId, likedUserId) {
  await prisma.profileLike.deleteMany({ where: { likerId, likedUserId } });
}

// ── Editing your own profile extras ──────────────────────────────────────────
// country / genre / funFact / favoriteSprintTime / favoriteSprintDays.
// Only touches fields that were actually passed in.

async function updateProfileExtras(userId, updates) {
  const data = {};

  if (updates.country !== undefined) data.country = updates.country;
  if (updates.genre !== undefined) data.genre = updates.genre;
  if (updates.funFact !== undefined) data.funFact = updates.funFact;
  if (updates.favoriteSprintTime !== undefined) data.favoriteSprintTime = updates.favoriteSprintTime;
  if (updates.favoriteSprintDays !== undefined) data.favoriteSprintDays = updates.favoriteSprintDays;
  if (updates.allowAskMeAnything !== undefined) data.allowAskMeAnything = !!updates.allowAskMeAnything;

  return prisma.user.update({
    where:  { id: userId },
    data,
    select: {
      id: true, country: true, genre: true, funFact: true,
      favoriteSprintTime: true, favoriteSprintDays: true,
      allowAskMeAnything: true,
    },
  });
}

module.exports = {
  getPublicProfile,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  likeProfile,
  unlikeProfile,
  updateProfileExtras,
};