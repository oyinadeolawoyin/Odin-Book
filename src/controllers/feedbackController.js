// src/feedback/feedback.controller.js
const feedbackService     = require("../services/feedbackService");
const pointsService       = require("../services/pointService");
const { notifyUser }      = require("../services/notificationService");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function errStatus(msg) {
  if (msg.includes("not found"))                               return 404;
  if (msg.includes("Not authorised") || msg.includes("Only")) return 403;
  if (msg.includes("Not enough points"))                       return 402;
  if (msg.includes("own"))                                     return 403;
  return 400;
}

// ─── POINTS ──────────────────────────────────────────────────────────────────

async function getMyWallet(req, res) {
  try {
    const [wallet, critiqueGiven] = await Promise.all([
      pointsService.getWallet(req.user.id),
      // Count how many critiques (FeedbackResponse rows) this user has written
      require("../config/prismaClient").feedbackResponse.count({
        where: { criticId: req.user.id },
      }),
    ]);
    res.json({ ...wallet, critiqueGiven });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// Public — returns reputation + tier only (no posting balance)
async function getUserWallet(req, res) {
  try {
    const wallet = await pointsService.getWallet(Number(req.params.userId));
    const { postingBalance: _hidden, ...pub } = wallet;
    res.json(pub);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ─── SUBMISSIONS ─────────────────────────────────────────────────────────────

async function createSubmission(req, res) {
  try {
    const submission = await feedbackService.createSubmission(req.user.id, req.body);

    // Notify all other users (fire and forget).
    // feedbackService.getAllUsersExcept keeps prisma out of the controller,
    // same pattern as snippetService.getUserById in snippetController.
    feedbackService.getAllUsersExcept(req.user.id)
      .then((users) => {
        const message = `${submission.user.username} posted a new submission: "${submission.title}"`;
        const link    = `/critique/${submission.id}`;
        users.forEach((user) => notifyUser(user, message, link, "feedback_new_submission", "GENERAL", {
          kind: "new_submission", title: submission.title,
        }).catch(() => {}));
      })
      .catch(() => {});

    res.status(201).json(submission);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// GET /submissions/mine — authenticated user's own submissions
async function getUserSubmissions(req, res) {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const result = await feedbackService.getSubmissions({
      page:   Number(page),
      limit:  Math.min(Number(limit), 50),
      userId,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getSubmissions(req, res) {
  try {
    const { page = 1, limit = 20, genre, status } = req.query;
    const result = await feedbackService.getSubmissions({
      page:   Number(page),
      limit:  Math.min(Number(limit), 50),
      genre,
      status,
      userId: req.query.userId ? Number(req.query.userId) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getSubmissionById(req, res) {
  try {
    const submission = await feedbackService.getSubmissionById(
      Number(req.params.id),
      req.user?.id ?? null
    );
    res.json(submission);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function updateSubmission(req, res) {
  try {
    const submission = await feedbackService.updateSubmission(
      Number(req.params.id),
      req.user.id,
      req.body
    );
    res.json(submission);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function deleteSubmission(req, res) {
  try {
    const result = await feedbackService.deleteSubmission(
      Number(req.params.id),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getSpotlight(req, res) {
  try {
    const submissions = await feedbackService.getSpotlightSubmissions();
    // console.log("spo", submissions);
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getQueue(req, res) {
  try {
    const { page = 1, limit = 10, genre } = req.query;
    const result = await feedbackService.getQueueSubmissions({
      page:  Number(page),
      limit: Math.min(Number(limit), 50),
      genre: genre || undefined,
    }); console.log("que", result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getArchive(req, res) {
  try {
    const { page = 1, limit = 9 , genre } = req.query;
    const result = await feedbackService.getOutdatedSubmissions({
      page: Number(page),
      limit: Math.min(Number(limit), 50),
      genre: genre || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getArchiveGenres(req, res) {
  try {
    const genres = await feedbackService.getArchiveGenres();
    res.json(genres);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function getQueueGenres(req, res) {
  try {
    const genres = await feedbackService.getQueueGenres();
    res.json(genres);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ─── FEEDBACK RESPONSES ──────────────────────────────────────────────────────

async function createResponse(req, res) {
  try {
    const response = await feedbackService.createResponse(
      req.user.id,
      Number(req.params.id),
      req.body
    );

    // The service now returns submissionAuthor: { id, username, email } directly
    // on the response object — no extra DB call needed here.
    // This mirrors how snippetController gets author data from snippetService.
    const { submissionAuthor, submissionTitle, ...responseData } = response;
    if (submissionAuthor && submissionAuthor.id !== req.user.id) {
      const message = `${req.user.username ?? "Someone"} left a critique on your submission: "${submissionTitle ?? ""}"`;
      const link    = `/critique/${req.params.id}#critique-${response.id}`;
      notifyUser(submissionAuthor, message, link, "feedback_critique_received", "GENERAL", {
        kind: "reaction", title: submissionTitle,
      }).catch(() => {});
    }

    res.status(201).json(responseData);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function updateResponse(req, res) {
  try {
    const response = await feedbackService.updateResponse(
      Number(req.params.responseId),
      req.user.id,
      req.body
    );
    res.json(response);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function toggleResponseUpvote(req, res) {
  try {
    const result = await feedbackService.toggleResponseUpvote(
      req.user.id,
      Number(req.params.responseId)
    );

    if (result.upvoted) {
      // Use feedbackService.getUserById to fetch the critic's email —
      // same pattern as snippetController using snippetService.getUserById.
      if (result.criticId && result.criticId !== req.user.id) {
        feedbackService.getUserById(result.criticId).then((critic) => {
          if (!critic) return;
          const message = `${req.user.username ?? "Someone"} upvoted your critique on "${result.submissionTitle ?? "a submission"}"`;
          const link    = `/critique/${result.submissionId}#critique-${req.params.responseId}`;
          notifyUser(critic, message, link, null, "GENERAL", {
            kind: "reaction", title: result.submissionTitle,
          }).catch(() => {});
        }).catch(() => {});
      }

      // Tier upgrade notification
      if (result.walletBefore && result.walletAfter && result.criticId) {
        const newTier = pointsService.detectTierChange(
          result.walletBefore.reputation,
          result.walletAfter.reputation
        );
        if (newTier) {
          feedbackService.getUserById(result.criticId).then((critic) => {
            if (!critic) return;
            const oldTierName = pointsService.getTier(result.walletBefore.reputation).name;
            const message     = `Congratulations! You've been promoted from ${oldTierName} to ${newTier.name}!`;
            const link        = `/profile/${critic.username}`;
            notifyUser(critic, message, link, "feedback_critique_upvoted").catch(() => {});
          }).catch(() => {});
        }
      }
    }

    res.json({ upvoted: result.upvoted });
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// ─── PARAGRAPH COMMENTS ──────────────────────────────────────────────────────

async function createParagraphComment(req, res) {
  try {
    const comment = await feedbackService.createParagraphComment(
      req.user.id,
      Number(req.params.id),
      req.body
    );

    // The service now returns submissionAuthor: { id, username, email } directly —
    // no extra DB call needed in the controller.
    const { submissionAuthor, submissionTitle, commenterName, ...commentData } = comment;
    if (submissionAuthor && submissionAuthor.id !== req.user.id) {
      const message = `${commenterName} commented on paragraph ${req.body.paragraphIndex + 1} of your submission: "${submissionTitle ?? ""}"`;
      const link    = `/critique/${req.params.id}#paragraph-${req.body.paragraphIndex + 1}`;
      notifyUser(submissionAuthor, message, link, "feedback_paragraph_comment").catch(() => {});
    }

    res.status(201).json(commentData);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

// GET /submissions/:id/comments?paragraphIndex=0
async function getParagraphComments(req, res) {
  try {
    const paragraphIndex =
      req.query.paragraphIndex !== undefined ? Number(req.query.paragraphIndex) : null;
    const comments = await feedbackService.getParagraphComments(
      Number(req.params.id),
      paragraphIndex,
      req.user?.id ?? null
    );
    res.json(comments);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function updateParagraphComment(req, res) {
  try {
    const comment = await feedbackService.updateParagraphComment(
      Number(req.params.commentId),
      req.user.id,
      req.body.content
    );
    res.json(comment);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function deleteParagraphComment(req, res) {
  try {
    const result = await feedbackService.deleteParagraphComment(
      Number(req.params.commentId),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function toggleParagraphCommentUpvote(req, res) {
  try {
    const result = await feedbackService.toggleParagraphCommentUpvote(
      req.user.id,
      Number(req.params.commentId)
    );

    if (result.upvoted && result.awarded) {
      // Use feedbackService.getUserById — same pattern as snippetController
      if (result.commentAuthorId && result.commentAuthorId !== req.user.id) {
        feedbackService.getUserById(result.commentAuthorId).then((commentAuthor) => {
          if (!commentAuthor) return;
          const paraLabel = typeof result.paragraphIndex === "number" ? ` on paragraph ${result.paragraphIndex + 1}` : "";
          const message = `Your comment${paraLabel} in "${result.submissionTitle ?? "a submission"}" reached ${result.newTotal} upvotes — you earned ${result.pointsAwarded} points!`;
          const link    = `/critique/${result.submissionId}`;
          notifyUser(commentAuthor, message, link, null, "GENERAL", {
            kind: "reaction", title: result.submissionTitle,
          }).catch(() => {});
        }).catch(() => {});
      }

      // Tier upgrade notification
      if (result.walletBefore && result.walletAfter && result.commentAuthorId) {
        const newTier = pointsService.detectTierChange(
          result.walletBefore.reputation,
          result.walletAfter.reputation
        );
        if (newTier) {
          feedbackService.getUserById(result.commentAuthorId).then((commentAuthor) => {
            if (!commentAuthor) return;
            const oldTierName = pointsService.getTier(result.walletBefore.reputation).name;
            const message     = `Congratulations! You've been promoted from ${oldTierName} to ${newTier.name}!`;
            const link        = `/profile/${commentAuthor.username}`;
            notifyUser(commentAuthor, message, link, "feedback_comment_milestone").catch(() => {});
          }).catch(() => {});
        }
      }
    }

    res.json({ upvoted: result.upvoted, awarded: result.awarded, pointsAwarded: result.pointsAwarded });
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function createParagraphCommentReply(req, res) {
  try {
    const reply = await feedbackService.createParagraphCommentReply(
      req.user.id,
      Number(req.params.commentId),
      req.body.content
    );

    // The service now returns commentAuthor: { id, username, email } directly —
    // no extra DB call needed in the controller.
    const { commentAuthor, submissionId, submissionTitle, replierName, paragraphIndex, ...replyData } = reply;
    if (commentAuthor && commentAuthor.id !== req.user.id) {
      const paraLabel = typeof paragraphIndex === "number" ? ` on paragraph ${paragraphIndex + 1}` : "";
      const message = `${replierName} replied to your comment${paraLabel} in "${submissionTitle ?? "a submission"}"`;
      const link    = typeof paragraphIndex === "number" ? `/critique/${submissionId}#paragraph-${paragraphIndex + 1}` : `/critique/${submissionId}`;
      notifyUser(commentAuthor, message, link, "feedback_paragraph_reply").catch(() => {});
    }

    res.status(201).json(replyData);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function deleteParagraphCommentReply(req, res) {
  try {
    const result = await feedbackService.deleteParagraphCommentReply(
      Number(req.params.replyId),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    res.status(errStatus(err.message)).json({ message: err.message });
  }
}

async function getResponsesByUser(req, res) {
  try {
    const { page = 1, limit = 10 } = req.query;
    const result = await feedbackService.getResponsesByUser(
      Number(req.params.userId),
      { page: Number(page), limit: Math.min(Number(limit), 50) }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  getResponsesByUser,
  getMyWallet,
  getUserWallet,
  createSubmission,
  getSubmissions,
  getSubmissionById,
  getUserSubmissions,
  updateSubmission,
  deleteSubmission,
  getSpotlight,
  getQueue,
  getArchive,
  getArchiveGenres,
  getQueueGenres,
  createResponse,
  updateResponse,
  toggleResponseUpvote,
  createParagraphComment,
  getParagraphComments,
  updateParagraphComment,
  deleteParagraphComment,
  toggleParagraphCommentUpvote,
  createParagraphCommentReply,
  deleteParagraphCommentReply,
};