-- ============================================================================
-- Script de Inicialización - Base de Datos Gestión de Tiempo y Consultorías
-- PostgreSQL 16
-- Migración desde SharePoint/PowerApps
-- ============================================================================

-- Extensiones útiles
CREATE EXTENSION
IF NOT EXISTS "pg_trgm";
-- Para búsquedas de texto


-- ============================================================================
-- TIPOS ENUMERADOS (Reemplazo de Choice de SharePoint)
-- ============================================================================

-- Estados de Aprobación
CREATE TYPE tipo_aprobacion AS ENUM
(
    'Aprobado',
    'Pendiente',
    'Rechazado',
    'Revisión'
);

-- Estados de Asignación
CREATE TYPE tipo_estado_asignacion AS ENUM
(
    'Abierto',
    'Cerrado',
    'Proceso'
);

-- Estados de Asignación de Mesa/Fábrica
CREATE TYPE tipo_estado_asignacion_mesa AS ENUM
(
    'Activo',
    'Inactivo'
);

-- Tipos de Servicio
CREATE TYPE tipo_servicio AS ENUM
(
    'Servicio',
    'Incidente',
    'Requerimiento'
);

-- Tipos de Permiso de Administrador
CREATE TYPE tipo_permiso_admin AS ENUM
(
    'Crear Asignación'
);

-- Estados de Reporte
CREATE TYPE tipo_estado_reporte AS ENUM
(
    'Aprobado',
    'En_Firma',
    'Pendiente',
    'Rechazado',
    'Revisión'
);

-- Estados de Mesa de Servicio
CREATE TYPE tipo_estado_mesa AS ENUM
(
    'Cerrado',
    'En proceso',
    'Transferido Silver',
    'Transferido Corona'
);

-- Estados de Fábrica
CREATE TYPE tipo_estado_fabrica AS ENUM
(
    'En desarrollo',
    'Finalizado'
);

-- Tipos de Persona
CREATE TYPE tipo_persona AS ENUM
(
    'Natural',
    'Jurídica'
);

-- Monedas
CREATE TYPE tipo_moneda AS ENUM
(
    'COP',
    'USD',
    'EUR'
);

-- Tipos de Consultor
CREATE TYPE tipo_consultor_enum AS ENUM
(
    'Principal',
    'Asociado'
);

-- Grupo de usuario para onboarding
CREATE TYPE grupo_usuario_tipo AS ENUM
(
    'ADMIN',
    'COORDINADOR',
    'CONSULTOR',
    'CONTABILIDAD',
    'COMERCIAL',
    'Otro'
);

-- Grupo de distribucion para onboarding
CREATE TYPE grupo_distribucion_tipo AS ENUM
(
    'Todos Silver',
    'Vinculados',
    'Responsable'
);

-- Cargos/perfiles para onboarding
CREATE TYPE cargo_tipo AS ENUM
(
    'Analista Comercial',
    'Analista de Soporte',
    'Auxiliar Administrativa',
    'Auxiliar Administrativa y de Talento Humano',
    'Auxiliar Contable',
    'Consultor .Net',
    'Consultor ABAP',
    'Consultor ABAP CPI',
    'Consultor ABAP FIORI',
    'Consultor ABAP ISH',
    'Consultor ABAP TM',
    'Consultor ABAP WORKFLOW',
    'Consultor Basis',
    'Consultor BI',
    'Consultor BPC',
    'Consultor Business One',
    'Consultor CO',
    'Consultor CS',
    'Consultor DS',
    'Consultor EWM',
    'Consultor FI',
    'Consultor FICO',
    'Consultor FM',
    'Consultor GRC',
    'Consultor HCM',
    'Consultor Integración',
    'Consultor ISH',
    'Consultor LETRA',
    'Consultor MM',
    'Consultor PM',
    'Consultor PP',
    'Consultor PP QM',
    'Consultor PS',
    'Consultor QM',
    'Consultor RE',
    'Consultor SD',
    'Consultor SD LETRA',
    'Consultor SQL',
    'Consultor TM',
    'Consultor TRM',
    'Consultor WM',
    'Consultor Workflow',
    'Coordinadora de mesa de servicios',
    'Coordinadora de Proyectos',
    'Coordinadora de Servicios',
    'Gerente Comercial',
    'Gerente de Estrategia e Innovación',
    'Gerente de Servicios',
    'Líder Administrativa y de Talento Humano',
    'Líder de Fabrica',
    'Líder de Reclutamiento',
    'Consultor Power BI',
    'Consultor IBP'
);

-- ============================================================================
-- TABLAS DE CATÁLOGO (Tablas maestras sin dependencias)
-- ============================================================================

-- Tabla: Bancos
CREATE TABLE bancos
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL,
    codigo_bancolombia VARCHAR(50),
    codigo_conversor VARCHAR(50),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bancos_activo ON bancos(activo);

COMMENT ON TABLE bancos IS 'Catálogo de bancos para cuentas de cobro';

-- Tabla: Roles
CREATE TABLE roles
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL UNIQUE,
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_roles_activo ON roles(activo);

COMMENT ON TABLE roles IS 'Roles de usuario en el sistema';

-- Tabla: TipoCuentaBancaria
CREATE TABLE tipo_cuenta_bancaria
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL,
    tipo_cuenta INTEGER,
    tipo_transaccion VARCHAR(100),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE tipo_cuenta_bancaria IS 'Tipos de cuenta bancaria (Ahorros, Corriente, etc)';

-- Tabla: DocumentoIdentidad
CREATE TABLE documento_identidad
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL UNIQUE,
    codigo VARCHAR(10),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE documento_identidad IS 'Tipos de documento de identidad';

-- Tabla: Clientes
CREATE TABLE clientes
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL,
    -- Nombre de la empresa
    nit VARCHAR(50) UNIQUE NOT NULL,
    prefijo VARCHAR(20),
    correlativo INTEGER,
    activo BOOLEAN DEFAULT true,
    requiere_confirmacion_cliente BOOLEAN DEFAULT false,

    -- Información adicional
    direccion TEXT,
    telefono VARCHAR(50),
    email VARCHAR(255),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clientes_nit ON clientes(nit);
CREATE INDEX idx_clientes_activo ON clientes(activo);
CREATE INDEX idx_clientes_prefijo ON clientes(prefijo);

COMMENT ON TABLE clientes IS 'Catálogo de clientes de la empresa';
COMMENT ON COLUMN clientes.titulo IS 'Nombre de la empresa cliente';
COMMENT ON COLUMN clientes.nit IS 'Número de identificación tributaria';
COMMENT ON COLUMN clientes.requiere_confirmacion_cliente IS 'Si es true, las solicitudes de nuevo contrato quedan en pendiente de confirmación del cliente antes de enviarse a TH';

-- Tabla: TipoAsignacion
CREATE TABLE tipo_asignacion
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(255) NOT NULL UNIQUE,
    -- Full Time, Part Time, Mesa Fábrica, etc
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tipo_asignacion_activo ON tipo_asignacion(activo);

COMMENT ON TABLE tipo_asignacion IS 'Tipos de asignación de consultores';

-- Tabla: Modulo
CREATE TABLE modulo
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    titulo VARCHAR(50) NOT NULL UNIQUE,
    -- IT, AT, FI
    nombre_completo VARCHAR(255),
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_modulo_activo ON modulo(activo);

COMMENT ON TABLE modulo IS 'Módulos de consultoría (IT, AT, FI, etc)';

