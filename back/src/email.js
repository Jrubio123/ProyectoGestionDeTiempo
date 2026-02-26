const https = require("https");
const querystring = require("querystring");
const nodemailer = require("nodemailer");

const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || "true").toLowerCase() === "true";
const HAS_GRAPH_CREDS = Boolean(
  process.env.AZURE_TENANT_ID &&
  process.env.AZURE_CLIENT_ID &&
  process.env.AZURE_CLIENT_SECRET
);
const EMAIL_PROVIDER = String(
  process.env.EMAIL_PROVIDER || (HAS_GRAPH_CREDS ? "graph" : "smtp")
).toLowerCase();
const EMAIL_FALLBACK_SMTP = String(process.env.EMAIL_FALLBACK_SMTP || "false").toLowerCase() === "true";
const GRAPH_ALLOW_APP_FALLBACK = String(process.env.GRAPH_ALLOW_APP_FALLBACK || "false").toLowerCase() === "true";

const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_FROM || "no-reply@local.dev";
const EMAIL_HOST = process.env.EMAIL_HOST || process.env.SMTP_HOST || "maildev";
const EMAIL_PORT = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 1025);
const EMAIL_SECURE = String(process.env.EMAIL_SECURE || "false").toLowerCase() === "true";
const EMAIL_USER = process.env.EMAIL_USER || process.env.SMTP_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || process.env.SMTP_PASS || "";

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "";
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "";
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || "";
const GRAPH_SENDER_USER =
  process.env.GRAPH_SENDER_USER ||
  process.env.EMAIL_FROM ||
  "";

let transporter = null;
let graphTokenCache = {
  token: null,
  expiresAt: 0
};

function splitEmails(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap(splitEmails);
  return String(input)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildRecipients(input) {
  return splitEmails(input).map((address) => ({
    emailAddress: { address }
  }));
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  const normalized = [];

  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;

    const fileName = String(item.filename || item.name || `adjunto-${i + 1}.bin`).trim();
    if (!fileName) continue;

    const contentType = String(item.contentType || item.content_type || "application/octet-stream").trim();
    let base64 = "";

    if (item.contentBase64) {
      base64 = String(item.contentBase64).replace(/\s+/g, "").trim();
    } else if (Buffer.isBuffer(item.content)) {
      base64 = item.content.toString("base64");
    } else if (typeof item.content === "string") {
      if (String(item.encoding || "").toLowerCase() === "base64") {
        base64 = item.content.replace(/\s+/g, "").trim();
      } else {
        base64 = Buffer.from(item.content, "utf8").toString("base64");
      }
    }

    if (!base64) continue;
    normalized.push({
      filename: fileName,
      contentType,
      contentBase64: base64
    });
  }

  return normalized;
}

function requestJson({ hostname, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            return reject(
              new Error("HTTP " + res.statusCode + " " + method + " " + hostname + path + ": " + data)
            );
          }
          if (!data) return resolve({});
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            resolve({});
          }
        });
      }
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getGraphAccessToken() {
  const now = Date.now();
  if (graphTokenCache.token && now < graphTokenCache.expiresAt - 60_000) {
    return graphTokenCache.token;
  }

  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error("Missing Azure credentials for Graph (tenant/client/secret)");
  }

  const form = querystring.stringify({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });

  const tokenRes = await requestJson({
    hostname: "login.microsoftonline.com",
    path: `/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(form)
    },
    body: form
  });

  if (!tokenRes.access_token) {
    throw new Error("No Graph access_token received");
  }

  graphTokenCache = {
    token: tokenRes.access_token,
    expiresAt: now + Number(tokenRes.expires_in || 3600) * 1000
  };

  return graphTokenCache.token;
}

function buildGraphPayload({ to, subject, html, text, cc, bcc, attachments }) {
  const toRecipients = buildRecipients(to);
  if (!toRecipients.length) {
    throw new Error("Missing recipients for Graph email");
  }
  const normalizedAttachments = normalizeAttachments(attachments);
  const graphAttachments = normalizedAttachments.map((item) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: item.filename,
    contentType: item.contentType,
    contentBytes: item.contentBase64
  }));

  const message = {
    subject: subject || "Notification",
    body: {
      contentType: html ? "HTML" : "Text",
      content: html || text || "Notification"
    },
    toRecipients,
    ccRecipients: buildRecipients(cc),
    bccRecipients: buildRecipients(bcc)
  };
  if (graphAttachments.length > 0) {
    message.attachments = graphAttachments;
  }

  return {
    message,
    saveToSentItems: "true"
  };
}

async function sendEmailViaGraphDelegated({ to, subject, html, text, cc, bcc, attachments, graphAccessToken }) {
  if (!graphAccessToken) {
    throw new Error("Missing delegated Graph access token");
  }

  const payload = buildGraphPayload({ to, subject, html, text, cc, bcc, attachments });
  const body = JSON.stringify(payload);
  await requestJson({
    hostname: "graph.microsoft.com",
    path: "/v1.0/me/sendMail",
    method: "POST",
    headers: {
      Authorization: `Bearer ${graphAccessToken}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });
}

