// src/services/ogimageservice.js
//
// Renders the "Share Room" preview image: 1200x630 PNG, QuillWeave
// branding, the room name, a live writer count, and the "Make it exist."
// tagline. Built as SVG (plain text/shapes, no external image assets — no
// native canvas dependency to install/build on Render) then rasterized
// with sharp. Consumed by sharecontroller.js's fetchSprintRoomOgImage.
const sharp = require("sharp");

function escapeXml(str = "") {
  return str.replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

function buildSvg({ roomName, writerCount }) {
  const name = escapeXml(roomName || "Sprint Room");
  const displayName = name.length > 42 ? name.slice(0, 39) + "…" : name;
  const writerLine = writerCount === 1 ? "1 writer sprinting" : `${writerCount} writers sprinting`;

  return `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#000000"/>
      <stop offset="100%" stop-color="#0a0f14"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1080" cy="90" r="260" fill="#38BDF8" opacity="0.06"/>
  <circle cx="120" cy="560" r="200" fill="#F0B429" opacity="0.06"/>

  <text x="80" y="110" font-family="Georgia, 'Times New Roman', serif" font-size="34"
        fill="#ffffff" font-weight="700">QuillWeave</text>
  <rect x="80" y="128" width="64" height="4" fill="#38BDF8"/>

  <text x="80" y="280" font-family="Georgia, 'Times New Roman', serif" font-size="56"
        fill="#ffffff" font-weight="600">${displayName}</text>

  <rect x="80" y="320" width="14" height="14" rx="7" fill="#22C55E"/>
  <text x="106" y="332" font-family="Arial, sans-serif" font-size="30" fill="#e5e5e5">${writerLine} right now</text>

  <text x="80" y="540" font-family="Georgia, 'Times New Roman', serif" font-size="46"
        fill="#F0B429" font-weight="700" font-style="italic">Make it exist.</text>

  <text x="80" y="590" font-family="Arial, sans-serif" font-size="20" fill="#8a8a8a">quillweave.app</text>
</svg>`.trim();
}

async function renderSprintRoomOgImage({ roomName, writerCount }) {
  const svg = buildSvg({ roomName, writerCount });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderSprintRoomOgImage };