const draftFolderService = require("../services/draftfolderservice");

/**
 * GET /draftfolders
 * All of the writer's folders — plan folders and general folders together.
 */
async function getMyFolders(req, res) {
  const userId = Number(req.user.id);

  try {
    const folders = await draftFolderService.getMyFolders(userId);
    res.status(200).json({ folders });
  } catch (error) {
    console.error("Get folders error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * GET /draftfolders/options
 * Lightweight id + name list, for a "pick a folder" dropdown when starting
 * a new draft file.
 */
async function getFolderOptions(req, res) {
  const userId = Number(req.user.id);

  try {
    const folders = await draftFolderService.getMyFolderOptions(userId);
    res.status(200).json({ folders });
  } catch (error) {
    console.error("Get folder options error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * GET /draftfolders/:folderId
 * A single folder, with its draft files — the "open a folder" screen.
 */
async function getFolderById(req, res) {
  const userId   = Number(req.user.id);
  const folderId = Number(req.params.folderId);

  try {
    const folder = await draftFolderService.getFolderWithDrafts(folderId, userId);
    res.status(200).json({ folder });
  } catch (error) {
    if (error.message === "Folder not found.") {
      return res.status(404).json({ message: error.message });
    }
    console.error("Get folder error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

/**
 * PATCH /draftfolders/:folderId
 * Rename the writer's General folder. Body: { name }
 * (Plan folders reject this — see draftfolderservice.)
 */
async function renameFolder(req, res) {
  const userId   = Number(req.user.id);
  const folderId = Number(req.params.folderId);
  const { name } = req.body;

  try {
    const folder = await draftFolderService.renameGeneralFolder(folderId, userId, name);
    res.status(200).json({ folder });
  } catch (error) {
    if (error.message === "Folder not found.") {
      return res.status(404).json({ message: error.message });
    }
    if (
      error.message === "Give the folder a name." ||
      error.message.startsWith("This folder belongs to a draft plan")
    ) {
      return res.status(400).json({ message: error.message });
    }
    console.error("Rename folder error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
}

module.exports = {
  getMyFolders,
  getFolderOptions,
  getFolderById,
  renameFolder,
};