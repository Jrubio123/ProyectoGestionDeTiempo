const https = require("https");

const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const tokenCache = {
  accessToken: null,
  expiresAt: 0
};

class AzureDevOpsError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "AzureDevOpsError";
    this.statusCode = statusCode;
  }
}

function getConfig() {
  const config = {
    tenantId: String(
      process.env.AZURE_DEVOPS_TENANT_ID || process.env.AZURE_TENANT_ID || ""
    ).trim(),
    clientId: String(
      process.env.AZURE_DEVOPS_CLIENT_ID || process.env.AZURE_CLIENT_ID || ""
    ).trim(),
    clientSecret: String(
      process.env.AZURE_DEVOPS_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET || ""
    ).trim(),
    organization: String(process.env.AZURE_DEVOPS_ORGANIZATION || "").trim()
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new AzureDevOpsError(
      `Configuración incompleta de Azure DevOps: ${missing.join(", ")}`,
      503
    );
  }

  return config;
}

function request({ hostname, path, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers,
        timeout: 15000
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (error) {
            data = null;
          }

          resolve({
            statusCode: Number(res.statusCode || 0),
            data,
            raw
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Tiempo de espera agotado consultando Microsoft"));
    });
    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

async function getAzureDevOpsAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const { tenantId, clientId, clientSecret } = getConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: AZURE_DEVOPS_SCOPE
  }).toString();

  const response = await request({
    hostname: "login.microsoftonline.com",
    path: `/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    },
    body
  });

  if (response.statusCode < 200 || response.statusCode >= 300 || !response.data?.access_token) {
    const detail =
      response.data?.error_description ||
      response.data?.error ||
      "No fue posible obtener el token de Entra ID";
    throw new AzureDevOpsError(detail, 502);
  }

  tokenCache.accessToken = response.data.access_token;
  tokenCache.expiresAt = now + Number(response.data.expires_in || 3600) * 1000;
  return tokenCache.accessToken;
}

function mapAzureDevOpsFailure(response) {
  if (response.statusCode === 401 || response.statusCode === 403) {
    return new AzureDevOpsError(
      "La aplicación de Entra ID no tiene acceso a la organización de Azure DevOps. Agrégala como usuario o identidad de servicio con permiso de lectura.",
      403
    );
  }

  if (response.statusCode === 404) {
    return new AzureDevOpsError(
      "No se encontró la organización o el proyecto configurado en Azure DevOps.",
      404
    );
  }

  const detail =
    response.data?.message ||
    response.data?.error?.message ||
    `Azure DevOps respondió HTTP ${response.statusCode}`;
  return new AzureDevOpsError(detail, 502);
}

async function azureDevOpsRequest(path, { method = "GET", body = null } = {}) {
  const accessToken = await getAzureDevOpsAccessToken();
  const payload = body ? JSON.stringify(body) : null;
  const response = await request({
    hostname: "dev.azure.com",
    path,
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        : {})
    },
    body: payload
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw mapAzureDevOpsFailure(response);
  }

  return response.data || {};
}

async function listProjects() {
  const { organization } = getConfig();
  const org = encodeURIComponent(organization);
  const data = await azureDevOpsRequest(
    `/${org}/_apis/projects?$top=100&stateFilter=wellFormed&api-version=7.1`
  );

  return {
    organization,
    count: Number(data.count || 0),
    projects: (data.value || []).map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description || "",
      state: project.state,
      visibility: project.visibility,
      lastUpdateTime: project.lastUpdateTime || null
    }))
  };
}

async function listRecentWorkItems(projectName) {
  const project = String(projectName || "").trim();
  if (!project) {
    throw new AzureDevOpsError("El proyecto es obligatorio.", 400);
  }

  const { organization } = getConfig();
  const org = encodeURIComponent(organization);
  const encodedProject = encodeURIComponent(project);
  const wiql = await azureDevOpsRequest(
    `/${org}/${encodedProject}/_apis/wit/wiql?$top=50&api-version=7.1`,
    {
      method: "POST",
      body: {
        query:
          "SELECT [System.Id] FROM WorkItems " +
          "WHERE [System.TeamProject] = @project " +
          "ORDER BY [System.ChangedDate] DESC"
      }
    }
  );

  const ids = (wiql.workItems || []).map((item) => item.id).filter(Boolean);
  if (ids.length === 0) {
    return { organization, project, count: 0, workItems: [] };
  }

  const fields = [
    "System.Id",
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "System.AssignedTo",
    "Microsoft.VSTS.Scheduling.Effort",
    "Microsoft.VSTS.Common.Priority",
    "System.AreaPath",
    "System.IterationPath",
    "System.CreatedDate",
    "System.ChangedDate"
  ].join(",");

  const detail = await azureDevOpsRequest(
    `/${org}/${encodedProject}/_apis/wit/workitems?ids=${ids.join(",")}` +
      `&fields=${encodeURIComponent(fields)}&api-version=7.1`
  );

  return {
    organization,
    project,
    count: Number(detail.count || 0),
    workItems: (detail.value || []).map((item) => {
      const assignedTo = item.fields?.["System.AssignedTo"];
      return {
        id: item.id,
        title: item.fields?.["System.Title"] || "",
        type: item.fields?.["System.WorkItemType"] || "",
        state: item.fields?.["System.State"] || "",
        effort: item.fields?.["Microsoft.VSTS.Scheduling.Effort"] ?? null,
        priority: item.fields?.["Microsoft.VSTS.Common.Priority"] ?? null,
        assignedTo:
          assignedTo?.displayName ||
          assignedTo?.uniqueName ||
          (typeof assignedTo === "string" ? assignedTo : ""),
        areaPath: item.fields?.["System.AreaPath"] || "",
        iterationPath: item.fields?.["System.IterationPath"] || "",
        createdDate: item.fields?.["System.CreatedDate"] || null,
        changedDate: item.fields?.["System.ChangedDate"] || null,
        url: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodedProject}/_workitems/edit/${item.id}`
      };
    })
  };
}

async function getProjects(req, res) {
  try {
    return res.json(await listProjects());
  } catch (error) {
    console.error("Error consultando proyectos Azure DevOps:", error.message);
    return res.status(error.statusCode || 500).json({
      error: error.message || "Error consultando Azure DevOps"
    });
  }
}

async function getRecentWorkItems(req, res) {
  try {
    return res.json(await listRecentWorkItems(req.query?.project));
  } catch (error) {
    console.error("Error consultando tareas Azure DevOps:", error.message);
    return res.status(error.statusCode || 500).json({
      error: error.message || "Error consultando Azure DevOps"
    });
  }
}

module.exports = {
  getProjects,
  getRecentWorkItems,
  listProjects,
  listRecentWorkItems
};