-- Tablas auxiliares para conversión de números a letras
CREATE TABLE period_1
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    group_number INTEGER NOT NULL,
    titulo VARCHAR(50) NOT NULL
);

COMMENT ON TABLE period_1 IS 'Periodos para conversión de números a letras (Mil, Millón, Billón)';

CREATE TABLE place_value_1
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    digit INTEGER NOT NULL,
    titulo VARCHAR(50) NOT NULL,
    column_value INTEGER NOT NULL
);

COMMENT ON TABLE place_value_1 IS 'Valores de lugar para conversión de números a letras';

-- ============================================================================
-- TABLA DE USUARIOS (Reemplazo de campos Person/Group de SharePoint)
-- ============================================================================

CREATE TABLE usuarios
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    -- Información de usuario (Person/Group de SharePoint)
    nombre_usuario VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT,
    sharepoint_user_id INTEGER,
    azure_oid VARCHAR(64),

    -- Rol y estado
    rol_usuario_id INTEGER REFERENCES roles(id),
    activo BOOLEAN DEFAULT true,

    -- Datos bancarios
    nro_cuenta_bancaria VARCHAR(50),
    banco_id INTEGER REFERENCES bancos(id),
    tipo_cuenta_id INTEGER REFERENCES tipo_cuenta_bancaria(id),

    -- Información personal
    tipo_documento_id INTEGER REFERENCES documento_identidad(id),
    cedula VARCHAR(50),
    direccion TEXT,
    telefono VARCHAR(50),
    ciudad VARCHAR(100),

    -- Clasificación (antes eran Choice en SharePoint)
    tipo_persona tipo_persona,
    moneda_cobro tipo_moneda DEFAULT 'COP',
    tipo_consultor tipo_consultor_enum,

    -- Relación jerárquica (auto-referencia)
    id_consultor_principal INTEGER REFERENCES usuarios(id),

    -- Información adicional
    foto_url TEXT,
    observaciones TEXT,
    ultimo_inicio_sesion TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255)
);

CREATE UNIQUE INDEX idx_usuarios_azure_oid ON usuarios(azure_oid);

-- Índices para usuarios
CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_usuarios_rol ON usuarios(rol_usuario_id);
CREATE INDEX idx_usuarios_activo ON usuarios(activo);
CREATE INDEX idx_usuarios_sharepoint_id ON usuarios(sharepoint_user_id);
CREATE INDEX idx_usuarios_tipo_consultor ON usuarios(tipo_consultor);

COMMENT ON TABLE usuarios IS 'Usuarios del sistema - Reemplaza campos Person/Group de SharePoint';
COMMENT ON COLUMN usuarios.sharepoint_user_id IS 'ID del usuario en SharePoint para migración';
COMMENT ON COLUMN usuarios.email IS 'Email del usuario - usado para mapear Person/Group';

-- Tabla: UsuarioLicenciasBackup
CREATE TABLE usuario_licencias_backup
(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_group_id UUID NOT NULL DEFAULT gen_random_uuid(),
    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    usuario_public_id UUID NOT NULL,
    azure_oid VARCHAR(64),
    email VARCHAR(255),
    sku_id VARCHAR(64) NOT NULL,
    sku_part_number VARCHAR(255),
    fecha_desactivacion TIMESTAMP NOT NULL DEFAULT NOW(),
    desactivado_por_usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
    desactivado_por_email VARCHAR(255),
    restaurado BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_restauracion TIMESTAMP,
    restaurado_por_usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
    restaurado_por_email VARCHAR(255)
);

CREATE INDEX idx_usuario_licencias_backup_usuario ON usuario_licencias_backup(usuario_id);
CREATE INDEX idx_usuario_licencias_backup_restaurado ON usuario_licencias_backup(restaurado);
CREATE INDEX idx_usuario_licencias_backup_group ON usuario_licencias_backup(backup_group_id);
CREATE INDEX idx_usuario_licencias_backup_fecha ON usuario_licencias_backup(fecha_desactivacion DESC);
CREATE UNIQUE INDEX uq_usuario_licencias_backup_group_sku ON usuario_licencias_backup(backup_group_id, sku_id);

COMMENT ON TABLE usuario_licencias_backup IS 'Snapshot de licencias removidas por usuario para restauración futura';

-- ============================================================================
-- TABLAS DE GESTIÓN DE CONSULTORÍAS
-- ============================================================================

-- Tabla: Consultorias
CREATE TABLE consultorias (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    descripcion_consultoria TEXT,
    id_cliente INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    
    -- Coordinador (antes Person/Group, ahora FK a usuarios)
    coordinador_responsable_id INTEGER REFERENCES usuarios
(id) ON
DELETE
SET NULL
,
    
    id_tipo_asignacion INTEGER REFERENCES tipo_asignacion
(id) ON
DELETE
SET NULL
,
    asignado_consultor BOOLEAN DEFAULT false,
    
    activo BOOLEAN DEFAULT true,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_by INTEGER REFERENCES usuarios
(id)
);

CREATE INDEX idx_consultorias_cliente ON consultorias(id_cliente);
CREATE INDEX idx_consultorias_coordinador ON consultorias(coordinador_responsable_id);
CREATE INDEX idx_consultorias_activo ON consultorias(activo);
CREATE INDEX idx_consultorias_tipo ON consultorias(id_tipo_asignacion);

COMMENT ON TABLE consultorias IS 'Proyectos de consultoría para clientes';

-- Tabla: TarifaConsultor
CREATE TABLE tarifa_consultor
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    id_cliente INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

    -- Consultor (antes Person/Group, ahora FK a usuarios)
    consultor_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

    valor_tarifa DECIMAL(15, 2) NOT NULL,
    modulo_id INTEGER REFERENCES modulo(id) ON DELETE SET NULL,
    id_tipo_asignacion INTEGER REFERENCES tipo_asignacion(id) ON DELETE SET NULL,

    activo BOOLEAN DEFAULT true,
    vigencia_desde DATE,
    vigencia_hasta DATE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraint para evitar duplicados
    UNIQUE(id_cliente, consultor_id, modulo_id, id_tipo_asignacion, vigencia_desde)
);

CREATE INDEX idx_tarifa_cliente ON tarifa_consultor(id_cliente);
CREATE INDEX idx_tarifa_consultor ON tarifa_consultor(consultor_id);
CREATE INDEX idx_tarifa_modulo ON tarifa_consultor(modulo_id);
CREATE INDEX idx_tarifa_activo ON tarifa_consultor(activo);

COMMENT ON TABLE tarifa_consultor IS 'Tarifas por consultor, cliente y tipo de asignación';

-- Tabla: RegistroAsignaciones
CREATE TABLE registro_asignaciones
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    id_consultoria INTEGER NOT NULL REFERENCES consultorias(id) ON DELETE CASCADE,
    id_tarifa INTEGER REFERENCES tarifa_consultor(id) ON DELETE SET NULL,
    id_modulo INTEGER REFERENCES modulo(id) ON DELETE SET NULL,

    -- Consultor (antes Person/Group, ahora FK a usuarios)
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

    -- Aprobación y estado (antes Choice en SharePoint)
    aprobar_coordinador tipo_aprobacion DEFAULT 'Pendiente',
    estado tipo_estado_asignacion DEFAULT 'Abierto',

    -- Fechas
    fecha_inicio DATE,
    fecha_fin DATE,
    fecha_cierre_mesa_fab DATE,

    -- Valores
    cantidad_dias INTEGER,
    horas_asignadas DECIMAL(10, 2),
    valor_hora DECIMAL(15, 2),
    valor_dia DECIMAL(15, 2),
    total_pagar DECIMAL(15, 2),
    es_costo_total BOOLEAN DEFAULT false,

    -- Información del caso
    nro_caso_interno TEXT,
    nro_caso_cliente TEXT,
    tipo_servicio tipo_servicio,
    observacion TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_by INTEGER REFERENCES usuarios(id)
);

