const path = require("path");
const https = require("https");
const { Pool } = require("pg");

const envFile = process.env.NODE_ENV === "production" ? ".env_produccion" : ".env";
require("dotenv").config({ path: path.resolve(process.cwd(), envFile) });

const {
  AZURE_TENANT_ID,
  AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET,
  AZURE_GROUP_ID
} = process.env;

if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET || !AZURE_GROUP_ID) {
  console.error("Faltan variables AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_GROUP_ID");
  process.exit(1);
}

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT
});

function httpsRequest({ hostname, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data || "{}"));
          } catch (e) {
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

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id: AZURE_CLIENT_ID,
    client_secret: AZURE_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  }).toString();

  const res = await httpsRequest({
    hostname: "login.microsoftonline.com",
    path: `/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  return res.access_token;
}

async function fetchGroupMembers(accessToken) {
  const members = [];
  let path = `/v1.0/groups/${AZURE_GROUP_ID}/members?$select=id,displayName,mail,userPrincipalName,mobilePhone`;

  while (path) {
    const res = await httpsRequest({
      hostname: "graph.microsoft.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const batch = Array.isArray(res.value) ? res.value : [];
    members.push(...batch);

    const nextLink = res["@odata.nextLink"];
    if (nextLink) {
      const url = new URL(nextLink);
      path = url.pathname + url.search;
    } else {
      path = null;
    }
  }

  return members;
}

async function getRoleConsultorId() {
  const res = await pool.query(
    "SELECT id FROM roles WHERE LOWER(titulo) = LOWER('Consultor') LIMIT 1"
  );
  return res.rows[0]?.id || null;
}

async function upsertUser({ oid, email, displayName, mobilePhone, rolId }) {
  const existing = await pool.query(
    `SELECT id FROM usuarios WHERE (azure_oid = $1 OR email = $2) AND activo = true LIMIT 1`,
    [oid, email]
  );

  if (existing.rows.length > 0) {
    const id = existing.rows[0].id;
    await pool.query(
      `UPDATE usuarios
       SET nombre_usuario = COALESCE($1, nombre_usuario),
           email = COALESCE($2, email),
           telefono = COALESCE($3, telefono),
           azure_oid = COALESCE($4, azure_oid),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [displayName, email, mobilePhone, oid, id]
    );
    return { action: "updated" };
  }

  await pool.query(
    `INSERT INTO usuarios
      (nombre_usuario, email, rol_usuario_id, activo, telefono, created_by, azure_oid)
     VALUES ($1, $2, $3, true, $4, 'ms_sso_sync', $5)`,
    [displayName, email, rolId, mobilePhone, oid]
  );
  return { action: "inserted" };
}

async function main() {
  const accessToken = await getAccessToken();
  const members = await fetchGroupMembers(accessToken);
  const rolId = await getRoleConsultorId();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const m of members) {
    const email = m.mail || m.userPrincipalName || "";
    if (!m.id || !email) {
      skipped += 1;
      continue;
    }
    const result = await upsertUser({
      oid: m.id,
      email,
      displayName: m.displayName || email,
      mobilePhone: m.mobilePhone || null,
      rolId
    });
    if (result.action === "inserted") inserted += 1;
    if (result.action === "updated") updated += 1;
  }

  console.log(`Sync terminado. insertados=${inserted} actualizados=${updated} omitidos=${skipped}`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("Error en sync:", err.message);
  try {
    await pool.end();
  } catch (e) {
    // ignore
  }
  process.exit(1);
});
