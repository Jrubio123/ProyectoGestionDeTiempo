-- ============================================================================
-- Script de Inicialización - Base de Datos Gestión de Tiempo y Consultorías
-- PostgreSQL 16
-- Migración desde SharePoint/PowerApps
-- ============================================================================

-- Extensiones útiles
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- Para búsquedas de texto

-- ============================================================================
-- TIPOS ENUMERADOS (Reemplazo de Choice de SharePoint)
-- ============================================================================

-- Estados de Aprobación
CREATE TYPE tipo_aprobacion AS ENUM (
    'Aprobado',
    'Rechazado',
    'Pendiente'
);

-- Estados de Asignación
CREATE TYPE tipo_estado_asignacion AS ENUM (
    'Activo',
    'Inactivo',
    'Completado',
    'Cancelado'
);

-- Tipos de Servicio
CREATE TYPE tipo_servicio AS ENUM (
    'Servicio',
    'Requerimiento',
    'Soporte',
    'Consultoría'
);

-- Estados de Reporte
CREATE TYPE tipo_estado_reporte AS ENUM (
    'Aprobado',
    'Pendiente',
    'Rechazado',
    'Revisión'
);

-- Estados de Mesa de Servicio
CREATE TYPE tipo_estado_mesa AS ENUM (
    'Abierto',
    'Cerrado',
    'En Proceso',
    'Suspendido'
);

-- Estados de Fábrica
CREATE TYPE tipo_estado_fabrica AS ENUM (
    'Finalizado',
    'En Proceso',
    'Pendiente',
    'Cancelado'
);

-- Tipos de Persona
CREATE TYPE tipo_persona AS ENUM (
    'Natural',
    'Jurídica'
);

-- Monedas
CREATE TYPE tipo_moneda AS ENUM (
    'COP',
    'USD',
    'EUR'
);

-- Tipos de Consultor
CREATE TYPE tipo_consultor_enum AS ENUM (
    'Interno',
    'Externo',
    'Asociado'
);

-- ============================================================================
-- TABLAS DE CATÁLOGO (Tablas maestras sin dependencias)
-- ============================================================================