function resolveGraphSenderUser(graphUserEmail) {
  const preferred = String(graphUserEmail || "").trim();
  if (preferred) return preferred;
  const fallback = String(GRAPH_SENDER_USER || "").trim();
  if (fallback) return fallback;
  return "";
}

async function sendEmailViaGraphApp({ to, subject, html, text, cc, bcc, attachments, graphUserEmail }) {
  const senderUser = resolveGraphSenderUser(graphUserEmail);
  if (!senderUser) {
    throw new Error("GRAPH_SENDER_USER is not configured and graphUserEmail is missing");
  }

  const token = await getGraphAccessToken();
  const payload = buildGraphPayload({ to, subject, html, text, cc, bcc, attachments });

  const body = JSON.stringify(payload);
  await requestJson({
    hostname: "graph.microsoft.com",
    path: `/v1.0/users/${encodeURIComponent(senderUser)}/sendMail`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });
}

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

async function sendEmailViaSmtp({ to, subject, html, text, cc, bcc, attachments }) {
  const normalizedAttachments = normalizeAttachments(attachments);
  const transport = getTransporter();
  await transport.sendMail({
    from: EMAIL_FROM,
    to,
    cc,
    bcc,
    subject: subject || "Notification",
    text,
    html,
    attachments: normalizedAttachments.map((item) => ({
      filename: item.filename,
      content: Buffer.from(item.contentBase64, "base64"),
      contentType: item.contentType
    }))
  });
}

async function sendEmail({ to, subject, html, text, cc, bcc, attachments, graphAccessToken, graphUserEmail }) {
  if (!EMAIL_ENABLED) {
    console.log("[email] disabled", { to, subject });
    return;
  }
  if (!to) {
    console.log("[email] missing recipient", { subject });
    return;
  }

  if (graphAccessToken) {
    try {
      await sendEmailViaGraphDelegated({ to, subject, html, text, cc, bcc, attachments, graphAccessToken });
      return;
    } catch (err) {
      if (!EMAIL_FALLBACK_SMTP && !GRAPH_ALLOW_APP_FALLBACK && EMAIL_PROVIDER !== "smtp") {
        throw err;
      }
      console.error("[email] graph delegated failed:", err.message);
    }
  }

  if (EMAIL_PROVIDER === "graph") {
    if (!GRAPH_ALLOW_APP_FALLBACK) {
      throw new Error("Graph delegated token is required (set GRAPH_ALLOW_APP_FALLBACK=true to allow app sender)");
    }
    try {
      await sendEmailViaGraphApp({ to, subject, html, text, cc, bcc, attachments, graphUserEmail });
      return;
    } catch (err) {
      if (!EMAIL_FALLBACK_SMTP) throw err;
      console.error("[email] graph failed, fallback smtp:", err.message);
    }
  }

  await sendEmailViaSmtp({ to, subject, html, text, cc, bcc, attachments });
}

module.exports = { sendEmail, getGraphAccessToken };

