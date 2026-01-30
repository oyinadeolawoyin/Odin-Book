const express = require("express");
const router = express.Router();
const notificationsController = require("../controllers/notificationController");

router.get("/", notificationsController.getNotifications);
router.post("/save-subscription", notificationsController.saveSubscription);
router.post("/:userId/read", notificationsController.markRead);

module.exports = router;