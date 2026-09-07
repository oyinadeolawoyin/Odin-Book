const notificationsService = require("../services/notificationService");
const prisma = require("../config/prismaClient");
const sprintRoomService = require("../services/sprintroomservice");
const { sendEmail } = require("../config/mailer");
const { sendPushNotification } = notificationsService;

// ============================================
// NOTIFICATION OPERATIONS
// ============================================

/**
 * Save push notification subscription
 * Stores subscription data for sending push notifications to users
 * Used for Progressive Web App (PWA) push notifications
 * @route POST /notifications/subscribe
 */
async function saveSubscription(req, res) {
    try {
        const userId = req.user.id;
        const subscription = req.body;

        if (!subscription) {
            return res.status(400).json({ message: "No subscription provided" });
        }

        await notificationsService.saveSubscription(userId, subscription);
        res.status(201).json({ message: "Subscription saved successfully" });
    } catch (error) {
        console.error("Save subscription error:", error);
        res.status(500).json({ message: "Failed to save subscription" });
    }
}

/**
 * Fetch all notifications for the current user
 * Returns notifications sorted by most recent first
 * Includes both read and unread notifications
 * @route GET /notifications
 */
async function getNotifications(req, res) {
    try {
        const notifications = await notificationsService.fetchNotifications(req.user.id);
        res.status(200).json({ notifications });
    } catch (error) {
        console.error("Fetch notifications error:", error);
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
}

/**
 * Mark a notification as read
 * Updates the read status of a specific notification
 * Used when user views or clicks on a notification
 * @route PATCH /notifications/:id/read
 */
async function markRead(req, res) {
    try {
        const userId = Number(req.user.id);
        await notificationsService.markNotificationRead(userId);
        res.status(200).json({ message: "Notification marked as read" });
    } catch (error) {
        console.error("Mark notification as read error:", error);
        res.status(500).json({ message: "Failed to update notification" });
    }
}

/**
 * Get notification preferences for the current user
 * @route GET /notifications/preferences
 */
async function getPreferences(req, res) {
    try {
      const userId = req.user.id;
      const record = await notificationsService.fetchPreferences(userId);
      res.status(200).json({ preferences: record ? record.preferences : null });
    } catch (error) {
      console.error("Get notification preferences error:", error);
      res.status(500).json({ message: "Failed to fetch preferences" });
    }
}

/**
 * Save notification preferences for the current user
 * @route POST /notifications/preferences
 * Body: { preferences: { [notifKey]: { inbox: bool, push: bool, email: bool } } }
 */
async function savePreferences(req, res) {
    try {
      const userId = req.user.id;
      const { preferences } = req.body;

      if (!preferences || typeof preferences !== "object") {
        return res.status(400).json({ message: "preferences object is required" });
      }

      await notificationsService.savePreferences(userId, preferences);
      res.status(200).json({ message: "Preferences saved successfully" });
    } catch (error) {
      console.error("Save notification preferences error:", error);
      res.status(500).json({ message: "Failed to save preferences" });
    }
}

/**
 * GET /notifications/unread-counts
 *
 * Returns unread counts for the sidebar badges:
 *   {
 *     notifications: number,   // Notification rows where read = false
 *     messages: number,        // Conversations with a message newer than lastReadByA/B
 *     communityUpdates: number // BlogPosts newer than the user's lastSeenAt
 *     sprintRoom: number       // Unread @mentions/replies in the sprint room chat
 *   }
 *
 * sprintRoom is meant to be shown on the Sprint Room sidebar icon only while
 * the writer ISN'T currently in the room (they already see it live on the
 * Chat toggle in that case) — that display condition belongs in the sidebar
 * component, this endpoint just reports the raw count.
 *
 * Called by the sidebar on mount and whenever the window regains focus.
 */
async function getUnreadCounts(req, res) {
  try {
    const userId = Number(req.user.id);

    // ── 1. Unread notifications ───────────────────────────────────────────
    // Excludes MESSAGE / COMMUNITY_UPDATE / MAILBOX_CARD so this badge count
    // always matches what the bell page (fetchNotifications) actually
    // displays — those types have their own dedicated pages + badges below.
    const notificationCount = await prisma.notification.count({
      where: {
        userId,
        read: false,
        type: { notIn: ["MESSAGE", "COMMUNITY_UPDATE", "MAILBOX_CARD"] },
      },
    });

    // ── 2. Unread message conversations ──────────────────────────────────
    // A conversation is "unread" for this user if:
    //   - The latest non-deleted message was NOT sent by them, AND
    //   - That message's createdAt is newer than their lastReadByA/B cursor
    //
    // Strategy: fetch all conversations for this user, then count the ones
    // where the latest message beats their read cursor.
    const conversations = await prisma.directConversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: {
        userAId:     true,
        userBId:     true,
        lastReadByA: true,
        lastReadByB: true,
        messages: {
          where:   { deletedAt: null },
          orderBy: { createdAt: "desc" },
          take:    1,
          select:  { senderId: true, createdAt: true },
        },
      },
    });

    let messageCount = 0;
    for (const conv of conversations) {
      const latest = conv.messages[0];
      if (!latest) continue;
      // Skip messages the user sent themselves
      if (latest.senderId === userId) continue;

      const isUserA    = conv.userAId === userId;
      const myLastRead = isUserA ? conv.lastReadByA : conv.lastReadByB;

      // Unread if no read cursor, or latest message arrived after last read
      if (!myLastRead || latest.createdAt > myLastRead) {
        messageCount++;
      }
    }

    // ── 3. Unseen community updates ───────────────────────────────────────
    const lastSeen = await prisma.blogLastSeen.findUnique({
      where:  { userId },
      select: { lastSeenAt: true },
    });

    const communityUpdateCount = await prisma.blogPost.count({
      where: lastSeen
        ? { createdAt: { gt: lastSeen.lastSeenAt } }
        : {}, // never visited → all posts are "new"
    });

    // ── 4. Unread sprint room chat mentions/replies ──────────────────────
    const sprintRoomCount = await sprintRoomService.fetchUnreadNotificationCount(userId);

    res.status(200).json({
      notifications:    notificationCount,
      messages:         messageCount,
      communityUpdates: communityUpdateCount,
      sprintRoom:       sprintRoomCount,
    });
  } catch (error) {
    console.error("Get unread counts error:", error);
    res.status(500).json({ message: "Failed to fetch unread counts" });
  }
}

