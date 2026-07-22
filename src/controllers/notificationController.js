const notificationsService   = require("../services/notificationService");
const sprintReminderService  = require("../services/sprintreminderservice");

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

// ============================================
// SPRINT REMINDER OPT-IN
// ============================================

/**
 * Get whether the current user has opted into the Friday sprint reminder.
 * The AccountabilityPage toggle reads this on mount to set its initial state.
 *
 * Response: { optedIn: boolean }
 *   - true  → reminder is active
 *   - false → reminder is off (or user has never set a preference, defaults false)
 *
 * @route GET /notifications/sprint-reminder
 */
async function getSprintReminderOptIn(req, res) {
  try {
    const record = await sprintReminderService.fetchSprintReminderOptIn(req.user.id);
    // If no record exists yet, the user hasn't opted in → default false
    res.status(200).json({ optedIn: record ? record.optedIn : false });
  } catch (error) {
    console.error("Get sprint reminder opt-in error:", error);
    res.status(500).json({ message: "Failed to fetch sprint reminder preference" });
  }
}

/**
 * Save (toggle) the Friday sprint reminder opt-in for the current user.
 * Called when the writer checks or unchecks the toggle on AccountabilityPage.
 *
 * Body: { optedIn: boolean }
 *
 * @route POST /notifications/sprint-reminder
 */
async function saveSprintReminderOptIn(req, res) {
  try {
    const { optedIn } = req.body;

    if (typeof optedIn !== "boolean") {
      return res.status(400).json({ message: "optedIn (boolean) is required" });
    }

    await sprintReminderService.saveSprintReminderOptIn(req.user.id, optedIn);

    // Also keep the existing NotificationPreference JSON blob in sync so that
    // notifyUser() respects the user's per-channel choices when it fires.
    await notificationsService.savePreferences(req.user.id, {
      friday_sprint_reminder: { inbox: optedIn, push: optedIn, email: optedIn },
    });

    res.status(200).json({ message: "Sprint reminder preference saved" });
  } catch (error) {
    console.error("Save sprint reminder opt-in error:", error);
    res.status(500).json({ message: "Failed to save sprint reminder preference" });
  }
}

const prisma = require("../config/prismaClient");
const sprintRoomService = require("../services/sprintroomservice");

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
    // Excludes MESSAGE / COMMUNITY_UPDATE so this badge count always matches
    // what the bell page (fetchNotifications) actually displays — those two
    // types have their own dedicated pages + badges below.
    const notificationCount = await prisma.notification.count({
      where: {
        userId,
        read: false,
        type: { notIn: ["MESSAGE", "COMMUNITY_UPDATE"] },
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
// EXPORTS
// ============================================

module.exports = {
    saveSubscription,
    getNotifications,
    markRead,
    savePreferences,
    getPreferences,
    getSprintReminderOptIn,
    saveSprintReminderOptIn,
    getUnreadCounts
};