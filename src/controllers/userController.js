require("dotenv").config();
const userService = require("../services/userService");
const fileUploader = require("../utilis/fileUploader");

async function updateUser(req, res) {
  try {
    const { username, email, bio, dateOfBirth } = req.body;
    const userId = Number(req.user.id);
    const file = req.file;

    const charCount = bio ? bio.trim().length : 0;
    if (charCount > 400) {
      return res.status(400).json({ message: "Bio content must not exceed 400 characters." });
    }

    // Validate date of birth if provided
    if (dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== "") {
      const dob = new Date(dateOfBirth);
      if (isNaN(dob.getTime())) {
        return res.status(400).json({ message: "Please enter a valid date of birth." });
      }
      const now = new Date();
      const minDob = new Date(now.getFullYear() - 120, 0, 1);
      if (dob >= now) {
        return res.status(400).json({ message: "Date of birth must be in the past." });
      }
      if (dob < minDob) {
        return res.status(400).json({ message: "Please enter a valid date of birth." });
      }
    }

    // Validate email format if provided
    if (email !== undefined && email !== null && email !== "") {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ message: "Please enter a valid email address." });
      }

      // Check email isn't already taken by another user
      const existingEmail = await userService.findUserByEmail(email.trim());
      if (existingEmail && existingEmail.id !== userId) {
        return res.status(409).json({ message: "That email is already in use by another account." });
      }
    }

    // Parse and validate social links (up to 2, each needs platform + valid url)
    let socialLinks;
    if (req.body.socialLinks !== undefined) {
      try {
        const parsed = typeof req.body.socialLinks === "string"
          ? JSON.parse(req.body.socialLinks)
          : req.body.socialLinks;

        if (!Array.isArray(parsed)) throw new Error();

        const urlRegex = /^https?:\/\/.+/i;
        const cleaned = parsed
          .slice(0, 2)
          .filter(l => l.platform?.trim() && l.url?.trim())
          .map(l => ({ platform: l.platform.trim(), url: l.url.trim() }));

        for (const link of cleaned) {
          if (!urlRegex.test(link.url)) {
            return res.status(400).json({ message: `"${link.url}" is not a valid URL. It must start with http:// or https://` });
          }
        }
        socialLinks = cleaned;
      } catch {
        return res.status(400).json({ message: "Invalid social links format." });
      }
    }

    // Get current user
    const existingUser = await userService.fetchUser(userId);

    let avatar; // intentionally undefined by default

    // If user uploaded a new avatar
    if (file) {
      if (existingUser.avatar) {
        await fileUploader.deleteFile(existingUser.avatar);
      }
      avatar = await fileUploader.uploadFile(file);
    }

    // Build update payload — only include defined fields so partial updates work
    const updateData = { userId };
    if (username    !== undefined) updateData.username    = username;
    if (email       !== undefined) updateData.email       = email.trim();
    if (bio         !== undefined) updateData.bio         = bio;
    if (avatar)                    updateData.avatar      = avatar;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth || null;
    if (socialLinks !== undefined) updateData.socialLinks = socialLinks;

    const user = await userService.updateUser(updateData);

    res.status(200).json({ user });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ message: "Something went wrong. Please try again." });
  }
}

// async function fetchUsers(req, res) {
//   try {
//     const users = await userService.fetchUsers();
//     res.status(200).json({ users });
//   } catch (error) {
//     console.error("Fetch users error:", error);
//     res.status(500).json({ message: error.message || "Something went wrong. Please try again." });
//   }
// }

async function fetchUser(req, res) {
  const userId = req.params.userId;
  try {
    const user = await userService.fetchUser(Number(userId));
    res.status(200).json({ user });
  } catch (error) {
    console.error("Fetch user error:", error);
    res.status(500).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

/**
 * DELETE /users/me
 *
 * Soft-deletes the authenticated user's account:
 *  1. Wipes all personal data on the User row (username → "[deleted]_id_ts",
 *     email/password/avatar/bio/discordId all nulled).
 *  2. All their content (projects, sprints, notes …) is hard-deleted by the DB
 *     via onDelete: Cascade.
 *  3. Comments / feedback they left on *other* people's content are preserved
 *     with a null authorId — the UI shows "[deleted]" (Reddit-style).
 *  4. The auth cookie is cleared so the client is immediately logged out.
 *
 * If the user had an avatar uploaded to object storage, it is deleted first.
 */
async function deleteUser(req, res) {
  const userId = req.user.id;
  try {
    // Clean up avatar from object storage before wiping the row
    const existingUser = await userService.fetchUser(Number(userId));
    if (existingUser?.avatar) {
      try {
        await fileUploader.deleteFile(existingUser.avatar);
      } catch (avatarErr) {
        // Non-fatal — log and continue; the account is still deleted
        console.error("Avatar cleanup error during account deletion:", avatarErr);
      }
    }

    await userService.deleteUser(Number(userId));

    // Clear the auth cookie so the browser is immediately logged out.
    // Adjust the cookie name to whatever your JWT middleware uses.
    res.clearCookie("token", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });

    res.status(200).json({ message: "Your account has been deleted." });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

async function fetchFoundingWriters(req, res) {
  try {
    const viewerId = req.user?.id ? Number(req.user.id) : undefined;
    const users = await userService.fetchFoundingWriters(viewerId);
    res.status(200).json({ users });
  } catch (error) {
    console.error("Fetch founding writers error:", error);
    res.status(500).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

/**
 * POST /users/:userId/block
 * Block another writer. The authenticated user is the blocker.
 */
async function blockUser(req, res) {
  const blockerId = Number(req.user.id);
  const blockedId = Number(req.params.userId);

  try {
    await userService.blockUser(blockerId, blockedId);
    res.status(200).json({ blocked: true });
  } catch (error) {
    console.error("Block user error:", error);
    const status = error.message === "User not found." ? 404 : 400;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

/**
 * DELETE /users/:userId/block
 * Unblock a writer the authenticated user previously blocked.
 */
async function unblockUser(req, res) {
  const blockerId = Number(req.user.id);
  const blockedId = Number(req.params.userId);

  try {
    await userService.unblockUser(blockerId, blockedId);
    res.status(200).json({ unblocked: true });
  } catch (error) {
    console.error("Unblock user error:", error);
    const status = error.message === "Block not found." ? 404 : 400;
    res.status(status).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

/**
 * GET /users/blocked
 * Returns the list of users the authenticated user has blocked.
 */
async function getBlockedUsers(req, res) {
  const blockerId = Number(req.user.id);

  try {
    const users = await userService.getBlockedUsers(blockerId);
    res.status(200).json({ users });
  } catch (error) {
    console.error("Get blocked users error:", error);
    res.status(500).json({ message: error.message || "Something went wrong. Please try again." });
  }
}

module.exports = {
  updateUser,
  // fetchUsers,
  fetchUser,
  deleteUser,
  fetchFoundingWriters,
  blockUser,
  unblockUser,
  getBlockedUsers,
};