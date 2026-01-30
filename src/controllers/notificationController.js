const { param } = require("../routes/notificationRoutes");
const notificationsService = require("../services/notificationService");
const userService = require("../services/userService");

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

        // Validate subscription data
        if (!subscription) {
            return res.status(400).json({ message: "No subscription provided" });
        }

        // Save subscription to database
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
        const userId = Number(req.params.userId);
        await userService.markNotificationRead(userId)
        res.status(200).json({ message: "Notification marked as read" });
    } catch (error) {
        console.error("Mark notification as read error:", error);
        res.status(500).json({ message: "Failed to update notification" });
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    saveSubscription,
    getNotifications,
    markRead
};