const https = require("https");
const { getGraphAccessToken } = require("../email");

const CALENDAR_FIELDS = [
  "id",
  "iCalUId",
  "subject",
  "start",
  "end",
  "organizer",
  "isCancelled",
  "isAllDay",
  "showAs",
  "responseStatus",
  "sensitivity",
  "webLink",
  "lastModifiedDateTime",
  "type",
  "seriesMasterId"
];

class MicrosoftCalendarError extends Error {
  constructor(message, statusCode = 502, graphCode = null) {
    super(message);
    this.name = "MicrosoftCalendarError";
    this.statusCode = statusCode;
    this.graphCode = graphCode;
  }
}

function graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "graph.microsoft.com",
        path,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"'
        },
        timeout: 20000
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          let data = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch (_) {
            data = {};
          }
          const statusCode = Number(response.statusCode || 0);
          if (statusCode >= 200 && statusCode < 300) {
            resolve(data);
            return;
          }
          const graphCode = data?.error?.code || null;
          const graphMessage = data?.error?.message || `Microsoft Graph respondió HTTP ${statusCode}`;
          reject(new MicrosoftCalendarError(graphMessage, statusCode || 502, graphCode));
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Tiempo de espera agotado consultando calendarios")));
    request.on("error", reject);
    request.end();
  });
}

function normalizeNextPath(nextLink) {
  if (!nextLink) return null;
  let url;
  try {
    url = new URL(nextLink);
  } catch (_) {
    throw new MicrosoftCalendarError("Microsoft Graph devolvió una paginación inválida.");
  }
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com") {
    throw new MicrosoftCalendarError("Microsoft Graph devolvió una paginación no permitida.");
  }
  return `${url.pathname}${url.search}`;
}

async function listUserCalendarView(userIdentifier, startDateTime, endDateTime) {
  const user = String(userIdentifier || "").trim();
  if (!user) throw new MicrosoftCalendarError("La persona no tiene identidad de Microsoft 365.", 400);

  const token = await getGraphAccessToken();
  const params = new URLSearchParams({
    startDateTime,
    endDateTime,
    "$select": CALENDAR_FIELDS.join(","),
    "$top": "250"
  });
  let path = `/v1.0/users/${encodeURIComponent(user)}/calendarView?${params.toString()}`;
  const events = [];

  while (path) {
    const page = await graphGet(path, token);
    events.push(...(Array.isArray(page.value) ? page.value : []));
    path = normalizeNextPath(page["@odata.nextLink"]);
  }

  return events;
}

function normalizeGraphDateTime(value) {
  const raw = String(value?.dateTime || "").trim();
  if (!raw) return null;
  const reducedFraction = raw.replace(/(\.\d{3})\d+/, "$1");
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(reducedFraction);
  const normalized = hasOffset ? reducedFraction : `${reducedFraction}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeCalendarEvent(event, rangeStart, rangeEnd) {
  const eventId = String(event?.id || "").trim();
  const start = normalizeGraphDateTime(event?.start);
  const end = normalizeGraphDateTime(event?.end);
  const windowStart = new Date(rangeStart);
  const windowEnd = new Date(rangeEnd);
  if (!eventId || !start || !end || end <= start) return { included: false, reason: "INVALIDO" };
  if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
    throw new MicrosoftCalendarError("El rango de calendario no es válido.", 400);
  }
  if (event.isCancelled) return { included: false, reason: "CANCELADO" };
  if (event.isAllDay) return { included: false, reason: "TODO_EL_DIA" };

  const response = String(event.responseStatus?.response || "").trim().toLowerCase();
  if (response === "declined") return { included: false, reason: "RECHAZADO" };
  const showAs = String(event.showAs || "").trim().toLowerCase();
  if (showAs === "free") return { included: false, reason: "LIBRE" };

  const clippedStart = start > windowStart ? start : windowStart;
  const clippedEnd = end < windowEnd ? end : windowEnd;
  if (clippedEnd <= clippedStart) return { included: false, reason: "FUERA_RANGO" };

  const sensitivity = String(event.sensitivity || "normal").trim().toLowerCase();
  const privateEvent = ["private", "personal", "confidential"].includes(sensitivity);
  const hours = Math.round(((end - start) / 3600000) * 100) / 100;

  return {
    included: true,
    event: {
      graphEventId: eventId,
      graphICalUid: String(event.iCalUId || "").trim() || null,
      organizerEmail: String(event.organizer?.emailAddress?.address || "").trim().toLowerCase(),
      organizerName: String(event.organizer?.emailAddress?.name || "").trim() || null,
      title: privateEvent
        ? "Reunión privada"
        : String(event.subject || "").trim() || "Reunión de calendario",
      start,
      end,
      hours,
      responseStatus: response || null,
      showAs: showAs || null,
      sensitivity,
      webUrl: String(event.webLink || "").trim() || null,
      sourceChangedAt: event.lastModifiedDateTime || null,
      eventType: String(event.type || "").trim() || null,
      seriesMasterId: String(event.seriesMasterId || "").trim() || null
    }
  };
}

module.exports = {
  MicrosoftCalendarError,
  listUserCalendarView,
  normalizeCalendarEvent,
  normalizeGraphDateTime
};
