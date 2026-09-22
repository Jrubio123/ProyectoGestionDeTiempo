function normalizeDocumentoKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase()
    .trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim()
  );
}

function legacyDocumentoType(value) {
  const key = normalizeDocumentoKey(value);
  if (!key) return null;
  if (key === "ce" || key.includes("extranjeria")) return "ce";
  if (key === "cc" || key === "cedula" || key.includes("ciudadania")) return "cc";
  if (key === "nit") return "nit";
  if (key === "pa" || key === "pasaporte") return "pasaporte";
  return null;
}

function matchesLegacyType(row, type) {
  const title = normalizeDocumentoKey(row?.titulo);
  const code = normalizeDocumentoKey(row?.codigo);
  if (type === "ce") return code === "ce" || title.includes("extranjeria");
  if (type === "cc") return code === "cc" || title === "cedula" || title.includes("ciudadania");
  if (type === "nit") return code === "nit" || title === "nit";
  if (type === "pasaporte") return code === "pa" || title === "pasaporte";
  return false;
}

async function resolveDocumentoIdentidad(db, value) {
  if (value === undefined || value === null || value === "") return null;

  const result = await db.query(
    `SELECT id, public_id, titulo, codigo
     FROM documento_identidad
     WHERE activo = true
     ORDER BY id ASC`
  );
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!rows.length) return null;

  const raw = String(value).trim();
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric > 0) {
    const byInternalId = rows.find((row) => Number(row.id) === numeric);
    if (byInternalId) return byInternalId;
  }

  if (isUuid(raw)) {
    const byPublicId = rows.find((row) => String(row.public_id || "").toLowerCase() === raw.toLowerCase());
    if (byPublicId) return byPublicId;
  }

  const key = normalizeDocumentoKey(raw);
  const exact = rows.find((row) =>
    normalizeDocumentoKey(row.titulo) === key || normalizeDocumentoKey(row.codigo) === key
  );
  if (exact) return exact;

  const legacyType = legacyDocumentoType(raw);
  const legacyMatch = legacyType ? rows.find((row) => matchesLegacyType(row, legacyType)) : null;
  return legacyMatch || null;
}

async function resolveDocumentoIdentidadId(db, value) {
  const documento = await resolveDocumentoIdentidad(db, value);
  return documento?.id || null;
}

module.exports = {
  normalizeDocumentoKey,
  resolveDocumentoIdentidad,
  resolveDocumentoIdentidadId
};
