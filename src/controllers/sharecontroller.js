// src/controllers/sharecontroller.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sprintRoomService = require("../services/sprintroomservice");
const { renderSprintRoomOgImage } = require("../services/ogimageService");

// API_URL: this backend's own public address — needed because og:image has
// to be fetched by X/Tumblr's crawlers, not just your browser, so it can't
// be relative or window.location. CLIENT_URL: where a real visitor lands
// after the redirect — reuses the same ALLOWED_ORIGIN your CORS setup
// already relies on, so there's no new "frontend URL" var to keep in sync.
const API_URL = process.env.API_URL;
const CLIENT_URL = process.env.ALLOWED_ORIGIN;

// ─── SPRINT ROOM (live) ──────────────────────────────────────────────────

async function fetchSprintRoomOgImage(req, res) {
  const sprintRoomId = Number(req.params.roomId);

  try {
    const room = await sprintRoomService.fetchRoomById(sprintRoomId);
    const sprintingMembers = room ? await sprintRoomService.fetchSprintingMembers(room.id) : [];
    const png = await renderSprintRoomOgImage({
      roomName: room?.name,
      writerCount: sprintingMembers.length,
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=60"); // short — writer count is live
    res.status(200).send(png);
  } catch (error) {
    console.error("Fetch sprint room OG image error:", error);
    res.status(500).end();
  }
}

async function fetchSprintRoomSharePage(req, res) {
  const sprintRoomId = Number(req.params.roomId);
  let room = null;

  try {
    room = await sprintRoomService.fetchRoomById(sprintRoomId);
  } catch (error) {
    console.error("Fetch sprint room share page error:", error);
  }

  const roomName = room?.name || "Sprint Room";
  const title = `${roomName} — QuillWeave`;
  const ogImage = `${API_URL}/api/og/sprint-room/${sprintRoomId}.png`;
  const appUrl = `${CLIENT_URL}/sprint-room?roomId=${sprintRoomId}`;

  res.set("Content-Type", "text/html").status(200).send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="Join the sprint. Make it exist.">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:url" content="${API_URL}/api/share/sprint/${sprintRoomId}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:image" content="${ogImage}">
  <meta http-equiv="refresh" content="0; url=${appUrl}">
</head><body><p>Redirecting to <a href="${appUrl}">${roomName}</a>…</p></body></html>`);
}

// ─── BRAG CARD (upload-once, static) ─────────────────────────────────────
//
// Unlike the Sprint Room (which regenerates its image live on every
// request, since the writer count changes), a brag card is a one-time
// snapshot the writer already rendered client-side with html-to-image.
// There's nothing to regenerate — just needs a real, public URL to sit at
// so X/Tumblr's crawlers (and Tumblr's photo-post composer, which takes a
// hosted image URL directly) can actually reach it.
const BRAG_UPLOADS_DIR = path.join(__dirname, "..", "uploads", "brag");
fs.mkdirSync(BRAG_UPLOADS_DIR, { recursive: true });

async function uploadBragImage(req, res) {
  const { imageDataUrl } = req.body || {};

  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/png;base64,")) {
    return res.status(400).json({ message: "A PNG data URL is required." });
  }

  try {
    const base64 = imageDataUrl.slice("data:image/png;base64,".length);
    const buffer = Buffer.from(base64, "base64");
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(BRAG_UPLOADS_DIR, `${id}.png`), buffer);

    res.status(201).json({
      id,
      imageUrl: `${API_URL}/api/uploads/brag/${id}.png`,
      shareUrl: `${API_URL}/api/share/brag/${id}`,
    });
  } catch (error) {
    console.error("Brag image upload error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

async function fetchBragSharePage(req, res) {
  const { id } = req.params;
  const imagePath = path.join(BRAG_UPLOADS_DIR, `${id}.png`);

  if (!/^[0-9a-f-]{36}$/i.test(id) || !fs.existsSync(imagePath)) {
    return res.status(404).send("This brag card link has expired.");
  }

  const ogImage = `${API_URL}/api/uploads/brag/${id}.png`;
  const appUrl = `${CLIENT_URL}/?ref=brag_share`;

  res.set("Content-Type", "text/html").status(200).send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><title>A writer's win on QuillWeave — Make it exist.</title>
  <meta property="og:title" content="A writer's win on QuillWeave">
  <meta property="og:description" content="Make it exist.">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${ogImage}">
  <meta http-equiv="refresh" content="0; url=${appUrl}">
</head><body><p>Redirecting to <a href="${appUrl}">QuillWeave</a>…</p></body></html>`);
}

module.exports = {
  fetchSprintRoomOgImage,
  fetchSprintRoomSharePage,
  uploadBragImage,
  fetchBragSharePage,
};