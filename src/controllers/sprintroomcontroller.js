const sprintRoomService = require("../services/sprintroomservice");

async function fetchRoom(req, res) {
  try {
    const room = await sprintRoomService.fetchOrCreateDefaultRoom();
    const currentGroupSprint = await sprintRoomService.fetchCurrentGroupSprint();
    res.status(200).json({ room, currentGroupSprint });
  } catch (error) {
    console.error("Fetch sprint room error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function joinRoom(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const userId = Number(req.user.id);

  try {
    const presence = await sprintRoomService.joinRoom(sprintRoomId, userId);
    res.status(200).json({ presence });
  } catch (error) {
    console.error("Join sprint room error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function heartbeat(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const userId = Number(req.user.id);

  try {
    await sprintRoomService.heartbeat(sprintRoomId, userId);
    res.status(204).end();
  } catch (error) {
    console.error("Sprint room heartbeat error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function leaveRoom(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const userId = Number(req.user.id);

  try {
    await sprintRoomService.leaveRoom(sprintRoomId, userId);
    res.status(204).end();
  } catch (error) {
    console.error("Leave sprint room error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

// Writer sets their own "what I'm doing" flag (DRAFTING / EDITING / OUTLINING),
// or clears it by sending status: null. Display-only — nothing else in the
// app reads this.
async function setStatus(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const userId = Number(req.user.id);
  const { status } = req.body;

  try {
    const presence = await sprintRoomService.setStatus(sprintRoomId, userId, status || null);
    res.status(200).json({ presence });
  } catch (error) {
    console.error("Set sprint room status error:", error);
    const status_ = error.message === "Unknown status" ? 400 : 500;
    res.status(status_).json({ message: error.message || "Something went wrong. Please try again later." });
  }
}

async function fetchRoomMembers(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);

  try {
    const members = await sprintRoomService.fetchRoomMembers(sprintRoomId);
    res.status(200).json({ members });
  } catch (error) {
    console.error("Fetch sprint room members error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function postMessage(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const senderId = Number(req.user.id);
  const { content, quotedMessageId, messageType = "TEXT", mediaUrl, soundKey } = req.body;

  if (messageType === "TEXT" && (!content || !content.trim())) {
    return res.status(400).json({ message: "Message content is required." });
  }
  if (messageType === "GIF" && !mediaUrl) {
    return res.status(400).json({ message: "A GIF message requires a mediaUrl." });
  }
  if (messageType === "SOUND" && !sprintRoomService.SOUND_KEYS.has(soundKey)) {
    return res.status(400).json({ message: "Unknown soundKey." });
  }

  try {
    const message = await sprintRoomService.postMessage(
      sprintRoomId,
      senderId,
      (content || "").trim(),
      quotedMessageId ? Number(quotedMessageId) : null,
      { messageType, mediaUrl: mediaUrl || null, soundKey: soundKey || null }
    );
    res.status(201).json({ message });
  } catch (error) {
    console.error("Post sprint room message error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchRoomMessages(req, res) {
  const sprintRoomId = Number(req.params.sprintRoomId);
  const limit = Number(req.query.limit) || 50;
  const before = req.query.before || undefined;

  try {
    const messages = await sprintRoomService.fetchRoomMessages(sprintRoomId, { limit, before });
    res.status(200).json({ messages });
  } catch (error) {
    console.error("Fetch sprint room messages error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function deleteMessage(req, res) {
  const messageId = Number(req.params.messageId);
  const requesterId = Number(req.user.id);

  try {
    const message = await sprintRoomService.deleteMessage(messageId, requesterId);
    res.status(200).json({ message });
  } catch (error) {
    console.error("Delete sprint room message error:", error);
    const status = error.message === "Not authorized to delete this message" ? 403 : 500;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again later." });
  }
}

async function searchGifs(req, res) {
  const q = (req.query.q || "").trim();
  const pos = req.query.pos || undefined;

  try {
    const { gifs, next } = await sprintRoomService.searchGifs(q, { limit: 24, pos });
    res.status(200).json({ gifs, next });
  } catch (error) {
    console.error("Sprint room GIF search error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function getUnreadNotificationCount(req, res) {
  const userId = Number(req.user.id);

  try {
    const count = await sprintRoomService.fetchUnreadNotificationCount(userId);
    res.status(200).json({ count });
  } catch (error) {
    console.error("Fetch sprint room unread notification count error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function markNotificationsRead(req, res) {
  const userId = Number(req.user.id);

  try {
    await sprintRoomService.markNotificationsRead(userId);
    res.status(204).end();
  } catch (error) {
    console.error("Mark sprint room notifications read error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  fetchRoom,
  joinRoom,
  heartbeat,
  leaveRoom,
  setStatus,
  fetchRoomMembers,
  postMessage,
  fetchRoomMessages,
  deleteMessage,
  searchGifs,
  getUnreadNotificationCount,
  markNotificationsRead,
};