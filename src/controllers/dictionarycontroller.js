// src/controllers/dictionaryController.js
const dictionaryService = require("../services/dictionaryservice");

function errStatus(msg) {
  if (msg.includes("not found"))            return 404;
  if (msg.includes("already in your"))      return 409;
  return 400;
}

// ─── ADD ──────────────────────────────────────────────────────────────────────
// POST /dictionary — body: { word, meaning }

async function addEntry(req, res) {
  try {
    const entry = await dictionaryService.addEntry(req.user.id, req.body);
    res.status(201).json(entry);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
// DELETE /dictionary/:entryId

async function deleteEntry(req, res) {
  try {
    const entryId = Number(req.params.entryId);
    const result  = await dictionaryService.deleteEntry(req.user.id, entryId);
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
// GET /dictionary?search=optional

async function getDictionary(req, res) {
  try {
    const entries = await dictionaryService.getDictionary(req.user.id, {
      search: req.query.search,
    });
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  addEntry,
  deleteEntry,
  getDictionary,
};