-- Tabla: Bancos
CREATE TABLE bancos (
    id SERIAL PRIMARY KEY,
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
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL UNIQUE,
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_roles_activo ON roles(activo);

COMMENT ON TABLE roles IS 'Roles de usuario en el sistema';

-- Tabla: TipoCuentaBancaria
CREATE TABLE tipo_cuenta_bancaria (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL,
    tipo_cuenta INTEGER,
    tipo_transaccion VARCHAR(100),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE tipo_cuenta_bancaria IS 'Tipos de cuenta bancaria (Ahorros, Corriente, etc)';

-- Tabla: DocumentoIdentidad
CREATE TABLE documento_identidad (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL UNIQUE,
    codigo VARCHAR(10),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE documento_identidad IS 'Tipos de documento de identidad';

-- Tabla: Clientes
CREATE TABLE clientes (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL, -- Nombre de la empresa
    nit VARCHAR(50) UNIQUE NOT NULL,
    prefijo VARCHAR(20),
    correlativo INTEGER,
    activo BOOLEAN DEFAULT true,
    
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

-- Tabla: TipoAsignacion
CREATE TABLE tipo_asignacion (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(255) NOT NULL UNIQUE, -- Full Time, Part Time, Mesa Fábrica, etc
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tipo_asignacion_activo ON tipo_asignacion(activo);

COMMENT ON TABLE tipo_asignacion IS 'Tipos de asignación de consultores';

-- Tabla: Modulo
CREATE TABLE modulo (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(50) NOT NULL UNIQUE, -- IT, AT, FI
    nombre_completo VARCHAR(255),
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_modulo_activo ON modulo(activo);

COMMENT ON TABLE modulo IS 'Módulos de consultoría (IT, AT, FI, etc)';

-- Tabla: PerfilCasoFabrica
-- Esta tabla cataloga los perfiles que antes estaban "quemados"
CREATE TABLE perfil_caso_fabrica (
    id SERIAL PRIMARY KEY,
    titulo VARCHAR(100) NOT NULL UNIQUE, -- ABAP, ABAP TM, CPI, etc
    descripcion TEXT,
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE perfil_caso_fabrica IS 'Catálogo de perfiles para casos de fábrica';

-- Tablas auxiliares para conversión de números a letras
CREATE TABLE period_1 (
    id SERIAL PRIMARY KEY,
    group_number INTEGER NOT NULL,
    titulo VARCHAR(50) NOT NULL
);

COMMENT ON TABLE period_1 IS 'Periodos para conversión de números a letras (Mil, Millón, Billón)';

CREATE TABLE place_value_1 (
    id SERIAL PRIMARY KEY,
    digit INTEGER NOT NULL,
    titulo VARCHAR(50) NOT NULL,
    column_value INTEGER NOT NULL
);

COMMENT ON TABLE place_value_1 IS 'Valores de lugar para conversión de números a letras';

-- ============================================================================
-- TABLA DE USUARIOS (Reemplazo de campos Person/Group de SharePoint)
-- ============================================================================

CREATE TABLE usuarios (
    id SERIAL PRIMARY KEY,
    
    -- Información de usuario (Person/Group de SharePoint)
    nombre_usuario VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT,
    
    -- Información de SharePoint (para migración)
    sharepoint_user_id VARCHAR(255), -- ID del usuario en SharePoint
    sharepoint_login_name VARCHAR(255), -- LoginName de SharePoint
    
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
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255)
);

-- Índices para usuarios
CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_usuarios_rol ON usuarios(rol_usuario_id);
CREATE INDEX idx_usuarios_activo ON usuarios(activo);
CREATE INDEX idx_usuarios_sharepoint_id ON usuarios(sharepoint_user_id);
CREATE INDEX idx_usuarios_tipo_consultor ON usuarios(tipo_consultor);

COMMENT ON TABLE usuarios IS 'Usuarios del sistema - Reemplaza campos Person/Group de SharePoint';
COMMENT ON COLUMN usuarios.sharepoint_user_id IS 'ID del usuario en SharePoint para migración';
COMMENT ON COLUMN usuarios.email IS 'Email del usuario - usado para mapear Person/Group';

-- ============================================================================
-- TABLAS DE GESTIÓN DE CONSULTORÍAS
-- ============================================================================

-- Tabla: Consultorias
CREATE TABLE consultorias (
    id SERIAL PRIMARY KEY,
    descripcion_consultoria TEXT,
    id_cliente INTEGER NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
    
    -- Coordinador (antes Person/Group, ahora FK a usuarios)
    coordinador_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    
    id_tipo_asignacion INTEGER REFERENCES tipo_asignacion(id) ON DELETE SET NULL,
    asignado_consultor BOOLEAN DEFAULT false,
    
    activo BOOLEAN DEFAULT true,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_by INTEGER REFERENCES usuarios(id)
);

CREATE INDEX idx_consultorias_cliente ON consultorias(id_cliente);
CREATE INDEX idx_consultorias_coordinador ON consultorias(coordinador_responsable_id);
CREATE INDEX idx_consultorias_activo ON consultorias(activo);
CREATE INDEX idx_consultorias_tipo ON consultorias(id_tipo_asignacion);

COMMENT ON TABLE consultorias IS 'Proyectos de consultoría para clientes';

-- Tabla: TarifaConsultor
CREATE TABLE tarifa_consultor (
    id SERIAL PRIMARY KEY,
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
CREATE TABLE registro_asignaciones (
    id SERIAL PRIMARY KEY,
    id_consultoria INTEGER NOT NULL REFERENCES consultorias(id) ON DELETE CASCADE,
    id_tarifa INTEGER REFERENCES tarifa_consultor(id) ON DELETE SET NULL,
    id_modulo INTEGER REFERENCES modulo(id) ON DELETE SET NULL,
    
    -- Consultor (antes Person/Group, ahora FK a usuarios)
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    
    -- Aprobación y estado (antes Choice en SharePoint)
    aprobar_coordinador tipo_aprobacion DEFAULT 'Pendiente',
    estado tipo_estado_asignacion DEFAULT 'Activo',
    
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
CREATE TABLE cuenta_cobro (
    id SERIAL PRIMARY KEY,
    descripcion TEXT,
    fecha_correspondiente DATE,
    total_cuenta_cobro DECIMAL(15, 2),
    fecha_periodo_inicio DATE NOT NULL,
    fecha_periodo_fin DATE NOT NULL,
    total_letras TEXT, -- Valor en letras
    ciudad_cobro VARCHAR(255),
    
    -- Archivos adjuntos (ruta o JSON con metadata)
    datos_adjuntos JSONB, -- Metadata de archivos adjuntos
    
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
CREATE TABLE reporte_horas (
    id SERIAL PRIMARY KEY,
    id_registro_asignacion INTEGER NOT NULL REFERENCES registro_asignaciones(id) ON DELETE CASCADE,
    id_cuenta_cobro INTEGER REFERENCES cuenta_cobro(id) ON DELETE SET NULL,
    
    -- Horas y días
    horas_reportadas DECIMAL(10, 2),
    cantidad_dias_reportados INTEGER,
    total_cobrar DECIMAL(15, 2),
    
    -- Información del reporte
    requerimiento TEXT,
    es_costo_total BOOLEAN DEFAULT false,
    nro_caso_int_ext TEXT,
    
    -- Referencias (convertidas de texto "quemado" a lookup)
    cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    tipo_asignacion_id INTEGER REFERENCES tipo_asignacion(id) ON DELETE SET NULL,
    modulo_id INTEGER REFERENCES modulo(id) ON DELETE SET NULL,
    perfil_caso_fabrica_id INTEGER REFERENCES perfil_caso_fabrica(id) ON DELETE SET NULL,
    
    -- Usuarios (antes Person/Group o email quemado, ahora FK)
    coordinador_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    consultor_principal_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    
    -- Información de servicio
    tipo_servicio VARCHAR(100), -- Texto libre por ahora
    
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

-- Tabla: AsignacionesConsultoriaMesaFabrica
CREATE TABLE asignaciones_consultoria_mesa_fabrica (
    id SERIAL PRIMARY KEY,
    id_consultoria INTEGER NOT NULL REFERENCES consultorias(id) ON DELETE CASCADE,
    
    -- Consultor (antes Person/Group, ahora FK a usuarios)
    consultor_responsable_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    
    valor_hora DECIMAL(15, 2),
    estado_asignacion tipo_estado_asignacion DEFAULT 'Activo',
    id_modulo INTEGER REFERENCES modulo(id) ON DELETE SET NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_asig_mesa_consultoria ON asignaciones_consultoria_mesa_fabrica(id_consultoria);
CREATE INDEX idx_asig_mesa_consultor ON asignaciones_consultoria_mesa_fabrica(consultor_responsable_id);
CREATE INDEX idx_asig_mesa_estado ON asignaciones_consultoria_mesa_fabrica(estado_asignacion);

COMMENT ON TABLE asignaciones_consultoria_mesa_fabrica IS 'Asignaciones específicas de mesa de fábrica';

-- Tabla: PermisosAdministrador
CREATE TABLE permisos_administrador (
    id SERIAL PRIMARY KEY,
    
    -- Coordinador (antes Person/Group, ahora FK a usuarios)
    coordinador_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    
    tipo_servicio tipo_servicio,
    permiso_activo BOOLEAN DEFAULT true,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_permisos_coordinador ON permisos_administrador(coordinador_id);
CREATE INDEX idx_permisos_activo ON permisos_administrador(permiso_activo);

COMMENT ON TABLE permisos_administrador IS 'Permisos de coordinadores para tipos de servicio';

-- ============================================================================
-- FUNCIONES Y TRIGGERS
-- ============================================================================

-- Función para actualizar el campo updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
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
        EXECUTE format('
            CREATE TRIGGER update_%I_updated_at 
            BEFORE UPDATE ON %I
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
            t, t
        );
    END LOOP;
END;
$$;

-- ============================================================================
-- DATOS INICIALES (SEED DATA)
-- ============================================================================

-- Insertar datos básicos para Period_1 (conversión a letras)
INSERT INTO period_1 (group_number, titulo) VALUES
(1, 'Mil'),
(2, 'Millón'),
(3, 'Billón'),
(4, 'Trillón');

-- Insertar datos básicos para PlaceValue_1
INSERT INTO place_value_1 (digit, titulo, column_value) VALUES
(0, 'Cero', 1),
(1, 'Uno', 1),
(2, 'Dos', 1),
(3, 'Tres', 1),
(4, 'Cuatro', 1),
(5, 'Cinco', 1),
(6, 'Seis', 1),
(7, 'Siete', 1),
(8, 'Ocho', 1),
(9, 'Nueve', 1),
(10, 'Diez', 10),
(20, 'Veinte', 10),
(30, 'Treinta', 10),
(40, 'Cuarenta', 10),
(50, 'Cincuenta', 10),
(60, 'Sesenta', 10),
(70, 'Setenta', 10),
(80, 'Ochenta', 10),
(90, 'Noventa', 10),
(100, 'Ciento', 100),
(200, 'Docientos', 100),
(300, 'Trecientos', 100),
(400, 'Cuatrocientos', 100),
(500, 'Quinientos', 100),
(600, 'Seiscientos', 100),
(700, 'Setecientos', 100),
(800, 'Ochocientos', 100),
(900, 'Novecientos', 100);

-- Insertar roles básicos
INSERT INTO roles (titulo, descripcion, activo) VALUES
('Administrador', 'Administrador del sistema con todos los permisos', true),
('Coordinador', 'Coordinador de proyectos', true),
('Consultor', 'Consultor externo o interno', true),
('Consultor Principal', 'Consultor líder de equipo', true),
('Mesa de Servicio', 'Soporte y mesa de servicio', true);

-- Insertar tipos de documento
INSERT INTO documento_identidad (titulo, codigo, activo) VALUES
('Cédula de Ciudadanía', 'CC', true),
('Cédula de Extranjería', 'CE', true),
('Pasaporte', 'PA', true),
('NIT', 'NIT', true),
('Tarjeta de Identidad', 'TI', true);

-- Insertar tipos de cuenta bancaria
INSERT INTO tipo_cuenta_bancaria (titulo, tipo_cuenta, tipo_transaccion, activo) VALUES
('Cuenta de Ahorros', 1, '37', true),
('Cuenta Corriente', 2, '27', true);

-- Insertar módulos básicos
INSERT INTO modulo (titulo, nombre_completo, descripcion, activo) VALUES
('IT', 'Integration Technologies', 'Módulo de tecnologías de integración SAP', true),
('AT', 'Analytical Technologies', 'Módulo de tecnologías analíticas y BI', true),
('FI', 'Finance', 'Módulo financiero SAP', true),
('MM', 'Materials Management', 'Módulo de gestión de materiales', true),
('SD', 'Sales and Distribution', 'Módulo de ventas y distribución', true),
('PP', 'Production Planning', 'Módulo de planificación de producción', true),
('HR', 'Human Resources', 'Módulo de recursos humanos', true);

-- Insertar tipos de asignación
INSERT INTO tipo_asignacion (titulo, descripcion, activo) VALUES
('Full Time', 'Asignación de tiempo completo', true),
('Part Time', 'Asignación de medio tiempo', true),
('Mesa de Fábrica', 'Asignación por mesa de fábrica', true),
('Por Horas', 'Asignación por horas', true),
('Por Proyecto', 'Asignación por proyecto específico', true);

-- Insertar perfiles de caso fábrica
INSERT INTO perfil_caso_fabrica (titulo, descripcion, activo) VALUES
('ABAP', 'Desarrollador ABAP', true),
('ABAP TM', 'ABAP Transportation Management', true),
('CPI', 'Cloud Platform Integration', true),
('FIORI', 'Desarrollador FIORI/UI5', true),
('BASIS', 'Administrador BASIS', true),
('FUNCIONAL FI', 'Consultor Funcional Finanzas', true),
('FUNCIONAL MM', 'Consultor Funcional Materiales', true),
('FUNCIONAL SD', 'Consultor Funcional Ventas', true);

-- Insertar algunos bancos colombianos comunes
INSERT INTO bancos (titulo, codigo_bancolombia, codigo_conversor, activo) VALUES
('Bancolombia', '007', '1007', true),
('Banco de Bogotá', '001', '1001', true),
('Davivienda', '051', '1051', true),
('BBVA Colombia', '013', '1013', true),
('Banco Popular', '002', '1002', true),
('Banco Occidente', '023', '1023', true),
('Banco AV Villas', '052', '1052', true),
('Banco Caja Social', '032', '1032', true);

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
WHERE ra.estado = 'Activo';

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
CREATE OR REPLACE FUNCTION obtener_tarifa_consultor(
    p_consultor_id INTEGER,
    p_cliente_id INTEGER,
    p_modulo_id INTEGER DEFAULT NULL,
    p_tipo_asignacion_id INTEGER DEFAULT NULL
)
RETURNS DECIMAL AS $$
DECLARE
    v_tarifa DECIMAL;
BEGIN
    SELECT valor_tarifa INTO v_tarifa
    FROM tarifa_consultor
    WHERE consultor_id = p_consultor_id
    AND id_cliente = p_cliente_id
    AND (p_modulo_id IS NULL OR modulo_id = p_modulo_id)
    AND (p_tipo_asignacion_id IS NULL OR id_tipo_asignacion = p_tipo_asignacion_id)
    AND activo = true
    AND (vigencia_hasta IS NULL OR vigencia_hasta >= CURRENT_DATE)
    ORDER BY vigencia_desde DESC
    LIMIT 1;
    
    RETURN COALESCE(v_tarifa, 0);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION obtener_tarifa_consultor IS 'Obtiene la tarifa vigente de un consultor para un cliente';

-- Función para convertir número a letras (simplificada)
CREATE OR REPLACE FUNCTION numero_a_letras(numero DECIMAL)
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
    FOR SELECT
    USING (consultor_responsable_id = current_setting('app.current_user_id')::INTEGER);

-- Política: Los coordinadores pueden ver reportes de sus consultorías
CREATE POLICY reporte_horas_coordinador_policy ON reporte_horas
    FOR SELECT
    USING (coordinador_id = current_setting('app.current_user_id')::INTEGER);

-- Política: Admins pueden ver todo
CREATE POLICY reporte_horas_admin_policy ON reporte_horas
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM usuarios u
            JOIN roles r ON u.rol_usuario_id = r.id
            WHERE u.id = current_setting('app.current_user_id')::INTEGER
            AND r.titulo = 'Administrador'
        )
    );

-- ============================================================================
-- ÍNDICES ADICIONALES PARA OPTIMIZACIÓN
-- ============================================================================

-- Índices de texto para búsquedas
CREATE INDEX idx_clientes_titulo_trgm ON clientes USING gin(titulo gin_trgm_ops);
CREATE INDEX idx_usuarios_nombre_trgm ON usuarios USING gin(nombre_usuario gin_trgm_ops);

-- Índices compuestos para queries frecuentes
CREATE INDEX idx_reporte_horas_compuesto ON reporte_horas(
    estado_reporte, consultor_responsable_id, created_at DESC
);

CREATE INDEX idx_registro_asignaciones_compuesto ON registro_asignaciones(
    estado, consultor_responsable_id, fecha_inicio DESC
);

-- ============================================================================
-- COMENTARIOS FINALES
-- ============================================================================

COMMENT ON DATABASE CURRENT_DATABASE() IS 'Sistema de Gestión de Tiempo y Consultorías - Migrado desde SharePoint/PowerApps';

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================