const express = require("express");
const router  = express.Router();
const eventController = require("../controllers/eventcontroller");
const { authenticateJWT } = require("../config/jwt");
const upload = require("../config/multer");

// ─── Events ───────────────────────────────────────────────────────────────────
// Any authenticated member can join/leave.
// Only admins can create, update, delete, or manually finalize an event.
//
// Filter by status: GET /events?status=ACTIVE  (UPCOMING | ACTIVE | ENDED)

router.get(   "/",          eventController.getEvents);
router.get(   "/:eventId",  eventController.getEvent);
router.post(  "/",          authenticateJWT, upload.single("image"), eventController.createEvent);
router.put(   "/:eventId",  authenticateJWT, upload.single("image"), eventController.updateEvent);
router.delete("/:eventId",  authenticateJWT,                         eventController.deleteEvent);

// ─── Joining ──────────────────────────────────────────────────────────────────
// Requires the member to already have a draft plan (checked in the service).

router.post("/:eventId/join",  authenticateJWT, eventController.joinEvent);
router.post("/:eventId/leave", authenticateJWT, eventController.leaveEvent);
router.get( "/:eventId/participation", authenticateJWT, eventController.getMyParticipation);

// ─── Participants (public read) ────────────────────────────────────────────────

router.get("/:eventId/participants", eventController.getParticipants);

// ─── Finalizing (admin manual trigger — cron handles this automatically) ──────

router.post("/:eventId/finalize", authenticateJWT, eventController.finalizeEvent);

module.exports = router;