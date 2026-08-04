async function upsertPersonaDesdeContratacion(db, data = {}) {
  const numeroDocumento = String(data.numero_documento || "").trim();
  if (!numeroDocumento) {
    const error = new Error("La persona no tiene numero de documento");
    error.code = "PERSONA_DOCUMENTO_REQUIRED";
    error.statusCode = 422;
    throw error;
  }

  const result = await db.query(
    `INSERT INTO personas (
      numero_documento, tipo_documento_id, nombre, apellidos,
      numero_contacto, correo_electronico, direccion_residencia, ciudad_residencia,
      tipo_persona, factura_en_colombia,
      banco_id, tipo_cuenta_id, numero_cuenta,
      modulo_id, modulo_otro, cliente_id, cliente_otro,
      razon_social, nit_empresa, representante_legal,
      tipo_documento_representante, numero_documento_representante,
      preregistro_id, created_by
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::tipo_persona, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
    )
    ON CONFLICT (numero_documento) DO UPDATE SET
      tipo_documento_id              = COALESCE(EXCLUDED.tipo_documento_id, personas.tipo_documento_id),
      nombre                         = COALESCE(EXCLUDED.nombre, personas.nombre),
      apellidos                      = COALESCE(EXCLUDED.apellidos, personas.apellidos),
      numero_contacto                = COALESCE(EXCLUDED.numero_contacto, personas.numero_contacto),
      correo_electronico             = COALESCE(EXCLUDED.correo_electronico, personas.correo_electronico),
      direccion_residencia           = COALESCE(EXCLUDED.direccion_residencia, personas.direccion_residencia),
      ciudad_residencia              = COALESCE(EXCLUDED.ciudad_residencia, personas.ciudad_residencia),
      tipo_persona                   = COALESCE(EXCLUDED.tipo_persona, personas.tipo_persona),
      factura_en_colombia            = COALESCE(EXCLUDED.factura_en_colombia, personas.factura_en_colombia),
      banco_id                       = COALESCE(EXCLUDED.banco_id, personas.banco_id),
      tipo_cuenta_id                 = COALESCE(EXCLUDED.tipo_cuenta_id, personas.tipo_cuenta_id),
      numero_cuenta                  = COALESCE(EXCLUDED.numero_cuenta, personas.numero_cuenta),
      modulo_id                      = CASE
        WHEN EXCLUDED.modulo_id IS NOT NULL OR EXCLUDED.modulo_otro IS NOT NULL THEN EXCLUDED.modulo_id
        ELSE personas.modulo_id
      END,
      modulo_otro                    = CASE
        WHEN EXCLUDED.modulo_id IS NOT NULL OR EXCLUDED.modulo_otro IS NOT NULL THEN EXCLUDED.modulo_otro
        ELSE personas.modulo_otro
      END,
      cliente_id                     = CASE
        WHEN EXCLUDED.cliente_id IS NOT NULL OR EXCLUDED.cliente_otro IS NOT NULL THEN EXCLUDED.cliente_id
        ELSE personas.cliente_id
      END,
      cliente_otro                   = CASE
        WHEN EXCLUDED.cliente_id IS NOT NULL OR EXCLUDED.cliente_otro IS NOT NULL THEN EXCLUDED.cliente_otro
        ELSE personas.cliente_otro
      END,
      razon_social                   = COALESCE(EXCLUDED.razon_social, personas.razon_social),
      nit_empresa                    = COALESCE(EXCLUDED.nit_empresa, personas.nit_empresa),
      representante_legal            = COALESCE(EXCLUDED.representante_legal, personas.representante_legal),
      tipo_documento_representante   = COALESCE(EXCLUDED.tipo_documento_representante, personas.tipo_documento_representante),
      numero_documento_representante = COALESCE(EXCLUDED.numero_documento_representante, personas.numero_documento_representante),
      preregistro_id                 = COALESCE(EXCLUDED.preregistro_id, personas.preregistro_id),
      estado                         = 'activo',
      updated_at                     = NOW()
    RETURNING id, public_id`,
    [
      numeroDocumento,
      data.tipo_documento_id || null,
      data.nombre || null,
      data.apellidos || null,
      data.numero_contacto || null,
      data.correo_electronico || null,
      data.direccion_residencia || null,
      data.ciudad_residencia || null,
      data.tipo_persona || null,
      data.factura_en_colombia === undefined ? null : data.factura_en_colombia,
      data.banco_id || null,
      data.tipo_cuenta_id || null,
      data.numero_cuenta || null,
      data.modulo_id || null,
      data.modulo_otro || null,
      data.cliente_id || null,
      data.cliente_otro || null,
      data.razon_social || null,
      data.nit_empresa || null,
      data.representante_legal || null,
      data.tipo_documento_representante || null,
      data.numero_documento_representante || null,
      data.preregistro_id || null,
      data.created_by || null
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  upsertPersonaDesdeContratacion
};
