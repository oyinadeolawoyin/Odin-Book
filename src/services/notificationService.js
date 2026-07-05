/**
 * Notification Service
 * 
 * Handles multi-channel notification delivery:
 * - In-app notifications (database)
 * - Web push notifications
 * - Email notifications
 * 
 * Manages notification subscriptions and retrieval
 */

require('dotenv').config();
const webpush = require("web-push");
const { sendEmail } = require("../config/mailer");
const prisma = require("../config/prismaClient");

// ==================== Configuration ====================

/**
 * Configure VAPID details for web push notifications
 */
webpush.setVapidDetails(
  "mailto:oyinadeolawoyin@gmail.com",
  process.env.PUBLIC_KEY,
  process.env.PRIVATE_KEY
);

// ==================== Push Notification Helpers ====================

/**
 * Send a web push notification to a specific subscription
 * @param {Object} subscription - Push subscription object
 * @param {Object} payload - Notification payload
 * @param {string} payload.title - Notification title
 * @param {string} payload.body - Notification body text
 * @param {string} payload.url - URL to open when clicked
 * @private
 */
async function sendPushNotification(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (err) {
    console.error("Push notification error:", err);
  }
}

// ==================== Unified Notification System ====================

/**
 * Create a notification for a user
 * @param {Object} notificationData - Notification data
 * @param {string} notificationData.username - Username of recipient
 * @param {string} notificationData.link - URL link for notification
 * @param {string} notificationData.message - Notification message
 * @param {number} notificationData.userId - User ID of recipient
 * @param {string} [notificationData.type] - NotificationType enum value (defaults to GENERAL)
 * @returns {Promise<Object>} Created notification object
 */
async function addNotification({ username, link, message, userId, type }) {
  return await prisma.notification.create({
    data: {
      username,
      message,
      link,
      userId,
      ...(type && { type }),
    }
  });
}

async function getUserSubscriptions(userId) {
  return await prisma.subscription.findMany({
    where: { userId },
  });
}

// ==================== Email Template ====================

/**
 * Strip HTML tags and collapse whitespace — used to turn rich post/thread
 * content into a safe plain-text excerpt for email.
 */
