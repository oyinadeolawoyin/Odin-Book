require('dotenv').config();
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: "Oyinade from Quillweave <no-reply@inkwell.com.ng>", // must be verified in Resend
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error("Email error:", err);
  }
}

module.exports = { sendEmail };