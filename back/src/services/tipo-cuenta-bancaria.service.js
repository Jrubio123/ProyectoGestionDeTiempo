function toNullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeTipoCuentaKey(value) {
  const normalized = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!normalized) return "";
  if (normalized.includes("ahorro")) return "ahorros";
  if (normalized.includes("corrient")) return "corriente";

  return normalized
    .split(/\s+/)
    .filter((token) => !["cuenta", "de", "bancaria", "bancario"].includes(token))
    .join(" ");
}

function invalidTipoCuentaError() {
  const error = new Error("Tipo de cuenta no válido o inactivo");
  error.status = 400;
  error.code = "TIPO_CUENTA_INVALIDO";
  return error;
}

async function resolveTipoCuentaBancaria(
  db,
  { tipoCuentaId = null, tipoCuentaNombre = null, required = false } = {}
) {
  const idRef = toNullableText(tipoCuentaId);
  const nombreRef = toNullableText(tipoCuentaNombre);

  if (idRef) {
    const byId = await db.query(
      `
      SELECT id, public_id::text AS public_id, titulo
      FROM tipo_cuenta_bancaria
      WHERE activo = true
        AND (public_id::text = $1::text OR id::text = $1::text)
      LIMIT 1
      `,
      [idRef]
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  if (nombreRef) {
    const catalogo = await db.query(
      `
      SELECT id, public_id::text AS public_id, titulo
      FROM tipo_cuenta_bancaria
      WHERE activo = true
      ORDER BY id
      `
    );
    const expectedKey = normalizeTipoCuentaKey(nombreRef);
    const match = catalogo.rows.find(
      (item) => normalizeTipoCuentaKey(item.titulo) === expectedKey
    );
    if (match) return match;
  }

  if (required || idRef || nombreRef) throw invalidTipoCuentaError();
  return null;
}

module.exports = {
  normalizeTipoCuentaKey,
  resolveTipoCuentaBancaria
};
