// src/services/followService.js
//
// NOTE: if a follow/social service already exists elsewhere in the
// codebase (for the follow/unfollow button, follower counts, etc.), move
// getFollowerContacts into that file instead of keeping this as a
// separate one — this was written standalone because I didn't have
// visibility into whether one already exists.

const prisma = require("../config/prismaClient");

// Contact info for everyone following a given user — used to fan out
// "someone you follow just did X" notifications (draft plan progress,
// draft completed, sprint started, etc). Both draftPlanController and
// sprintController need this exact same lookup, so it lives here instead
// of being duplicated in each.
async function getFollowerContacts(userId) {
  const rows = await prisma.follow.findMany({
    where: { followingId: userId },
    select: {
      follower: { select: { id: true, username: true, email: true, avatar: true } },
    },
  });

  return rows.map((r) => r.follower);
}

module.exports = {
  getFollowerContacts,
};