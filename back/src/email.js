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

function buildGraphPayload({ to, subject, html, text, cc, bcc }) {
  const toRecipients = buildRecipients(to);
  if (!toRecipients.length) {
    throw new Error("Missing recipients for Graph email");
  }
  return {
    message: {
      subject: subject || "Notification",
      body: {
        contentType: html ? "HTML" : "Text",
        content: html || text || "Notification"
      },
      toRecipients,
      ccRecipients: buildRecipients(cc),
      bccRecipients: buildRecipients(bcc)
    },
    saveToSentItems: "true"
  };
}

async function sendEmailViaGraphDelegated({ to, subject, html, text, cc, bcc, graphAccessToken }) {
  if (!graphAccessToken) {
    throw new Error("Missing delegated Graph access token");
  }

  const payload = buildGraphPayload({ to, subject, html, text, cc, bcc });
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

async function sendEmailViaGraphApp({ to, subject, html, text, cc, bcc, graphUserEmail }) {
  const senderUser = resolveGraphSenderUser(graphUserEmail);
  if (!senderUser) {
    throw new Error("GRAPH_SENDER_USER is not configured and graphUserEmail is missing");
  }

  const token = await getGraphAccessToken();
  const payload = buildGraphPayload({ to, subject, html, text, cc, bcc });

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

async function sendEmailViaSmtp({ to, subject, html, text, cc, bcc }) {
  const transport = getTransporter();
  await transport.sendMail({
    from: EMAIL_FROM,
    to,
    cc,
    bcc,
    subject: subject || "Notification",
    text,
    html
  });
}

async function sendEmail({ to, subject, html, text, cc, bcc, graphAccessToken, graphUserEmail }) {
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
      await sendEmailViaGraphDelegated({ to, subject, html, text, cc, bcc, graphAccessToken });
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
      await sendEmailViaGraphApp({ to, subject, html, text, cc, bcc, graphUserEmail });
      return;
    } catch (err) {
      if (!EMAIL_FALLBACK_SMTP) throw err;
      console.error("[email] graph failed, fallback smtp:", err.message);
    }
  }

  await sendEmailViaSmtp({ to, subject, html, text, cc, bcc });
}

module.exports = { sendEmail, getGraphAccessToken };