function stripHtml(html = "") {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Trim a block of (possibly HTML) content down to a short excerpt.
 */
function getExcerpt(content = "", length = 160) {
  const text = stripHtml(content);
  return text.length > length ? `${text.slice(0, length).trim()}…` : text;
}

// Per-kind copy: eyebrow label + default CTA text. `title` and `excerpt`
// (passed via the `extra` param on notifyUser) slot into the layout below.
const EMAIL_KIND_COPY = {
  community_update: { eyebrow: "Community update", ctaLabel: "Read the full post" },
  new_thread:        { eyebrow: "New thread",        ctaLabel: "Join the discussion" },
  new_submission:    { eyebrow: "New submission",    ctaLabel: "Give feedback" },
  reaction:          { eyebrow: "New reaction",       ctaLabel: "See the reaction" },
  direct_message:    { eyebrow: "New message",        ctaLabel: "Reply now" },
  challenge_update:  { eyebrow: "Challenge update",   ctaLabel: "See who's writing" },
  challenge_reminder:{ eyebrow: "Reminder",           ctaLabel: "Log your progress" },
  new_event:         { eyebrow: "New event",          ctaLabel: "Join the event" },
  event_badge:       { eyebrow: "Badge earned",       ctaLabel: "View your badge" },
  default:           { eyebrow: "Notification",      ctaLabel: "View on Quillweave" },
};

/**
 * Build the full branded HTML email body.
 *
 * @param {Object} opts
 * @param {string} opts.kind      - "community_update" | "new_thread" | "new_submission" | undefined
 * @param {string} opts.message   - Fallback / supporting body text
 * @param {string} [opts.title]   - Post / thread / submission title, shown as a heading
 * @param {string} [opts.excerpt] - Short excerpt shown under the title (auto-truncated)
 * @param {string} [opts.ctaLabel]- Overrides the default button text for this kind
 * @param {string} opts.fullLink  - Absolute URL the button/CTA points to
 */
function buildEmailHtml({ kind, message, title, excerpt, ctaLabel, fullLink }) {
  const copy = EMAIL_KIND_COPY[kind] || EMAIL_KIND_COPY.default;
  const buttonLabel = ctaLabel || copy.ctaLabel;

  const bodyText = excerpt ? getExcerpt(excerpt) : message;
  const titleHtml = title
    ? `<h1 style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.35;color:#1a1a2e;">${title}</h1>`
    : "";
  const messageHtml = title && excerpt
    ? `<p style="margin:0 0 22px;font-size:13px;line-height:1.5;color:#7a6a50;">${message}</p>`
    : "";

  return `
<div style="background:#f5f0e8;padding:32px 16px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e8dcc8;">
    <tr>
      <td style="height:4px;line-height:4px;font-size:0;background:linear-gradient(90deg,#d4af37 0%,#f3dea0 50%,#d4af37 100%);">&nbsp;</td>
    </tr>
    <tr>
      <td style="background:#1a1a2e;padding:20px 28px;">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:19px;font-weight:700;color:#ffffff;">Quill<span style="color:#d4af37;">weave</span></span>
      </td>
    </tr>
    <tr>
      <td style="padding:32px 28px 8px;">
        <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#b8860b;">${copy.eyebrow}</p>
        ${titleHtml}
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d3d3a;">${bodyText}</p>
        ${messageHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:0 28px 32px;">
        <a href="${fullLink}" style="display:inline-block;background:#1a1a2e;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 26px;border-radius:8px;">${buttonLabel}</a>
      </td>
    </tr>
    <tr>
      <td style="background:#faf7f2;padding:16px 28px;border-top:1px solid #e8dcc8;">
        <p style="margin:0;font-size:12px;color:#9a8c7a;">You're receiving this because you're part of the Quillweave community. You can adjust what you get notified about anytime in your notification settings.</p>
      </td>
    </tr>
  </table>
</div>`.trim();
}

/**
 * Build a subject line that matches the email body — falls back to a
 * truncated version of `message` when there's no title to work with.
 */
function buildEmailSubject({ kind, title, message }) {
  const copy = EMAIL_KIND_COPY[kind] || EMAIL_KIND_COPY.default;
  if (title) return `${copy.eyebrow}: ${title}`;
  return message.length > 70 ? `${message.slice(0, 70).trim()}…` : message;
}



/**
 * Fetch a user's notification preferences JSON blob
 */
async function fetchPreferences(userId) {
  return await prisma.notificationPreference.findUnique({
    where: { userId: Number(userId) },
  });
}

/**
 * Upsert a user's notification preferences
 */
async function savePreferences(userId, preferences) {
  return await prisma.notificationPreference.upsert({
    where: { userId: Number(userId) },
    update: { preferences },
    create: { userId: Number(userId), preferences },
  });
}

// ==================== Preference-Aware notifyUser ====================

// Types that have their own dedicated page + sidebar badge (Messages,
// Community Updates) instead of the bell/inbox page. For these we still
// want push + email to respect preferences, but we never want a row to
// show up in the main notifications list — that would just duplicate what
// the dedicated page already shows.
const INBOX_EXCLUDED_TYPES = new Set(["MESSAGE", "COMMUNITY_UPDATE"]);

// Preference keys that default to OFF for push/email unless the user has
// explicitly opted in (the opposite of notifyUser()'s normal "send
// everything unless told not to" default). Community updates go out to
// every user on the site per post, so unlike a single-recipient notice
// (a reply, a DM) this one should be opt-in, not opt-out.
const OPT_IN_REQUIRED_KEYS = new Set(["community_new_post"]);

/**
 * Notify a user through multiple channels, respecting their preferences.
 *
 * @param {Object} user          - { id, username, email }
 * @param {string} message       - Notification message text
 * @param {string} link          - URL related to the notification
 * @param {string} [notifKey]    - Preference key (e.g. "discovery_story_liked").
 *                                  When omitted every channel fires (backward-compat).
 * @param {string} [type]        - NotificationType enum value, e.g. "MESSAGE",
 *                                  "COMMUNITY_UPDATE", "REACTION", "COMMENT",
 *                                  "CRITIQUE", "SYSTEM". Defaults to "GENERAL".
 *                                  MESSAGE and COMMUNITY_UPDATE never create an
 *                                  inbox row (see INBOX_EXCLUDED_TYPES) — they're
 *                                  represented by their own page + badge instead.
 * @param {Object} [extra]       - Optional richer content for the email template only
 *                                  (in-app/push still just use `message`).
 * @param {string} [extra.kind]     - "community_update" | "new_thread" | "new_submission".
 *                                     Selects which email layout to use; omit for a plain
 *                                     generic notification email.
 * @param {string} [extra.title]   - Post / thread / submission title — shown as a heading.
 * @param {string} [extra.excerpt] - Raw content to excerpt under the title (HTML is stripped
 *                                    and truncated automatically). For "new_thread" / "new_submission"
 *                                    you can skip this and just rely on `message` for the body copy.
 * @param {string} [extra.ctaLabel]- Overrides the default button text for the chosen kind.
 *
 * @example
 *   // Community update — shows an excerpt of the post
 *   notifyUser(user, "New post from the team", `/blog/${post.id}`, "community_new_post", "COMMUNITY_UPDATE", {
 *     kind: "community_update", title: post.title, excerpt: post.content,
 *   });
 *
 * @example
 *   // New thread — title + "Join the discussion"
 *   notifyUser(user, `${author.username} started a thread in ${category.name}`, `/forum/${thread.id}`, null, "COMMENT", {
 *     kind: "new_thread", title: thread.title,
 *   });
 *
 * @example
 *   // New submission — title + "Give feedback"
 *   notifyUser(user, `${wordCount.toLocaleString()} words · ${genre}`, `/feedback/${submission.id}`, null, "CRITIQUE", {
 *     kind: "new_submission", title: submission.title,
 *   });
 *
 * @example
 *   // Reaction (like/upvote) — encourages the recipient to go see it
 *   notifyUser(author, `${liker.username} liked your thread "${thread.title}".`, `/threads/${thread.id}`, "thread_like", "REACTION", {
 *     kind: "reaction", title: thread.title,
 *   });
 *
 * @example
 *   // Direct message — excerpt shows a snippet of the message itself
 *   notifyUser(recipient, `${sender.username} sent you a message`, `/messages/${conversationId}`, "direct_message", "MESSAGE", {
 *     kind: "direct_message", excerpt: message.content,
 *   });
 *
 * @example
 *   // Challenge/draft-plan progress or completion pings (days challenge, draft plan)
 *   notifyUser(u, `${req.user.username} just logged ${count} words on "${storyTitle}"`, `/days-challenge`, "dayschallenge_progress_logged", "GENERAL", {
 *     kind: "challenge_update", title: storyTitle,
 *   });
 *
 * @example
 *   // Daily writing reminder / nudge (days challenge, draft plan crons)
 *   notifyUser(w.user, `Log ${w.dailyGoal} words to keep your streak going`, `/days-challenge`, "dayschallenge_daily_reminder", "GENERAL", {
 *     kind: "challenge_reminder", title: w.storyTitle,
 *   });
 *
 * @example
 *   // New event announcement — title is the event's own title
 *   notifyUser(u, `New event: "${event.title}"`, `/events/${event.id}`, "event_new", "GENERAL", {
 *     kind: "new_event", title: event.title, excerpt: event.description,
 *   });
 *
 * @example
 *   // Event finisher badge
 *   notifyUser(user, `You completed "${event.title}" and earned the ${event.badgeName} badge!`, `/events/${eventId}`, "event_finisher", "GENERAL", {
 *     kind: "event_badge", title: event.badgeName,
 *   });
 */
async function notifyUser(user, message, link, notifKey = null, type = "GENERAL", extra = {}) {
  // Resolve channel permissions from saved preferences.
  // Opt-in-required keys (e.g. community_new_post) start with push/email OFF;
  // everything else starts ON. Either way, an explicit saved preference always
  // wins below.
  const optInRequired = notifKey && OPT_IN_REQUIRED_KEYS.has(notifKey);

  let allowInbox = true;
  let allowPush  = !optInRequired;
  let allowEmail = !optInRequired;

  if (notifKey) {
    try {
      const record = await fetchPreferences(user.id);
      if (record && record.preferences && record.preferences[notifKey]) {
        const p = record.preferences[notifKey];
        // Explicit true/false in the saved record always overrides the
        // default above; only an *absent* key falls back to the default.
        if (p.inbox !== undefined) allowInbox = p.inbox !== false;
        if (p.push  !== undefined) allowPush  = p.push  === true;
        if (p.email !== undefined) allowEmail = p.email === true;
      }
    } catch (err) {
      // If preference lookup fails, fall back to the safe default for this
      // key (opt-in keys stay off; everything else stays on).
      console.error("Preference lookup error:", err);
    }
  }

  // Types with their own dedicated page (Messages, Community Updates) never
  // get an inbox row, no matter what the saved preference says.
  if (INBOX_EXCLUDED_TYPES.has(type)) {
    allowInbox = false;
  }

  // 1. In-app inbox
  if (allowInbox) {
    await addNotification({
      username: user.username,
      message,
      link,
      userId: Number(user.id),
      type,
    });
  }

  // 2. Web push
  if (allowPush) {
    const subscriptions = await getUserSubscriptions(user.id);
    const payload = { title: "New Notification", body: message, url: link };
    subscriptions.forEach((sub) => sendPushNotification(sub.subscription, payload));
  }

  // 3. Email
  if (allowEmail) {
    const baseUrl = process.env.ALLOWED_ORIGIN; // e.g. https://quillweave.com or http://localhost:5173
    const fullLink = `${baseUrl}${link}`;       // e.g. https://quillweave.com/discovery/12
    const subject = buildEmailSubject({ kind: extra.kind, title: extra.title, message });
    const html = buildEmailHtml({ kind: extra.kind, message, title: extra.title, excerpt: extra.excerpt, ctaLabel: extra.ctaLabel, fullLink });
    await sendEmail(user.email, subject, html);
  }
}

// ==================== Subscription Management ====================

/**
 * Save a user's push notification subscription
 * @param {number} userId - User ID
 * @param {Object} subscription - Web push subscription object
 * @returns {Promise<void>}
 */
async function saveSubscription(userId, subscription) {
  const existing = await prisma.subscription.findFirst({
    where: { userId },
  });
  
  if (existing) {
    await prisma.subscription.update({
      where: { id: existing.id },
      data: { subscription },
    });
  } else {
    await prisma.subscription.create({
      data: { userId, subscription },
    });
  }  
}

// ==================== Notification Retrieval ====================


/**
 * Get all notifications for a user, for the main bell/inbox page.
 * Excludes MESSAGE and COMMUNITY_UPDATE types — those have their own
 * dedicated pages (Messages, Community Updates) and sidebar badges, so
 * showing them here too would just be duplicate noise. In practice
 * notifyUser() never writes those types to the inbox in the first place;
 * this filter is just a safety net.
 * @param {number} userId - User ID
 * @returns {Promise<Array>} Array of notification objects
 */
async function fetchNotifications(userId) {
  return await prisma.notification.findMany({
    where: {
      userId: Number(userId),
      type: { notIn: ["MESSAGE", "COMMUNITY_UPDATE"] },
    },
    orderBy: { id: "desc" } // Latest first
  });
}

/**
 * Mark all of a user's bell-page notifications as read.
 * Same type exclusion as fetchNotifications, so this only ever touches rows
 * the bell page actually shows — it can't silently flip the read state on
 * MESSAGE/COMMUNITY_UPDATE rows that belong to other pages.
 * @param {number} userId - User ID
 * @returns {Promise<Object>} Prisma batch update result
 */
async function markNotificationRead(userId) {
  return await prisma.notification.updateMany({
    where: {
      userId,
      read: false,
      type: { notIn: ["MESSAGE", "COMMUNITY_UPDATE"] },
    },
    data: { read: true },
  });
}

// ==================== Exports ====================

module.exports = {
  notifyUser,
  fetchPreferences,
  savePreferences,
  saveSubscription,
  fetchNotifications,
  markNotificationRead
};