CREATE INDEX idx_registro_consultoria ON registro_asignaciones(id_consultoria);
CREATE INDEX idx_registro_consultor ON registro_asignaciones(consultor_responsable_id);
CREATE INDEX idx_registro_estado ON registro_asignaciones(estado);
CREATE INDEX idx_registro_fechas ON registro_asignaciones(fecha_inicio, fecha_fin);

COMMENT ON TABLE registro_asignaciones IS 'Asignaciones de consultores a proyectos';

-- Tabla: CuentaCobro
CREATE TABLE cuenta_cobro
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    descripcion TEXT,
    fecha_correspondiente DATE,
    total_cuenta_cobro DECIMAL(15, 2),
    fecha_periodo_inicio DATE NOT NULL,
    fecha_periodo_fin DATE NOT NULL,
    total_letras TEXT,
    -- Valor en letras
    ciudad_cobro VARCHAR(255),

    -- Archivos adjuntos (ruta o JSON con metadata)
    datos_adjuntos JSONB,
    -- Metadata de archivos adjuntos

    -- Estado
    estado tipo_estado_reporte DEFAULT 'Pendiente',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES usuarios(id)
);

CREATE INDEX idx_cuenta_cobro_fecha ON cuenta_cobro(fecha_correspondiente);
CREATE INDEX idx_cuenta_cobro_periodo ON cuenta_cobro(fecha_periodo_inicio, fecha_periodo_fin);
CREATE INDEX idx_cuenta_cobro_estado ON cuenta_cobro(estado);

COMMENT ON TABLE cuenta_cobro IS 'Cuentas de cobro generadas';
COMMENT ON COLUMN cuenta_cobro.datos_adjuntos IS 'Metadata de archivos adjuntos en formato JSON';

-- Tabla: ReporteHoras
CREATE TABLE reporte_horas
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    id_registro_asignacion INTEGER NOT NULL REFERENCES registro_asignaciones(id) ON DELETE CASCADE,
    id_cuenta_cobro INTEGER REFERENCES cuenta_cobro(id) ON DELETE SET NULL,

    -- Horas y días
    horas_reportadas DECIMAL(10, 2),
    cantidad_dias_reportados INTEGER,
    total_cobrar DECIMAL(15, 2),

    -- Información del reporte
    requerimiento TEXT,
    perfil_fabrica VARCHAR(100),
    wricef VARCHAR(120),
    es_costo_total BOOLEAN DEFAULT false,
    nro_caso_int_ext TEXT,

    -- Referencias (convertidas de texto "quemado" a lookup)
    cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    tipo_asignacion_id INTEGER REFERENCES tipo_asignacion(id) ON DELETE SET NULL,
    modulo_id INTEGER REFERENCES modulo(id) ON DELETE SET NULL,

    -- Usuarios (antes Person/Group o email quemado, ahora FK)
    coordinador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    consultor_principal_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

    -- Información de servicio
    tipo_servicio VARCHAR(100),
    -- Texto libre por ahora

    -- Estados (antes Choice en SharePoint)
    estado_reporte tipo_estado_reporte DEFAULT 'Pendiente',
    estado_mesa_servicio tipo_estado_mesa,
    estado_fabrica tipo_estado_fabrica,

    -- Observaciones
    motivo_rechazo TEXT,
    observacion_mesa_fabrica TEXT,
    fecha_cierre_mesa_fab DATE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by INTEGER REFERENCES usuarios(id)
);

CREATE INDEX idx_reporte_asignacion ON reporte_horas(id_registro_asignacion);
CREATE INDEX idx_reporte_estado ON reporte_horas(estado_reporte);
CREATE INDEX idx_reporte_consultor ON reporte_horas(consultor_responsable_id);
CREATE INDEX idx_reporte_cliente ON reporte_horas(cliente_id);
CREATE INDEX idx_reporte_cuenta_cobro ON reporte_horas(id_cuenta_cobro);
CREATE INDEX idx_reporte_fechas ON reporte_horas(created_at, fecha_cierre_mesa_fab);

COMMENT ON TABLE reporte_horas IS 'Reporte de horas trabajadas por los consultores';
COMMENT ON COLUMN reporte_horas.cliente_id IS 'Antes estaba quemado como texto, ahora es FK';
COMMENT ON COLUMN reporte_horas.coordinador_id IS 'Antes era email quemado, ahora es FK a usuarios';
ALTER TABLE reporte_horas ADD COLUMN IF NOT EXISTS perfil_fabrica VARCHAR(100);
ALTER TABLE reporte_horas ADD COLUMN IF NOT EXISTS wricef VARCHAR(120);

