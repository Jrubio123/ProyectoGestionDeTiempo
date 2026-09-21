const PERFIL_MODULO_FALLBACK = "sistemas y productos de información de gestión empresarial";

function cleanPerfilModulo(value) {
  return String(value || "")
    .trim()
    .replace(/^(?:servicios?\s+de\s+)?consultor[ií]a\s+en\s+/i, "")
    .replace(/[.;,:\s]+$/g, "")
    .trim();
}

function uniqueValues(values) {
  const result = [];
  const seen = new Set();

  for (const value of values) {
    const cleaned = cleanPerfilModulo(value);
    const key = cleaned.toLocaleLowerCase("es-CO");
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

function joinPerfilModulo(values) {
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} y ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} y ${values.at(-1)}`;
}

function resolvePerfilModuloConsultoria(personaContext = {}, items = []) {
  const itemValues = uniqueValues(
    (Array.isArray(items) ? items : []).map((item) => (
      item?.modulo_titulo || item?.modulo_nombre
    ))
  );
  if (itemValues.length) return joinPerfilModulo(itemValues);

  const [contextValue] = uniqueValues([
    personaContext?.modulo_nombre,
    personaContext?.perfilSolicitud,
    personaContext?.cargo
  ]);
  return contextValue || PERFIL_MODULO_FALLBACK;
}

module.exports = {
  PERFIL_MODULO_FALLBACK,
  resolvePerfilModuloConsultoria
};
