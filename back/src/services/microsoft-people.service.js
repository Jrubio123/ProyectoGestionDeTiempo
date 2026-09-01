const https = require("https");
const { getGraphAccessToken } = require("../email");

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` }
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Microsoft Graph respondió ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.details = body.slice(0, 500);
          return reject(error);
        }
        try {
          return resolve(JSON.parse(body || "{}"));
        } catch (_) {
          return resolve({});
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function escapeOData(value) {
  return String(value || "").replace(/'/g, "''");
}

function mapMicrosoftPerson(user) {
  if (!user) return null;
  const email = String(user.mail || user.userPrincipalName || "").trim().toLowerCase();
  if (!email) return null;
  return {
    origen: "microsoft365",
    azure_oid: user.id || null,
    nombre: user.displayName || email,
    email,
    cargo: user.jobTitle || null,
    telefono: user.mobilePhone || user.businessPhones?.[0] || null
  };
}

async function searchMicrosoftPeople(query, limit = 10) {
  const text = String(query || "").trim();
  if (text.length < 2) return [];
  const token = await getGraphAccessToken();
  const filter = ["displayName", "mail", "userPrincipalName"]
    .map((field) => `startsWith(${field},'${escapeOData(text)}')`)
    .join(" or ");
  const select = "id,displayName,mail,userPrincipalName,jobTitle,mobilePhone,businessPhones,accountEnabled";
  const path = `/v1.0/users?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select)}&$top=${Math.min(limit, 25)}`;
  const result = await graphGet(path, token);
  return (result.value || [])
    .filter((user) => user.accountEnabled !== false)
    .map(mapMicrosoftPerson)
    .filter(Boolean);
}

async function getMicrosoftPerson(reference) {
  const raw = String(reference || "").trim();
  if (!raw) return null;
  const token = await getGraphAccessToken();
  const select = "id,displayName,mail,userPrincipalName,jobTitle,mobilePhone,businessPhones,accountEnabled";
  try {
    const result = await graphGet(
      `/v1.0/users/${encodeURIComponent(raw)}?$select=${encodeURIComponent(select)}`,
      token
    );
    if (result.accountEnabled === false) return null;
    return mapMicrosoftPerson(result);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function getMicrosoftManager(reference) {
  const raw = String(reference || "").trim();
  if (!raw) return null;
  const token = await getGraphAccessToken();
  const select = "id,displayName,mail,userPrincipalName,jobTitle,mobilePhone,businessPhones,accountEnabled";
  try {
    const result = await graphGet(
      `/v1.0/users/${encodeURIComponent(raw)}/manager?$select=${encodeURIComponent(select)}`,
      token
    );
    if (result.accountEnabled === false) return null;
    return mapMicrosoftPerson(result);
  } catch (error) {
    if ([400, 404].includes(error.statusCode)) return null;
    throw error;
  }
}

module.exports = {
  getMicrosoftManager,
  getMicrosoftPerson,
  mapMicrosoftPerson,
  searchMicrosoftPeople
};