// ============================================
// BIRTHDAY NOTICES (cron-driven)
// ============================================
// Kept here rather than in notificationService/userService on purpose —
// this controller decides *when/who* to notify for the birthday event.
// Both sends below are plain broadcasts/emails, not preference-aware
// per-user notices, so they talk to prisma/mailer directly instead of
// going through notifyUser() — same reasoning as authController's
// new-member notice.

/**
 * Every user whose dateOfBirth is today (month + day, year ignored).
 * Uses a raw query since there's no portable "month/day equals" comparison
 * through Prisma's query builder for a DateTime column.
 */
async function findTodaysBirthdays() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const day   = now.getUTCDate();

  return prisma.$queryRaw`
    SELECT "id", "username", "avatar"
    FROM "User"
    WHERE "isDeleted" = false
      AND "dateOfBirth" IS NOT NULL
      AND EXTRACT(MONTH FROM "dateOfBirth") = ${month}
      AND EXTRACT(DAY FROM "dateOfBirth") = ${day}
  `;
}

/**
 * In-app-only "it's so-and-so's birthday" notice to every other user,
 * filed under the Community tab. No push/email — this is a broadcast to
 * the whole site, not a targeted "someone did something to you" notice.
 */
async function broadcastBirthdayNotification(birthdayUser) {
  const recipients = await prisma.user.findMany({
    where:  { isDeleted: false, id: { not: birthdayUser.id } },
    select: { id: true, username: true },
  });

  if (recipients.length === 0) return;

  const message = `It's ${birthdayUser.username}'s birthday today! 🎂 Send them a Birthday card to celebrate.`;
  const link    = `/${birthdayUser.id}/user`;

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      username:    r.username,
      userId:      r.id,
      message,
      link,
      type:        "GENERAL",
      category:    "COMMUNITY",
      actorAvatar: birthdayUser.avatar ?? null,
      actorId:     birthdayUser.id, // opens the birthday writer's profile popup on click, same as the new-member notice
    })),
  });

  // Web push — same recipients as the in-app broadcast above. No email here
  // (the birthday user's followers get their own email separately, below).
  const subscriptions = await prisma.subscription.findMany({
    where: { userId: { in: recipients.map((r) => r.id) } },
  });
  const payload = { title: "New Notification", body: message, url: link, icon: birthdayUser.avatar || undefined };
  subscriptions.forEach((sub) => sendPushNotification(sub.subscription, payload));
}

/**
 * Email-only nudge to the birthday writer's own followers, pointing them
 * toward sending a BIRTHDAY mailbox card. Deliberately email-only (no
 * inbox row) — the in-app heads-up already went out to everyone above;
 * this is the extra "you specifically follow them" push.
 */
async function emailFollowersAboutBirthday(birthdayUser) {
  const follows = await prisma.follow.findMany({
    where:  { followingId: birthdayUser.id },
    select: { follower: { select: { id: true, username: true, email: true } } },
  });

  const followers = follows.map((f) => f.follower).filter((f) => f.email);
  if (followers.length === 0) return;

  const baseUrl     = process.env.ALLOWED_ORIGIN; // e.g. https://quillweave.com
  const profileLink = `${baseUrl}/${birthdayUser.id}/user`;

  await Promise.all(
    followers.map((follower) =>
      sendEmail(
        follower.email,
        `It's ${birthdayUser.username}'s birthday today! 🎂`,
        `<p>Hello ${follower.username},</p>
         <p>Today is <strong>${birthdayUser.username}</strong>'s birthday! Since you follow them on Quillweave, we thought you'd want to know.</p>
         <p>Head over to their profile and send them a birthday wishes card to help make their day.</p>
         <a href="${profileLink}">Visit ${birthdayUser.username}'s profile</a>`
      ).catch((err) => console.error(`Birthday email failed for ${follower.email}:`, err))
    )
  );
}

/**
 * Entry point for the daily birthday cron (see cron/birthdayCron.js).
 * For every writer whose birthday is today: broadcasts the in-app notice
 * to everyone, and emails that writer's own followers separately.
 */
async function checkBirthdaysAndNotify() {
  try {
    const birthdayUsers = await findTodaysBirthdays();

    for (const birthdayUser of birthdayUsers) {
      await broadcastBirthdayNotification(birthdayUser).catch((err) =>
        console.error(`Birthday broadcast failed for user ${birthdayUser.id}:`, err)
      );
      await emailFollowersAboutBirthday(birthdayUser).catch((err) =>
        console.error(`Birthday follower emails failed for user ${birthdayUser.id}:`, err)
      );
    }
  } catch (error) {
    console.error("Birthday cron error:", error);
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    saveSubscription,
    getNotifications,
    markRead,
    savePreferences,
    getPreferences,
    getUnreadCounts,
    checkBirthdaysAndNotify,
};