const nodemailer = require("nodemailer");

const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || "true").toLowerCase() === "true";
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM || "no-reply@local.dev";
const EMAIL_HOST = process.env.EMAIL_HOST || process.env.SMTP_HOST || "maildev";
const EMAIL_PORT = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 1025);
const EMAIL_SECURE = String(process.env.EMAIL_SECURE || "false").toLowerCase() === "true";
const EMAIL_USER = process.env.EMAIL_USER || process.env.SMTP_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || process.env.SMTP_PASS || "";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE,
    auth: EMAIL_USER ? { user: EMAIL_USER, pass: EMAIL_PASS } : undefined
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text, cc, bcc }) {
  if (!EMAIL_ENABLED) {
    console.log("[email] disabled", { to, subject });
    return;
  }
  if (!to) {
    console.log("[email] missing recipient", { subject });
    return;
  }
  const transport = getTransporter();
  await transport.sendMail({
    from: EMAIL_FROM,
    to,
    cc,
    bcc,
    subject: subject || "Notificación",
    text,
    html
  });
}

module.exports = { sendEmail };
