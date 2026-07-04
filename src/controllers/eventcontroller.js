const eventService = require("../services/eventservice");
const { uploadFile, deleteFile } = require("../utilis/fileUploader");
const { notifyUser } = require("../services/notificationService");

// ─── Events (admin write, public read) ────────────────────────────────────────

async function createEvent(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }

  const { title, description, startDate, endDate } = req.body;
  const badgeName = (req.body.badgeName || "").trim();
  const badgeIcon = (req.body.badgeIcon || "").trim();

  if (!title)        return res.status(400).json({ message: "Title is required." });
  if (!description)  return res.status(400).json({ message: "Description is required." });
  if (!startDate)    return res.status(400).json({ message: "Start date is required." });
  if (!endDate)      return res.status(400).json({ message: "End date is required." });
  if (!badgeName)    return res.status(400).json({ message: "badgeName is required — e.g. \"Summer Routine Finisher\"." });
  if (!badgeIcon)    return res.status(400).json({ message: "badgeIcon is required — an emoji, or an icon key/URL." });
  if (badgeName.length > 50) {
    return res.status(400).json({ message: "badgeName must be 50 characters or fewer." });
  }

  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (isNaN(start) || isNaN(end)) {
    return res.status(400).json({ message: "Start/end date is invalid." });
  }
  if (end <= start) {
    return res.status(400).json({ message: "End date must be after the start date." });
  }

  try {
    let imageUrl = null;
    if (req.file) imageUrl = await uploadFile(req.file);

    const event = await eventService.createEvent({
      title,
      description,
      imageUrl,
      startDate: start,
      endDate: end,
      badgeName,
      badgeIcon,
    });

    res.status(201).json({ event });

    // Let everyone know a new event opened up (fire and forget).
    eventService.getAllUsers().then((users) => {
      const notifLink = `/events/${event.id}`;
      users.forEach((u) => {
        if (u.id === req.user.id) return;
        notifyUser(u, `New event: "${title}"`, notifLink, "event_new").catch(() => {});
      });
    }).catch(() => {});
  } catch (error) {
    console.error("Create event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getEvents(req, res) {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 20;
  const status = req.query.status || undefined; // UPCOMING | ACTIVE | ENDED
  try {
    const result = await eventService.getEvents({ page, limit, status });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get events error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getEvent(req, res) {
  const eventId = Number(req.params.eventId);
  try {
    const event = await eventService.getEvent(eventId);
    if (!event) return res.status(404).json({ message: "Event not found." });
    res.status(200).json({ event });
  } catch (error) {
    console.error("Get event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function updateEvent(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const eventId = Number(req.params.eventId);
  const { title, description, startDate, endDate } = req.body;
  const badgeNameRaw = req.body.badgeName;
  const badgeIconRaw = req.body.badgeIcon;
  const badgeName = badgeNameRaw !== undefined ? badgeNameRaw.trim() : undefined;
  const badgeIcon = badgeIconRaw !== undefined ? badgeIconRaw.trim() : undefined;

  if (badgeName !== undefined) {
    if (!badgeName) {
      return res.status(400).json({ message: "badgeName can't be blank." });
    }
    if (badgeName.length > 50) {
      return res.status(400).json({ message: "badgeName must be 50 characters or fewer." });
    }
  }
  if (badgeIcon !== undefined && !badgeIcon) {
    return res.status(400).json({ message: "badgeIcon can't be blank." });
  }

  try {
    const existing = await eventService.findEvent(eventId);
    if (!existing) return res.status(404).json({ message: "Event not found." });

    let imageUrl;
    if (req.file) {
      if (existing.imageUrl) await deleteFile(existing.imageUrl);
      imageUrl = await uploadFile(req.file);
    }

    const event = await eventService.updateEvent(eventId, {
      title,
      description,
      imageUrl,
      startDate: startDate !== undefined ? new Date(startDate) : undefined,
      endDate:   endDate   !== undefined ? new Date(endDate)   : undefined,
      badgeName,
      badgeIcon,
    });

    res.status(200).json({ event });
  } catch (error) {
    console.error("Update event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteEvent(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const eventId = Number(req.params.eventId);
  try {
    const existing = await eventService.findEvent(eventId);
    if (!existing) return res.status(404).json({ message: "Event not found." });
    const imageUrl = await eventService.deleteEvent(eventId);
    if (imageUrl) await deleteFile(imageUrl);
    res.status(200).json({ message: "Event deleted successfully." });
  } catch (error) {
    console.error("Delete event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Joining / leaving ────────────────────────────────────────────────────────

async function joinEvent(req, res) {
  const eventId = Number(req.params.eventId);
  const userId  = req.user.id;
  try {
    const result = await eventService.joinEvent(eventId, userId);
    res.status(200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Join event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function leaveEvent(req, res) {
  const eventId = Number(req.params.eventId);
  const userId  = req.user.id;
  try {
    const result = await eventService.leaveEvent(eventId, userId);
    res.status(200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Leave event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getMyParticipation(req, res) {
  const eventId = Number(req.params.eventId);
  const userId  = req.user.id;
  try {
    const result = await eventService.getMyParticipation(eventId, userId);
    res.status(200).json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Get event participation error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Participants ─────────────────────────────────────────────────────────────

async function getParticipants(req, res) {
  const eventId = Number(req.params.eventId);
  const page    = parseInt(req.query.page)  || 1;
  const limit   = parseInt(req.query.limit) || 20;
  try {
    const result = await eventService.getParticipants(eventId, { page, limit });
    if (!result) return res.status(404).json({ message: "Event not found." });
    res.status(200).json(result);
  } catch (error) {
    console.error("Get event participants error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// ─── Finalizing ───────────────────────────────────────────────────────────────
// Normally run automatically by the cron (see jobs/eventcron.js), but admins
// can also trigger it manually — e.g. to close an event early.

async function finalizeEvent(req, res) {
  if (req.user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admin access required." });
  }
  const eventId = Number(req.params.eventId);
  try {
    const result = await eventService.finalizeEvent(eventId);
    res.status(200).json(result);

    if (!result.alreadyFinalized && result.finisherUserIds.length > 0) {
      Promise.allSettled(
        result.finisherUserIds.map(async (userId) => {
          const user = await eventService.getUserById(userId);
          if (!user) return;
          notifyUser(
            user,
            `You completed "${result.event.title}" and earned the ${result.event.badgeName} badge!`,
            `/events/${eventId}`,
            "event_finisher"
          ).catch(() => {});
        })
      ).catch(() => {});
    }
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    console.error("Finalize event error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  createEvent,
  getEvents,
  getEvent,
  updateEvent,
  deleteEvent,
  joinEvent,
  leaveEvent,
  getMyParticipation,
  getParticipants,
  finalizeEvent,
};