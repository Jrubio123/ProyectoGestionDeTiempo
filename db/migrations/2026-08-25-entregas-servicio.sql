BEGIN;

CREATE TABLE IF NOT EXISTS contactos_cliente (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nombre VARCHAR(255) NOT NULL,
    cargo VARCHAR(150),
    telefono VARCHAR(50),
    email VARCHAR(255),
    es_contacto_principal BOOLEAN NOT NULL DEFAULT false,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_by INTEGER REFERENCES usuarios(id),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT contactos_cliente_nombre_no_vacio CHECK (BTRIM(nombre) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contactos_cliente_principal_activo
    ON contactos_cliente(cliente_id)
    WHERE es_contacto_principal = true AND activo = true;
CREATE INDEX IF NOT EXISTS idx_contactos_cliente_cliente
    ON contactos_cliente(cliente_id, activo);

CREATE TABLE IF NOT EXISTS entregas_servicio (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    coordinador_asignado_id INTEGER NOT NULL REFERENCES usuarios(id),
    tipo_servicio VARCHAR(20) NOT NULL,
    nombre_servicio VARCHAR(255) NOT NULL,
    estado VARCHAR(30) NOT NULL DEFAULT 'REGISTRADA',
    perfil_cliente VARCHAR(20) NOT NULL,
    analisis_adaptabilidad TEXT NOT NULL,
    acuerdos_comerciales TEXT,
    creado_por INTEGER NOT NULL REFERENCES usuarios(id),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT entregas_servicio_tipo_check
        CHECK (tipo_servicio IN ('PROYECTO', 'MESA_SERVICIO', 'OUTSOURCING')),
    CONSTRAINT entregas_servicio_estado_check
        CHECK (estado IN ('REGISTRADA', 'ACEPTADA', 'EN_PROCESO', 'CERRADA', 'CANCELADA')),
    CONSTRAINT entregas_servicio_perfil_check
        CHECK (perfil_cliente IN ('CLAVE', 'NO_CLAVE', 'POR_DEFINIR')),
    CONSTRAINT entregas_servicio_nombre_no_vacio CHECK (BTRIM(nombre_servicio) <> ''),
    CONSTRAINT entregas_servicio_adaptabilidad_no_vacia CHECK (BTRIM(analisis_adaptabilidad) <> '')
);

CREATE INDEX IF NOT EXISTS idx_entregas_servicio_cliente
    ON entregas_servicio(cliente_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entregas_servicio_coordinador
    ON entregas_servicio(coordinador_asignado_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entregas_servicio_creador
    ON entregas_servicio(creado_por, created_at DESC);

CREATE TABLE IF NOT EXISTS entregas_servicio_contactos (
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    contacto_cliente_id INTEGER NOT NULL REFERENCES contactos_cliente(id),
    tipo_contacto VARCHAR(30) NOT NULL DEFAULT 'INTERVENTOR',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entrega_servicio_id, contacto_cliente_id, tipo_contacto),
    CONSTRAINT entregas_servicio_contactos_tipo_check
        CHECK (tipo_contacto IN ('PRINCIPAL', 'INTERVENTOR', 'FACTURACION'))
);

CREATE TABLE IF NOT EXISTS entregas_servicio_consultores (
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    consultor_id INTEGER NOT NULL REFERENCES usuarios(id),
    es_principal BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entrega_servicio_id, consultor_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entrega_consultor_principal
    ON entregas_servicio_consultores(entrega_servicio_id)
    WHERE es_principal = true;

CREATE TABLE IF NOT EXISTS entregas_servicio_modulos (
    id SERIAL PRIMARY KEY,
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    modulo_id INTEGER REFERENCES modulo(id),
    modulo_otro VARCHAR(150),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT entregas_servicio_modulo_origen_check CHECK (
        (modulo_id IS NOT NULL AND modulo_otro IS NULL)
        OR (modulo_id IS NULL AND NULLIF(BTRIM(modulo_otro), '') IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entrega_modulo_catalogo
    ON entregas_servicio_modulos(entrega_servicio_id, modulo_id)
    WHERE modulo_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_entrega_modulo_otro
    ON entregas_servicio_modulos(entrega_servicio_id, LOWER(BTRIM(modulo_otro)))
    WHERE modulo_otro IS NOT NULL;

CREATE TABLE IF NOT EXISTS entregas_servicio_proyecto (
    entrega_servicio_id INTEGER PRIMARY KEY REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    objeto_proyecto TEXT NOT NULL,
    valor_total NUMERIC(18,2) NOT NULL,
    moneda VARCHAR(3) NOT NULL DEFAULT 'COP',
    forma_pago TEXT NOT NULL,
    equipo_estimacion TEXT NOT NULL,
    tarifas_consultoria TEXT NOT NULL,
    CONSTRAINT entrega_proyecto_valor_check CHECK (valor_total >= 0)
);

CREATE TABLE IF NOT EXISTS entregas_servicio_mesa (
    entrega_servicio_id INTEGER PRIMARY KEY REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    detalle_tarifas TEXT NOT NULL,
    forma_pago TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entregas_servicio_outsourcing (
    entrega_servicio_id INTEGER PRIMARY KEY REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    tiempo_descripcion VARCHAR(255) NOT NULL,
    tarifa NUMERIC(18,2) NOT NULL,
    valor_cliente NUMERIC(18,2) NOT NULL,
    moneda VARCHAR(3) NOT NULL DEFAULT 'COP',
    tiene_contrato BOOLEAN NOT NULL,
    CONSTRAINT entrega_outsourcing_tarifa_check CHECK (tarifa >= 0),
    CONSTRAINT entrega_outsourcing_valor_cliente_check CHECK (valor_cliente >= 0)
);

CREATE TABLE IF NOT EXISTS entregas_servicio_documentos (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    tipo_documento VARCHAR(30) NOT NULL DEFAULT 'PROPUESTA_COMERCIAL',
    origen VARCHAR(20) NOT NULL,
    nombre_archivo VARCHAR(255),
    web_url TEXT NOT NULL,
    graph_drive_id TEXT,
    graph_item_id TEXT,
    estado_carga VARCHAR(20) NOT NULL DEFAULT 'DISPONIBLE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT entregas_documentos_origen_check CHECK (origen IN ('ONEDRIVE', 'LINK_EXTERNO')),
    CONSTRAINT entregas_documentos_estado_check CHECK (estado_carga IN ('DISPONIBLE', 'ERROR')),
    CONSTRAINT entregas_documentos_url_no_vacia CHECK (BTRIM(web_url) <> '')
);

CREATE INDEX IF NOT EXISTS idx_entregas_documentos_entrega
    ON entregas_servicio_documentos(entrega_servicio_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entregas_servicio_notificaciones (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    entrega_servicio_id INTEGER NOT NULL REFERENCES entregas_servicio(id) ON DELETE CASCADE,
    tipo VARCHAR(30) NOT NULL DEFAULT 'ASIGNACION',
    destinatarios JSONB NOT NULL DEFAULT '{}'::jsonb,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    intentos INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT,
    enviado_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT entregas_notificaciones_tipo_check CHECK (tipo IN ('ASIGNACION')),
    CONSTRAINT entregas_notificaciones_estado_check CHECK (estado IN ('PENDIENTE', 'ENVIADA', 'ERROR'))
);

CREATE INDEX IF NOT EXISTS idx_entregas_notificaciones_pendientes
    ON entregas_servicio_notificaciones(estado, created_at)
    WHERE estado IN ('PENDIENTE', 'ERROR');

DROP TRIGGER IF EXISTS update_contactos_cliente_updated_at ON contactos_cliente;
CREATE TRIGGER update_contactos_cliente_updated_at
    BEFORE UPDATE ON contactos_cliente
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_entregas_servicio_updated_at ON entregas_servicio;
CREATE TRIGGER update_entregas_servicio_updated_at
    BEFORE UPDATE ON entregas_servicio
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_entregas_servicio_notificaciones_updated_at ON entregas_servicio_notificaciones;
CREATE TRIGGER update_entregas_servicio_notificaciones_updated_at
    BEFORE UPDATE ON entregas_servicio_notificaciones
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