-- Tabla: AsignacionesConsultoriaMesaFabrica
CREATE TABLE asignaciones_consultoria_mesa_fabrica
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    id_consultoria INTEGER NOT NULL REFERENCES consultorias(id) ON DELETE CASCADE,

    -- Consultor (antes Person/Group, ahora FK a usuarios)
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

    valor_hora DECIMAL(15, 2),
    estado_asignacion tipo_estado_asignacion_mesa DEFAULT 'Activo',
    id_modulo INTEGER REFERENCES modulo(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_asig_mesa_consultoria ON asignaciones_consultoria_mesa_fabrica(id_consultoria);
CREATE INDEX idx_asig_mesa_consultor ON asignaciones_consultoria_mesa_fabrica(consultor_responsable_id);
CREATE INDEX idx_asig_mesa_estado ON asignaciones_consultoria_mesa_fabrica(estado_asignacion);

COMMENT ON TABLE asignaciones_consultoria_mesa_fabrica IS 'Asignaciones específicas de mesa de fábrica';

CREATE TABLE permisos_administrador
(
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    coordinador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

    tipo_permiso tipo_permiso_admin,
    permiso_activo BOOLEAN DEFAULT true,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_permisos_coordinador ON permisos_administrador(coordinador_id);
CREATE INDEX idx_permisos_activo ON permisos_administrador(permiso_activo);

COMMENT ON TABLE permisos_administrador IS 'Permisos de coordinadores para acciones administrativas';

CREATE TABLE solicitudes_rrhh (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    
    coordinador_id INT NOT NULL REFERENCES usuarios(id),
    cliente_id INT NOT NULL REFERENCES clientes(id),
    modulo_id INT REFERENCES modulo(id),
    
    perfil VARCHAR(100) NOT NULL, 
    nivel VARCHAR(20) NOT NULL 
        CHECK (nivel IN ('Junior', 'Semi-senior', 'Senior')),
    
    tiempo VARCHAR(100),
    ubicacion VARCHAR(50) NOT NULL DEFAULT 'Remoto' 
        CHECK (ubicacion IN ('En sitio', 'Remoto', 'Híbrido')),
    modalidad VARCHAR(50) NOT NULL DEFAULT 'Full time'
        CHECK (modalidad IN ('Full time', 'Medio tiempo', 'Por horas')),
    
    fecha_inicio_esperada DATE,
    
    tipo_proyecto VARCHAR(50)
        CHECK (tipo_proyecto IN ('Soporte', 'Roll out', 'Implementación', 'Mantenimiento', 'Migración')),
    
    experiencia TEXT,
    
    presupuesto VARCHAR(150), 
    
    descripcion TEXT,
    informacion_adicional TEXT,
    observaciones_rrhh TEXT,
    
    prioridad VARCHAR(20) DEFAULT 'Media' NOT NULL
        CHECK (prioridad IN ('Alta', 'Media', 'Baja')),
        
    estado VARCHAR(50) DEFAULT 'Pendiente' NOT NULL
        CHECK (estado IN ('Pendiente', 'Reclutamiento', 'Entrevistas', 'Contratado', 'Cancelado')),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE solicitudes_rrhh IS 'Gestión de solicitudes de vacantes';
COMMENT ON COLUMN solicitudes_rrhh.presupuesto IS 'Rango salarial o presupuesto estimado (Texto libre)';

CREATE INDEX idx_rrhh_estado ON solicitudes_rrhh(estado);
CREATE INDEX idx_rrhh_coordinador ON solicitudes_rrhh(coordinador_id);
CREATE INDEX idx_rrhh_cliente ON solicitudes_rrhh(cliente_id);

CREATE TABLE solicitudes_contratacion (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    tipo_solicitud VARCHAR(20) NOT NULL
        CHECK (tipo_solicitud IN ('Nuevo', 'Extension', 'Retiro')),
    estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente'
        CHECK (estado IN ('Pendiente', 'En Proceso', 'Pendiente Confirmación Cliente', 'Pendiente Revision TH', 'Completado', 'Cancelado')),

    coordinador_solicitante_id INT NOT NULL REFERENCES usuarios(id),
    persona_usuario_id INT REFERENCES usuarios(id),
    supervisor_id INT REFERENCES usuarios(id),
    preregistro_id INT,
    cliente_id INT REFERENCES clientes(id),
    tipo_documento_id INT REFERENCES documento_identidad(id),
    origen_flujo VARCHAR(20) NOT NULL DEFAULT 'coordinacion'
        CHECK (origen_flujo IN ('rrhh', 'coordinacion')),

    nombre VARCHAR(150) NOT NULL,
    apellidos VARCHAR(150) NOT NULL,
    numero_documento VARCHAR(50),
    perfil VARCHAR(120),

    correo_personal VARCHAR(255),
    correo_empresarial VARCHAR(255),
    telefono VARCHAR(50),
    ubicacion VARCHAR(120),

    grupo_app_tiempos VARCHAR(150),
    grupo_distribucion VARCHAR(150),

    moneda tipo_moneda,
    tarifa_hora NUMERIC(15,2),
    tarifa_mes NUMERIC(15,2),
    tarifa_medio_tiempo NUMERIC(15,2),
    tarifa_capacitacion NUMERIC(15,2),

    modalidad_contrato VARCHAR(50)
        CHECK (modalidad_contrato IN ('Full time', 'Medio tiempo', 'Por horas')),

    fecha_inicio DATE,
    fecha_fin DATE,
    fecha_extension_desde DATE,
    fecha_extension_hasta DATE,
    fecha_retiro DATE,

    necesidad_ti TEXT,
    observaciones TEXT,
    datos_extra JSONB DEFAULT '{}'::jsonb,

    requiere_confirmacion_cliente BOOLEAN DEFAULT false,
    correo_enviado_mesa BOOLEAN DEFAULT false,
    correo_enviado_th BOOLEAN DEFAULT false,
    correo_confirmacion_coordinador BOOLEAN DEFAULT false,
    revisado_th_por INT REFERENCES usuarios(id),
    fecha_revision_th TIMESTAMP,
    observaciones_th TEXT,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE solicitudes_contratacion IS 'Solicitudes de contrataciones y cambios de contrato (Nuevo, Extension, Retiro)';
COMMENT ON COLUMN solicitudes_contratacion.estado IS 'Pendiente, En Proceso, Pendiente Confirmación Cliente, Pendiente Revision TH, Completado o Cancelado';
COMMENT ON COLUMN solicitudes_contratacion.requiere_confirmacion_cliente IS 'Cuando aplica (ej. HOLCIM), se debe confirmar con el cliente antes de enviar a TH';
COMMENT ON COLUMN solicitudes_contratacion.origen_flujo IS 'Indica si la solicitud nació desde RRHH/preregistro o desde el flujo manual de coordinación';

CREATE INDEX idx_contrataciones_tipo ON solicitudes_contratacion(tipo_solicitud);
CREATE INDEX idx_contrataciones_estado ON solicitudes_contratacion(estado);
CREATE INDEX idx_contrataciones_coordinador ON solicitudes_contratacion(coordinador_solicitante_id);
CREATE INDEX idx_contrataciones_preregistro ON solicitudes_contratacion(preregistro_id) WHERE preregistro_id IS NOT NULL;
CREATE INDEX idx_contrataciones_cliente ON solicitudes_contratacion(cliente_id);
CREATE INDEX idx_contrataciones_documento ON solicitudes_contratacion(numero_documento);
CREATE INDEX idx_contrataciones_created ON solicitudes_contratacion(created_at DESC);

CREATE TABLE preregistro_personas (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    id_solicitud_rrhh INT NOT NULL REFERENCES solicitudes_rrhh(id),

    nombre VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    tipo_documento_id INT NOT NULL REFERENCES documento_identidad(id),
    numero_documento VARCHAR(50) NOT NULL,
    telefono VARCHAR(30),
    correo_personal VARCHAR(150) NOT NULL,
    pais_ubicacion VARCHAR(100),
    ciudad VARCHAR(100),

    cargo cargo_tipo,
    responsable_supervisor_id INT REFERENCES usuarios(id),
    fecha_fin DATE,
    moneda tipo_moneda,
    pais_pago VARCHAR(100),
    tarifa_hora NUMERIC(15,2),
    tarifa_mes NUMERIC(15,2),
    tarifa_medio_tiempo NUMERIC(15,2),
    tarifa_capacitacion NUMERIC(15,2),
    vpn_corona BOOLEAN DEFAULT FALSE,
    necesita_s_user BOOLEAN DEFAULT FALSE,
    grupo_usuario grupo_usuario_tipo,
    grupo_usuario_otro VARCHAR(150),
    grupo_distribucion grupo_distribucion_tipo,
    observaciones TEXT,

    direccion TEXT,
    tipo_persona tipo_persona,
    banco_id INT REFERENCES bancos(id),
    tipo_cuenta_id INT REFERENCES tipo_cuenta_bancaria(id),
    numero_cuenta VARCHAR(50),
    correo_silver VARCHAR(150) UNIQUE,

    estado VARCHAR(50) NOT NULL DEFAULT 'Pendiente Coordinador'
        CHECK (estado IN (
            'Pendiente Coordinador',
            'Pendiente Revision TH',
            'Pendiente Correo Silver',
            'Completado',
            'Anulado'
        )),

    creado_por INT NOT NULL REFERENCES usuarios(id),
    completado_coordinador_por INT REFERENCES usuarios(id),
    completado_th_por INT REFERENCES usuarios(id),
    aprobado_por INT REFERENCES usuarios(id),
    anulado_por INT REFERENCES usuarios(id),

    motivo_anulacion TEXT,
    id_usuario_creado INT REFERENCES usuarios(id),

    fecha_completado_coordinador TIMESTAMP,
    fecha_completado_th TIMESTAMP,
    fecha_aprobacion TIMESTAMP,
    fecha_anulacion TIMESTAMP,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CHECK (
      (grupo_usuario = 'Otro' AND grupo_usuario_otro IS NOT NULL)
      OR (grupo_usuario IS NULL)
      OR (grupo_usuario <> 'Otro' AND grupo_usuario_otro IS NULL)
    )
);

CREATE INDEX idx_preregistro_solicitud ON preregistro_personas(id_solicitud_rrhh);
CREATE INDEX idx_preregistro_estado ON preregistro_personas(estado);
CREATE INDEX idx_preregistro_documento ON preregistro_personas(numero_documento);
CREATE INDEX idx_preregistro_correo_personal ON preregistro_personas(correo_personal);
CREATE INDEX idx_preregistro_correo_silver ON preregistro_personas(correo_silver) WHERE correo_silver IS NOT NULL;
CREATE INDEX idx_preregistro_usuario_creado ON preregistro_personas(id_usuario_creado) WHERE id_usuario_creado IS NOT NULL;
CREATE INDEX idx_preregistro_updated ON preregistro_personas(updated_at DESC);
CREATE UNIQUE INDEX uq_preregistro_solicitud_activa ON preregistro_personas(id_solicitud_rrhh) WHERE estado <> 'Anulado';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_solicitudes_contratacion_preregistro'
  ) THEN
    ALTER TABLE solicitudes_contratacion
      ADD CONSTRAINT fk_solicitudes_contratacion_preregistro
      FOREIGN KEY (preregistro_id) REFERENCES preregistro_personas(id);
  END IF;
END $$;

-- ============================================================================
-- FIRMA DE CONTRATOS: TOKENS PARA PROCESO DE LECTURA Y FIRMA
-- ============================================================================

CREATE TABLE tokens_firma_contrato (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    token VARCHAR(64) UNIQUE NOT NULL,
    solicitud_id INT REFERENCES solicitudes_contratacion(id) ON DELETE SET NULL,
    preregistro_id INT REFERENCES preregistro_personas(id) ON DELETE SET NULL,
    nombre_persona VARCHAR(200) NOT NULL,
    correo_personal VARCHAR(255) NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('pendiente', 'en_proceso', 'completado', 'expirado')),
    checks_completados JSONB NOT NULL DEFAULT '{"pdf1":false,"pdf2":false,"pdf3":false,"pdf4":false,"pdf5":false}',
    docs_firma JSONB NOT NULL DEFAULT '[]',
    firma_completada_notificada_at TIMESTAMP,
    firma_completada_notificada_a VARCHAR(255),
    generado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tokens_firma_token ON tokens_firma_contrato(token);
CREATE INDEX idx_tokens_firma_estado ON tokens_firma_contrato(estado);
CREATE INDEX idx_tokens_firma_correo ON tokens_firma_contrato(correo_personal);
CREATE INDEX idx_tokens_firma_expires ON tokens_firma_contrato(expires_at);

COMMENT ON TABLE tokens_firma_contrato IS 'Tokens de acceso para el proceso publico de revision y firma de contratos';
COMMENT ON COLUMN tokens_firma_contrato.checks_completados IS 'Estado de lectura de cada PDF informativo {pdf1, pdf2, pdf3, pdf4, pdf5}';
COMMENT ON COLUMN tokens_firma_contrato.docs_firma IS 'Array de documentos de firma con request_id ClickSign, estado y URL OneDrive';

-- ============================================================================
-- FIRMA DE CONTRATOS: ITEMS HISTÓRICOS DEL ANEXO TÉCNICO
-- ============================================================================

CREATE TABLE anexo_tecnico_items (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    solicitud_contratacion_id INT REFERENCES solicitudes_contratacion(id) ON DELETE SET NULL,
    preregistro_id INT REFERENCES preregistro_personas(id) ON DELETE SET NULL,
    usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,

    nombre_persona VARCHAR(200) NOT NULL,
    numero_documento VARCHAR(50),
    correo_personal VARCHAR(255),

    tipo_asignacion VARCHAR(20) NOT NULL
        CHECK (tipo_asignacion IN ('full_time', 'medio_tiempo', 'horas', 'capacitacion', 'proyecto')),
    cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_nombre VARCHAR(200),
    modulo_id INT REFERENCES modulo(id) ON DELETE SET NULL,

    moneda VARCHAR(10) CHECK (moneda IN ('COP', 'USD', 'EUR')),
    valor_tarifa NUMERIC(15,2) NOT NULL CHECK (valor_tarifa >= 0),
    fecha_inicio DATE NOT NULL,
    fecha_fin DATE NOT NULL,
    fecha_fin_calculada BOOLEAN NOT NULL DEFAULT false,

    origen VARCHAR(20) NOT NULL DEFAULT 'manual'
        CHECK (origen IN ('manual', 'automatico')),
    estado VARCHAR(20) NOT NULL DEFAULT 'activo'
        CHECK (estado IN ('activo', 'finalizado', 'cancelado')),
    estado_firma VARCHAR(20) NOT NULL DEFAULT 'pendiente'
        CHECK (estado_firma IN ('pendiente', 'enviado', 'firmado')),
    creado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
    updated_by INT REFERENCES usuarios(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    CHECK (
      solicitud_contratacion_id IS NOT NULL
      OR preregistro_id IS NOT NULL
      OR usuario_id IS NOT NULL
    ),
    CHECK (
      (tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto') AND cliente_id IS NOT NULL)
      OR (tipo_asignacion IN ('horas', 'capacitacion') AND cliente_id IS NULL)
    ),
    CHECK (
      (tipo_asignacion IN ('full_time', 'medio_tiempo', 'proyecto') AND fecha_fin >= fecha_inicio)
      OR (
        tipo_asignacion IN ('horas', 'capacitacion')
        AND EXTRACT(YEAR FROM fecha_fin) = EXTRACT(YEAR FROM fecha_inicio)
        AND EXTRACT(MONTH FROM fecha_fin) = 12
        AND EXTRACT(DAY FROM fecha_fin) = 31
      )
    )
);

CREATE INDEX idx_anexo_tecnico_items_doc ON anexo_tecnico_items(numero_documento);
CREATE INDEX idx_anexo_tecnico_items_correo ON anexo_tecnico_items(correo_personal);
CREATE INDEX idx_anexo_tecnico_items_estado ON anexo_tecnico_items(estado);
CREATE INDEX idx_anexo_tecnico_items_estado_firma ON anexo_tecnico_items(estado_firma);
CREATE INDEX idx_anexo_tecnico_items_usuario ON anexo_tecnico_items(usuario_id);
CREATE INDEX idx_anexo_tecnico_items_modulo ON anexo_tecnico_items(modulo_id);
CREATE INDEX idx_anexo_tecnico_items_solicitud ON anexo_tecnico_items(solicitud_contratacion_id) WHERE solicitud_contratacion_id IS NOT NULL;
CREATE INDEX idx_anexo_tecnico_items_preregistro ON anexo_tecnico_items(preregistro_id) WHERE preregistro_id IS NOT NULL;
CREATE INDEX idx_anexo_tecnico_items_fecha ON anexo_tecnico_items(fecha_inicio, fecha_fin);

COMMENT ON TABLE anexo_tecnico_items IS 'Historial acumulado de filas del Anexo Tecnico por persona';
COMMENT ON COLUMN anexo_tecnico_items.tipo_asignacion IS 'full_time, medio_tiempo, horas, capacitacion o proyecto';
COMMENT ON COLUMN anexo_tecnico_items.fecha_fin_calculada IS 'true cuando la fecha_fin se calculó automáticamente (31 de diciembre)';

CREATE TABLE tokens_firma_anexo_individual (
    id SERIAL PRIMARY KEY,
    public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    token VARCHAR(64) UNIQUE NOT NULL,

    usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    anexo_item_ids INT[] NOT NULL,

    correo_firmante VARCHAR(255) NOT NULL,
    nombre_persona VARCHAR(200) NOT NULL,

    estado VARCHAR(20) NOT NULL DEFAULT 'enviado'
        CHECK (estado IN ('enviado', 'firmado', 'rechazado', 'cancelado')),

    request_id VARCHAR(150) UNIQUE,
    contract_id VARCHAR(200) UNIQUE,
    signature_id VARCHAR(150),
    url_firma TEXT,

    onedrive_url TEXT,
    onedrive_carpeta TEXT,
    onedrive_carpeta_url TEXT,

    firmado_at TIMESTAMP,
    cancelado_at TIMESTAMP,
    cancelado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,

    firma_notificada_at TIMESTAMP,
    firma_notificada_a TEXT,

    generado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tokens_firma_anexo_token ON tokens_firma_anexo_individual(token);
CREATE INDEX idx_tokens_firma_anexo_usuario ON tokens_firma_anexo_individual(usuario_id);
CREATE INDEX idx_tokens_firma_anexo_estado ON tokens_firma_anexo_individual(estado);
CREATE INDEX idx_tokens_firma_anexo_request ON tokens_firma_anexo_individual(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX idx_tokens_firma_anexo_contract ON tokens_firma_anexo_individual(contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX idx_tokens_firma_anexo_usuario_enviado
    ON tokens_firma_anexo_individual(usuario_id, estado)
    WHERE estado = 'enviado';

COMMENT ON TABLE tokens_firma_anexo_individual IS 'Procesos de firma individual para anexos tecnicos por usuario';

-- ============================================================================
-- COMPAT: PUBLIC ID FOR EXISTING DATABASES
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  has_unique_public_id BOOLEAN;
  tables TEXT[] := ARRAY[
    'bancos',
    'roles',
    'tipo_cuenta_bancaria',
    'documento_identidad',
    'clientes',
    'tipo_asignacion',
    'modulo',
    'period_1',
    'place_value_1',
    'usuarios',
    'consultorias',
    'tarifa_consultor',
    'registro_asignaciones',
    'cuenta_cobro',
    'reporte_horas',
    'asignaciones_consultoria_mesa_fabrica',
    'permisos_administrador',
    'solicitudes_rrhh',
    'preregistro_personas'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS public_id UUID', t);
    EXECUTE format('UPDATE %I SET public_id = gen_random_uuid() WHERE public_id IS NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN public_id SET DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN public_id SET NOT NULL', t);

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class tbl
      JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_catalog.pg_index i ON i.indrelid = tbl.oid
      JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid
      WHERE ns.nspname = current_schema()
        AND tbl.relname = t
        AND a.attname = 'public_id'
        AND a.attnum = ANY(i.indkey)
        AND i.indisunique
    ) INTO has_unique_public_id;

    IF NOT has_unique_public_id THEN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS idx_%I_public_id ON %I(public_id)', t, t);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- FUNCIONES Y TRIGGERS
-- ============================================================================

-- Función para actualizar el campo updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column
()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar trigger a todas las tablas relevantes
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'updated_at'
        AND table_schema = 'public'
    LOOP
    EXECUTE format(
            'DROP TRIGGER IF EXISTS update_%I_updated_at ON %I',
            t, t
        );
    EXECUTE format
    ('
            CREATE TRIGGER update_%I_updated_at 
            BEFORE UPDATE ON %I
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
            t, t
        );
END
LOOP;
END;
$$;

-- ============================================================================
-- DATOS INICIALES (SEED DATA)
-- ============================================================================


-- Insertar roles básicos
INSERT INTO roles
    (titulo, descripcion, activo)
VALUES
    ('Administrador', 'Administrador del sistema con todos los permisos', true),
    ('Coordinador', 'Coordinador de proyectos', true),
    ('Consultor', 'Consultor externo o interno', true),
    ('Contabilidad', 'equipo contable', true),
    ('Reclutador', 'Usuario encargado de reclutar y gestionar candidatos y consultores', true),
    ('Talento Humano', 'Usuario de Talento Humano para onboarding y aprobacion de preregistros', true);

INSERT INTO documento_identidad
    (titulo, codigo, activo)
VALUES
    ('Cédula de Ciudadanía', 'CC', true),
    ('Cédula de Extranjería', 'CE', true),
    ('Pasaporte', 'PA', true),
    ('NIT', 'NIT', true)
ON CONFLICT (titulo) DO NOTHING;


-- Insertar tipos de asignación (actualizado según tu lista)
INSERT INTO tipo_asignacion
    (titulo, descripcion, activo)
VALUES
    ('Full time', 'Asignación de tiempo completo (40 horas/semana)', true),
    ('Part Time', 'Asignación de medio tiempo', true),
    ('Tiempo y costo fijo', 'Proyectos con tiempo y costo definidos desde el inicio', true),
    ('Horas por demanda', 'Horas asignadas según demanda del cliente', true),
    ('Mesa de servicio', 'Soporte continuo por mesa de servicio/service desk', true),
    ('Fábrica', 'Modelo de fábrica para desarrollo y soporte', true);

-- ============================================================================
-- VISTAS ÚTILES
-- ============================================================================

-- Vista: Asignaciones activas con información completa
CREATE OR REPLACE VIEW v_asignaciones_activas AS
SELECT
    ra.id,
    ra.nro_caso_interno,
    ra.nro_caso_cliente,
    c.titulo as cliente,
    c.nit as cliente_nit,
    u.nombre_usuario as consultor,
    u.email as consultor_email,
    coord.nombre_usuario as coordinador,
    m.titulo as modulo,
    m.nombre_completo as modulo_nombre,
    ta.titulo as tipo_asignacion,
    ra.fecha_inicio,
    ra.fecha_fin,
    ra.estado,
    ra.aprobar_coordinador,
    ra.total_pagar,
    ra.valor_hora,
    ra.cantidad_dias,
    con.descripcion_consultoria
FROM registro_asignaciones ra
    JOIN consultorias con ON ra.id_consultoria = con.id
    JOIN clientes c ON con.id_cliente = c.id
    LEFT JOIN usuarios u ON ra.consultor_responsable_id = u.id
    LEFT JOIN usuarios coord ON con.coordinador_responsable_id = coord.id
    LEFT JOIN modulo m ON ra.id_modulo = m.id
    LEFT JOIN tipo_asignacion ta ON con.id_tipo_asignacion = ta.id
WHERE ra.estado IN ('Abierto', 'Proceso');

COMMENT ON VIEW v_asignaciones_activas IS 'Vista de asignaciones activas con toda la información relacionada';

-- Vista: Reporte de horas pendientes de aprobar
CREATE OR REPLACE VIEW v_reportes_pendientes AS
SELECT
    rh.id,
    c.titulo as cliente,
    c.nit as cliente_nit,
    u.nombre_usuario as consultor,
    u.email as consultor_email,
    coord.nombre_usuario as coordinador,
    rh.horas_reportadas,
    rh.cantidad_dias_reportados,
    rh.total_cobrar,
    rh.estado_reporte,
    rh.nro_caso_int_ext,
    m.titulo as modulo,
    rh.created_at as fecha_reporte,
    rh.fecha_cierre_mesa_fab
FROM reporte_horas rh
    LEFT JOIN clientes c ON rh.cliente_id = c.id
    LEFT JOIN usuarios u ON rh.consultor_responsable_id = u.id
    LEFT JOIN usuarios coord ON rh.coordinador_id = coord.id
    LEFT JOIN modulo m ON rh.modulo_id = m.id
WHERE rh.estado_reporte = 'Pendiente';

COMMENT ON VIEW v_reportes_pendientes IS 'Vista de reportes de horas pendientes de aprobar';

-- Vista: Consultores activos con su información completa
CREATE OR REPLACE VIEW v_consultores_activos AS
SELECT
    u.id,
    u.nombre_usuario,
    u.email,
    u.cedula,
    u.telefono,
    r.titulo as rol,
    u.tipo_consultor,
    u.moneda_cobro,
    b.titulo as banco,
    u.nro_cuenta_bancaria,
    tc.titulo as tipo_cuenta,
    cp.nombre_usuario as consultor_principal,
    u.activo
FROM usuarios u
    LEFT JOIN roles r ON u.rol_usuario_id = r.id
    LEFT JOIN bancos b ON u.banco_id = b.id
    LEFT JOIN tipo_cuenta_bancaria tc ON u.tipo_cuenta_id = tc.id
    LEFT JOIN usuarios cp ON u.id_consultor_principal = cp.id
WHERE u.activo = true
    AND r.titulo IN ('Consultor', 'Consultor Principal');

COMMENT ON VIEW v_consultores_activos IS 'Vista de consultores activos con información completa';

-- Vista: Resumen de facturación por cliente
CREATE OR REPLACE VIEW v_facturacion_por_cliente AS
SELECT
    c.id as cliente_id,
    c.titulo as cliente,
    c.nit,
    COUNT(DISTINCT cc.id) as total_cuentas_cobro,
    SUM(cc.total_cuenta_cobro) as total_facturado,
    COUNT(DISTINCT rh.id) as total_reportes,
    SUM(rh.horas_reportadas) as total_horas,
    MAX(cc.fecha_correspondiente) as ultima_factura
FROM clientes c
    LEFT JOIN reporte_horas rh ON c.id = rh.cliente_id
    LEFT JOIN cuenta_cobro cc ON rh.id_cuenta_cobro = cc.id
GROUP BY c.id, c.titulo, c.nit;

COMMENT ON VIEW v_facturacion_por_cliente IS 'Resumen de facturación por cliente';

-- Vista: Tarifas vigentes
CREATE OR REPLACE VIEW v_tarifas_vigentes AS
SELECT
    tc.id,
    c.titulo as cliente,
    u.nombre_usuario as consultor,
    u.email as consultor_email,
    m.titulo as modulo,
    ta.titulo as tipo_asignacion,
    tc.valor_tarifa,
    tc.vigencia_desde,
    tc.vigencia_hasta,
    tc.activo
FROM tarifa_consultor tc
    JOIN clientes c ON tc.id_cliente = c.id
    JOIN usuarios u ON tc.consultor_id = u.id
    LEFT JOIN modulo m ON tc.modulo_id = m.id
    LEFT JOIN tipo_asignacion ta ON tc.id_tipo_asignacion = ta.id
WHERE tc.activo = true
    AND (tc.vigencia_hasta IS NULL OR tc.vigencia_hasta >= CURRENT_DATE);

COMMENT ON VIEW v_tarifas_vigentes IS 'Tarifas vigentes de consultores';

-- ============================================================================
-- FUNCIONES ÚTILES
-- ============================================================================

-- Función para obtener la tarifa de un consultor
CREATE OR REPLACE FUNCTION obtener_tarifa_consultor
(
    p_consultor_id INTEGER,
    p_cliente_id INTEGER,
    p_modulo_id INTEGER DEFAULT NULL,
    p_tipo_asignacion_id INTEGER DEFAULT NULL
)
RETURNS DECIMAL AS $$
DECLARE
    v_tarifa DECIMAL;
BEGIN
    SELECT valor_tarifa
    INTO v_tarifa
    FROM tarifa_consultor
    WHERE consultor_id = p_consultor_id
        AND id_cliente = p_cliente_id
        AND (p_modulo_id IS NULL OR modulo_id = p_modulo_id)
        AND (p_tipo_asignacion_id IS NULL OR id_tipo_asignacion = p_tipo_asignacion_id)
        AND activo = true
        AND (vigencia_hasta IS NULL OR vigencia_hasta >= CURRENT_DATE)
    ORDER BY vigencia_desde DESC
    LIMIT 1;
    
    RETURN COALESCE(v_tarifa
    , 0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION obtener_tarifa_consultor IS 'Obtiene la tarifa vigente de un consultor para un cliente';

-- Función para convertir número a letras (simplificada)
CREATE OR REPLACE FUNCTION numero_a_letras
(numero DECIMAL)
RETURNS TEXT AS $$
BEGIN
    -- Implementación simplificada
    -- En producción, implementar lógica completa usando las tablas period_1 y place_value_1
    RETURN TRIM(TO_CHAR(numero, '999,999,999,999.99')) || ' pesos';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION numero_a_letras IS 'Convierte un número a su representación en letras (simplificado)';

-- ============================================================================
-- POLÍTICAS DE SEGURIDAD (RLS - Row Level Security)
-- ============================================================================

-- Habilitar RLS en tablas sensibles
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporte_horas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cuenta_cobro ENABLE ROW LEVEL SECURITY;

-- Política: Los usuarios solo pueden ver sus propios reportes
CREATE POLICY reporte_horas_consultor_policy ON reporte_horas
    FOR
SELECT
    USING (consultor_responsable_id = current_setting('app.current_user_id')::INTEGER);

-- Política: Los coordinadores pueden ver reportes de sus consultorías
CREATE POLICY reporte_horas_coordinador_policy ON reporte_horas
    FOR
SELECT
    USING (coordinador_id = current_setting('app.current_user_id')::INTEGER);

-- Política: Admins pueden ver todo
CREATE POLICY reporte_horas_admin_policy ON reporte_horas
    FOR ALL
    USING
(
        EXISTS
(
            SELECT 1
FROM usuarios u
    JOIN roles r ON u.rol_usuario_id = r.id
WHERE u.id = current_setting('app.current_user_id')
::INTEGER
            AND r.titulo = 'Administrador'
        )
    );

-- ============================================================================
-- ÍNDICES ADICIONALES PARA OPTIMIZACIÓN
-- ============================================================================

-- Índices de texto para búsquedas
CREATE INDEX idx_clientes_titulo_trgm ON clientes USING gin
(titulo gin_trgm_ops);
CREATE INDEX idx_usuarios_nombre_trgm ON usuarios USING gin
(nombre_usuario gin_trgm_ops);

-- Índices compuestos para queries frecuentes
CREATE INDEX idx_reporte_horas_compuesto ON reporte_horas(
    estado_reporte, consultor_responsable_id, created_at DESC
);

CREATE INDEX idx_registro_asignaciones_compuesto ON registro_asignaciones(
    estado, consultor_responsable_id, fecha_inicio DESC
);

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================



-- Insertar datos de módulos SAP con descripciones detalladas
INSERT INTO modulo
    (titulo, nombre_completo, descripcion, activo)
VALUES
    ('IT', 'Infraestructura Tecnológica', 'SAP Basis: Administración de sistemas, monitoreo, transporte y optimización de rendimiento SAP', true),
    ('AT', 'Automatizaciones', 'Automatización de procesos en SAP mediante workflows, BAdIs y enhancements', true),
    ('FI', 'Finanzas', 'SAP FI (Financial Accounting): Contabilidad general, cuentas por cobrar/pagar, activos fijos, closing', true),
    ('CO', 'Controlling', 'SAP CO (Controlling): Cost center accounting, internal orders, product costing, profitability analysis', true),
    ('TR', 'Tesorería', 'SAP TR (Treasury): Gestión de tesorería, cash management, gestión de riesgos financieros', true),
    ('SD', 'Ventas', 'SAP SD (Sales & Distribution): Gestión de pedidos, entregas, facturación, pricing y shipping', true),
    ('MM', 'Gestión de materiales', 'SAP MM (Materials Management): Compras, gestión de inventarios, valuation, invoice verification', true),
    ('PP', 'Planificación de Producción', 'SAP PP (Production Planning): MRP, production orders, capacity planning, shop floor control', true),
    ('QM', 'Gestión de calidad', 'SAP QM (Quality Management): Planificación de calidad, inspection, certificates, notification processing', true),
    ('PM', 'Mantenimiento', 'SAP PM (Plant Maintenance): Mantenimiento preventivo/correctivo, órdenes de mantenimiento, gestión de equipos', true),
    ('WF', 'Workflow', 'SAP Workflow: Automatización de procesos de negocio con aprobaciones y routing', true),
    ('PS', 'Proyectos', 'SAP PS (Project System): Gestión de proyectos, WBS, networks, budgeting, settlement', true),
    ('ABAP', 'Abap Developer', 'Desarrollo ABAP: Programación en ABAP, reports, interfaces, enhancements y forms', true),
    ('ABAP TM', 'Abap TM', 'ABAP para Transportation Management: Desarrollo específico para módulo TM', true),
    ('TM', 'Transportation management', 'SAP TM (Transportation Management): Planificación, ejecución y facturación de transporte', true),
    ('HCM', 'Recursos Humanos', 'SAP HCM (Human Capital Management): Administración de personal, nómina, organización y tiempo', true),
    ('BO', 'Business Objects', 'SAP BusinessObjects: Suite de business intelligence, reporting y dashboarding', true),
    ('BW', 'Business Warehouse', 'SAP BW (Business Warehouse): Data warehousing, ETL, modeling, reporting y BEx', true),
    ('Fiori', 'Fiori', 'SAP Fiori: UX para aplicaciones SAP basada en diseño responsive y user-friendly', true),
    ('CPI', 'Cloud', 'SAP CPI (Cloud Platform Integration): Integración en la nube, middlewares y APIs', true),
    ('BPC', 'Business Planning and Consolidation', 'SAP BPC: Planning, budgeting, forecasting y financial consolidation', true),
    ('EWM', 'Extended Warehouse Manager', 'SAP EWM: Gestión avanzada de almacenes, cross-docking y yard management', true),
    ('DS', 'Data Services', 'SAP Data Services: ETL, data quality, profiling y integration', true),
    ('FM', 'Funds Management', 'SAP FM (Funds Management): Budgeting público, fondos y commitment management', true),
    ('LETRA', 'Logistics (LE) Transportation (TRA)', 'Logística y transporte en SAP LE-TRA', true),
    ('GRC', 'Governance Risk and Compliance', 'SAP GRC: Gestión de riesgos, controles de acceso y compliance', true),
    ('SQL', 'MS SQL', 'Administración de bases de datos SQL Server para entornos SAP', true),
    ('ISH', 'Gestión Hospitalaria', 'SAP IS-H (Industry Solution Healthcare): Soluciones para el sector salud', true),
    ('SAC', 'SAP Analytic Cloud', 'SAP SAC: Analytics en la nube, planning y business intelligence', true),
    ('BTP', 'SAP Business Technology Platform', 'SAP BTP: Plataforma para desarrollo, integración y extensión de aplicaciones', true),
    ('WM', 'Gestión de Almacenes', 'SAP WM (Warehouse Management): Gestión básica de almacenes, picking y putaway', true),
    ('PBI', 'Power BI', 'Integración de Power BI con SAP para reporting y visualizaciones', true),
    ('.NET', '.NET', 'Desarrollo .NET para integraciones con SAP y aplicaciones complementarias', true),
    ('B2B', 'B2B', 'Integraciones B2B con SAP mediante IDOCs, EDIs y middlewares', true),
    ('MDG', 'NetWeaver Master Data Management', 'SAP MDG (Master Data Governance): Gestión y gobierno de datos maestros', true),
    ('SLCM', 'Student Lifecycle Management', 'SAP SLCM: Solución para gestión del ciclo de vida estudiantil en educación', true),
    ('Gerente', 'Gerente de proyectos', 'Project Management Office (PMO) para implementaciones SAP', true),
    ('Datos', 'Ingeniero de datos', 'Data engineering, arquitectura de datos y gestión de data lakes para SAP', true),
    ('TRM', 'Treasury and Risk Management', 'SAP TRM: Treasury avanzado y gestión de riesgos financieros', true),
    ('IBP', 'Integrated Business Planning', 'SAP IBP: Planning de ventas y operaciones en tiempo real', true),
    ('BASIS', 'BASIS', 'Administración SAP Basis: Instalación, configuración, monitoreo y performance tuning', true),
    ('PI/PO', 'PI/PO', 'SAP Process Integration/Process Orchestration: Middleware para integraciones', true),
    ('ARIBA', 'ARIBA', 'SAP Ariba: Procurement, sourcing y supply chain collaboration', true),
    ('Cambio', 'Gestión del cambio', 'Change Management para implementaciones y transformaciones SAP', true),
    ('CS', 'CS', 'SAP CS (Customer Service): Gestión de servicios post-venta y mantenimiento', true),
    ('BCS', 'BCS', 'SAP BCS (Business Consolidation System): Consolidación financiera', true),
    ('UIPath', 'UIPath', 'Automatización robótica de procesos (RPA) para SAP con UIPath', true),
    ('DATOS', 'Datos maestros', 'Gestión y mantenimiento de datos maestros en SAP (materiales, clientes, proveedores)', true),
    ('VMS', 'VMS', 'Vendor Management System para gestión de proveedores', true),
    ('RE', 'Bienes Inmuebles', 'SAP RE (Real Estate): Gestión de activos inmobiliarios y leasing', true),
    ('LBN', 'LBN', 'Logistics Business Network de SAP', true),
    ('B1', 'Business One', 'SAP Business One: ERP para pequeñas y medianas empresas', true),
    ('CML', 'CML', 'SAP Commercial Project Management', true),
    ('SSF', 'SUCCESS FACTOR', 'SAP SuccessFactors: Solución completa de gestión del talento en la nube', true),
    ('FICA', 'FI CONTRATOS', 'SAP FICA (Financial Contract Accounting): Contabilidad de contratos para utilities', true),
    ('SSFF', 'Success Factor', 'SAP SuccessFactors especializado en áreas específicas', true),
    ('C4C', 'C4C', 'SAP Cloud for Customer: CRM en la nube para ventas y servicio', true),
    ('FRONTEND', 'FRONTEND', 'Desarrollo frontend para interfaces SAP: Fiori, WebDynpro, interfaces web', true);



