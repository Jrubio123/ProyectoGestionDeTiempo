const https = require("https");

const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const DEFAULT_AZURE_DEVOPS_ORGANIZATION = "fabricadev";
const WORK_ITEMS_LIMIT = 200;
const WORK_ITEMS_ORGANIZATION_LIMIT = 20000;
const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.TeamProject",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "System.AssignedTo",
  "Microsoft.VSTS.Scheduling.Effort",
  "Microsoft.VSTS.Common.Priority",
  "System.AreaPath",
  "System.IterationPath",
  "System.CreatedDate",
  "System.ChangedDate",
  "Microsoft.VSTS.Scheduling.StartDate",
  "Microsoft.VSTS.Scheduling.TargetDate"
];
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
    tenantId: String(process.env.AZURE_DEVOPS_TENANT_ID || "").trim(),
    clientId: String(process.env.AZURE_DEVOPS_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.AZURE_DEVOPS_CLIENT_SECRET || "").trim(),
    organization: String(
      process.env.AZURE_DEVOPS_ORGANIZATION || DEFAULT_AZURE_DEVOPS_ORGANIZATION
    ).trim()
  };

  const variableNames = {
    tenantId: "AZURE_DEVOPS_TENANT_ID",
    clientId: "AZURE_DEVOPS_CLIENT_ID",
    clientSecret: "AZURE_DEVOPS_CLIENT_SECRET",
    organization: "AZURE_DEVOPS_ORGANIZATION"
  };
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => variableNames[key]);

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
    projects: (data.value || [])
      .map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description || "",
        state: project.state,
        visibility: project.visibility,
        lastUpdateTime: project.lastUpdateTime || null
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, "es", { sensitivity: "base" })
      )
  };
}

function mapWorkItem(item, organization, fallbackProject = "") {
  const assignedTo = item.fields?.["System.AssignedTo"];
  const project =
    item.fields?.["System.TeamProject"] ||
    fallbackProject ||
    "";
  const encodedProject = encodeURIComponent(project);

  return {
    id: item.id,
    project,
    title: item.fields?.["System.Title"] || "",
    type: item.fields?.["System.WorkItemType"] || "",
    state: item.fields?.["System.State"] || "",
    effort: item.fields?.["Microsoft.VSTS.Scheduling.Effort"] ?? null,
    priority: item.fields?.["Microsoft.VSTS.Common.Priority"] ?? null,
    assignedTo:
      assignedTo?.displayName ||
      assignedTo?.uniqueName ||
      (typeof assignedTo === "string" ? assignedTo : ""),
    assignedToId: assignedTo?.id || "",
    assignedToEmail: assignedTo?.uniqueName || "",
    assignedToDescriptor: assignedTo?.descriptor || "",
    areaPath: item.fields?.["System.AreaPath"] || "",
    iterationPath: item.fields?.["System.IterationPath"] || "",
    createdDate: item.fields?.["System.CreatedDate"] || null,
    changedDate: item.fields?.["System.ChangedDate"] || null,
    startDate: item.fields?.["Microsoft.VSTS.Scheduling.StartDate"] || null,
    targetDate: item.fields?.["Microsoft.VSTS.Scheduling.TargetDate"] || null,
    url: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodedProject}/_workitems/edit/${item.id}`
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
    `/${org}/${encodedProject}/_apis/wit/wiql?$top=${WORK_ITEMS_LIMIT}&api-version=7.1`,
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

  const fields = WORK_ITEM_FIELDS.join(",");

  const detail = await azureDevOpsRequest(
    `/${org}/${encodedProject}/_apis/wit/workitems?ids=${ids.join(",")}` +
      `&fields=${encodeURIComponent(fields)}&api-version=7.1`
  );

  return {
    organization,
    project,
    count: Number(detail.count || 0),
    workItems: (detail.value || []).map((item) =>
      mapWorkItem(item, organization, project)
    )
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function listRecentWorkItemsAllProjects() {
  const projectData = await listProjects();
  if (projectData.projects.length === 0) {
    return {
      organization: projectData.organization,
      project: "__all__",
      projectCount: 0,
      count: 0,
      workItems: []
    };
  }

  const { organization } = projectData;
  const org = encodeURIComponent(organization);
  const organizationLimit = Math.min(
    WORK_ITEMS_LIMIT * projectData.projects.length,
    WORK_ITEMS_ORGANIZATION_LIMIT
  );
  const wiql = await azureDevOpsRequest(
    `/${org}/_apis/wit/wiql?$top=${organizationLimit}&api-version=7.1`,
    {
      method: "POST",
      body: {
        query:
          "SELECT [System.Id] FROM WorkItems " +
          "ORDER BY [System.ChangedDate] DESC"
      }
    }
  );

  const ids = (wiql.workItems || []).map((item) => item.id).filter(Boolean);
  const batches = [];
  for (let index = 0; index < ids.length; index += WORK_ITEMS_LIMIT) {
    batches.push(ids.slice(index, index + WORK_ITEMS_LIMIT));
  }

  const fields = WORK_ITEM_FIELDS.join(",");
  const detailResults = await mapWithConcurrency(
    batches,
    4,
    (batch) =>
      azureDevOpsRequest(
        `/${org}/_apis/wit/workitems?ids=${batch.join(",")}` +
          `&fields=${encodeURIComponent(fields)}&errorPolicy=omit&api-version=7.1`
      )
  );
  const workItems = detailResults
    .flatMap((result) => result.value || [])
    .map((item) => mapWorkItem(item, organization))
    .sort((left, right) => {
      const leftDate = left.changedDate ? new Date(left.changedDate).getTime() : 0;
      const rightDate = right.changedDate ? new Date(right.changedDate).getTime() : 0;
      return rightDate - leftDate;
    });

  return {
    organization: projectData.organization,
    project: "__all__",
    projectCount: projectData.projects.length,
    count: workItems.length,
    workItems
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
    const project = String(req.query?.project || "").trim();
    const data =
      project === "__all__"
        ? await listRecentWorkItemsAllProjects()
        : await listRecentWorkItems(project);
    return res.json(data);
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
  listRecentWorkItems,
  listRecentWorkItemsAllProjects
};
