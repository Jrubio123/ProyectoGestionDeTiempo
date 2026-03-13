# ============================================================
# Script de prueba completa del flujo de asignaciones
# Ejecutar desde la raiz del proyecto con Docker corriendo
# Trigger técnico de commit para validar pipeline de despliegue (2026-03-13)
# ============================================================

$BASE = "http://localhost:4000"
$PASS = "Test123!"
$OK = 0; $FAIL = 0

function Invoke-Api {
    param($Method, $Path, $Body, $Token, $Label)
    $headers = @{ "Content-Type" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $bodyJson = if ($Body) { $Body | ConvertTo-Json -Depth 10 -Compress } else { $null }
    try {
        $params = @{ Uri = "$BASE$Path"; Method = $Method; Headers = $headers; UseBasicParsing = $true }
        if ($bodyJson) { $params["Body"] = $bodyJson }
        $resp = Invoke-WebRequest @params
        $data = $resp.Content | ConvertFrom-Json
        Write-Host "  [OK] $Label" -ForegroundColor Green
        $script:OK++
        return $data
    } catch {
        $errBody = try { $_.ErrorDetails.Message | ConvertFrom-Json } catch { @{ error = $_.Exception.Message } }
        Write-Host "  [FAIL] $Label -> $($errBody.error)" -ForegroundColor Red
        $script:FAIL++
        return $null
    }
}

Write-Host "`n=== SETUP: Creando usuario Admin en la BD ===" -ForegroundColor Cyan

# Generar hash bcrypt para la password usando node dentro del contenedor
$hash = docker exec gestion_tiempo_back node -e "const b=require('bcrypt');b.hash('$PASS',10).then(h=>process.stdout.write(h))" 2>&1
if (-not $hash -or $hash -notmatch '^\$2b\$') {
    Write-Host "  [FAIL] No se pudo generar hash. Verifica que el contenedor back este corriendo." -ForegroundColor Red
    exit 1
}
Write-Host "  Hash generado correctamente" -ForegroundColor Gray

# Insertar admin directamente en BD (register solo crea Consultor)
$sql = "INSERT INTO usuarios (nombre_usuario, email, password_hash, rol_usuario_id, activo) SELECT 'Admin Test', 'admin@silverconsulting.com.co', '$hash', r.id, true FROM roles r WHERE r.titulo = 'Administrador' ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol_usuario_id = EXCLUDED.rol_usuario_id RETURNING email;"
$dbRes = docker exec gestion_tiempo_db psql -U postgres -d gestion_tiempo -c $sql 2>&1
Write-Host "  BD: $($dbRes -join ' ')" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 1: Login y setup de roles ===" -ForegroundColor Cyan

$adminLogin = Invoke-Api POST "/auth/login" @{ email = "admin@silverconsulting.com.co"; password = $PASS } -Label "Login Admin"
if (-not $adminLogin) { Write-Host "ABORTANDO: no se pudo logear como admin" -ForegroundColor Red; exit 1 }
$A = $adminLogin.token

# Obtener IDs de roles
$roles = Invoke-Api GET "/admin/roles" -Token $A -Label "Obtener roles"
$rolCoord = ($roles | Where-Object { $_.titulo -eq "Coordinador" }).id
$rolAdmin  = ($roles | Where-Object { $_.titulo -eq "Administrador" }).id
Write-Host "  Roles: Coordinador=$rolCoord" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 2: Registrar usuarios de prueba ===" -ForegroundColor Cyan

# Limpiar usuarios de corridas anteriores para evitar conflictos
$emailsTest = @("coord1@silverconsulting.com.co","coord2@silverconsulting.com.co","consultor@silverconsulting.com.co")
$delSql = "UPDATE usuarios SET activo=false WHERE email IN ('" + ($emailsTest -join "','") + "');"
docker exec gestion_tiempo_db psql -U postgres -d gestion_tiempo -c $delSql | Out-Null

# Eliminar para poder re-registrar (soft delete no basta, hay unique en email)
$delSql2 = "DELETE FROM usuarios WHERE email IN ('" + ($emailsTest -join "','") + "');"
docker exec gestion_tiempo_db psql -U postgres -d gestion_tiempo -c $delSql2 | Out-Null
Write-Host "  Usuarios de prueba anteriores eliminados" -ForegroundColor Gray

$regCoord1 = Invoke-Api POST "/auth/register" @{ nombre_usuario = "Coord Uno Test"; email = "coord1@silverconsulting.com.co"; password = $PASS } -Label "Registrar Coordinador 1"
$regCoord2 = Invoke-Api POST "/auth/register" @{ nombre_usuario = "Coord Dos Test"; email = "coord2@silverconsulting.com.co"; password = $PASS } -Label "Registrar Coordinador 2"
$regConsul = Invoke-Api POST "/auth/register" @{ nombre_usuario = "Consultor Test"; email = "consultor@silverconsulting.com.co"; password = $PASS } -Label "Registrar Consultor"

# Obtener public_ids de los usuarios recien creados
$allUsers = Invoke-Api GET "/admin/usuarios-roles" -Token $A -Label "Listar usuarios"

# Where-Object puede devolver PSCustomObject o array — forzar obtención segura
$uCoord1 = @($allUsers | Where-Object { $_.email -eq "coord1@silverconsulting.com.co" })[0]
$uCoord2 = @($allUsers | Where-Object { $_.email -eq "coord2@silverconsulting.com.co" })[0]
$uConsul  = @($allUsers | Where-Object { $_.email -eq "consultor@silverconsulting.com.co" })[0]

Write-Host "  IDs encontrados: Coord1=$($uCoord1.id) Coord2=$($uCoord2.id) Consul=$($uConsul.id)" -ForegroundColor Gray

# Cambiar roles a Coordinador
Invoke-Api PUT "/admin/usuarios/$($uCoord1.id)/rol" @{ rol_id = $rolCoord } -Token $A -Label "Asignar rol Coordinador a Coord1" | Out-Null
Invoke-Api PUT "/admin/usuarios/$($uCoord2.id)/rol" @{ rol_id = $rolCoord } -Token $A -Label "Asignar rol Coordinador a Coord2" | Out-Null

# ============================================================
Write-Host "`n=== PASO 3: Crear catalogo (cliente y modulo) ===" -ForegroundColor Cyan

# Intentar crear; si ya existe, reusar el existente
$cliente = Invoke-Api POST "/clientes" @{ titulo = "Cliente Test SA"; nit = "900123456-1"; prefijo = "CT" } -Token $A -Label "Crear cliente"
if (-not $cliente) {
    $todosClientes = Invoke-Api GET "/clientes" -Token $A -Label "Reusar cliente existente"
    $cliente = @($todosClientes | Where-Object { $_.titulo -eq "Cliente Test SA" })[0]
    if ($cliente) { Write-Host "  Reusando cliente existente: $($cliente.id)" -ForegroundColor Yellow }
}

$modulos = Invoke-Api GET "/admin/modulos" -Token $A -Label "Listar modulos"
$modulo = $modulos | Select-Object -First 1
if (-not $modulo) {
    $modulo = Invoke-Api POST "/admin/modulos" @{ titulo = "SAP FI"; nombre_completo = "SAP Finance"; descripcion = "Modulo financiero" } -Token $A -Label "Crear modulo"
}
Write-Host "  Usando modulo: $($modulo.titulo) (id=$($modulo.id))" -ForegroundColor Gray

# Obtener tipos de asignacion
$tiposAsig = Invoke-Api GET "/tipos-asignacion" -Token $A -Label "Obtener tipos asignacion"
$tipoFulltime    = (@($tiposAsig | Where-Object { $_.titulo -match "Full" })[0]).id
$tipoMesa        = (@($tiposAsig | Where-Object { $_.titulo -match "Mesa" })[0]).id
Write-Host "  Tipos: Fulltime=$tipoFulltime  Mesa=$tipoMesa" -ForegroundColor Gray
Write-Host "  Cliente id: $($cliente.id)" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 4: Login como coordinadores ===" -ForegroundColor Cyan

$c1Login = Invoke-Api POST "/auth/login" @{ email = "coord1@silverconsulting.com.co"; password = $PASS } -Label "Login Coord1"
$c2Login = Invoke-Api POST "/auth/login" @{ email = "coord2@silverconsulting.com.co"; password = $PASS } -Label "Login Coord2"
$consulLogin = Invoke-Api POST "/auth/login" @{ email = "consultor@silverconsulting.com.co"; password = $PASS } -Label "Login Consultor"
$C1 = $c1Login.token; $C2 = $c2Login.token; $CX = $consulLogin.token

# ============================================================
Write-Host "`n=== PASO 5: Coordinadores crean consultorias ===" -ForegroundColor Cyan

if (-not $cliente) { Write-Host "  [SKIP] No hay cliente disponible - abortando pasos 5+" -ForegroundColor Red; exit 1 }
if (-not $uCoord1.id -or -not $uCoord2.id -or -not $uConsul.id) { Write-Host "  [SKIP] Faltan IDs de usuarios" -ForegroundColor Red; exit 1 }
Write-Host "  Usando cliente=$($cliente.id) coord1=$($uCoord1.id) coord2=$($uCoord2.id) consultor=$($uConsul.id)" -ForegroundColor Gray

# Mismo cliente, mismo modulo pero diferente coordinador
$consult1 = Invoke-Api POST "/consultorias" @{
    cliente_id = $cliente.id
    coordinador_id = $uCoord1.id
    tipo_asignacion_id = $tipoFulltime
    descripcion_consultoria = "Proyecto Full Time - Coord1"
} -Token $C1 -Label "Coord1 crea consultoria Full Time"

$consult2 = Invoke-Api POST "/consultorias" @{
    cliente_id = $cliente.id
    coordinador_id = $uCoord2.id
    tipo_asignacion_id = $tipoMesa
    descripcion_consultoria = "Proyecto Mesa Servicio - Coord2"
} -Token $C2 -Label "Coord2 crea consultoria Mesa de Servicio"

# ============================================================
Write-Host "`n=== PASO 6: Coordinadores crean asignaciones con tarifas ===" -ForegroundColor Cyan

$hoy = (Get-Date).ToString("yyyy-MM-dd")
$finMes = (Get-Date -Day 1).AddMonths(1).AddDays(-1).ToString("yyyy-MM-dd")

# Full Time: se pasa valor_hora directamente
$asig1 = Invoke-Api POST "/registro-asignaciones" @{
    id_consultoria           = $consult1.id
    id_modulo                = $modulo.id
    consultor_responsable_id = $uConsul.id
    fecha_inicio             = $hoy
    fecha_fin                = $finMes
    horas_asignadas          = 160
    cantidad_dias            = 20
    valor_hora               = 75000
    tipo_servicio            = "Servicio"
    es_costo_total           = $false
} -Token $C1 -Label "Coord1 crea asignacion Full Time para Consultor"

# Mesa de Servicio: requiere tarifa previa en la tabla tarifa_consultor
# Primero se crea la tarifa, luego la asignacion
$tarifa = Invoke-Api POST "/tarifas" @{
    cliente_id         = $cliente.id
    consultor_id       = $uConsul.id
    modulo_id          = $modulo.id
    tipo_asignacion_id = $tipoMesa
    valor              = 80000
} -Token $C2 -Label "Coord2 crea tarifa Mesa de Servicio para Consultor"
Write-Host "  Tarifa creada: $($tarifa.id) valor=$($tarifa.valor)" -ForegroundColor Gray

$asig2 = Invoke-Api POST "/registro-asignaciones" @{
    id_consultoria           = $consult2.id
    id_modulo                = $modulo.id
    consultor_responsable_id = $uConsul.id
    fecha_inicio             = $hoy
    fecha_fin                = $finMes
    tipo_servicio            = "Servicio"
    es_costo_total           = $false
} -Token $C2 -Label "Coord2 crea asignacion Mesa Servicio para Consultor"

Write-Host "  Asignacion1 (Full time): $($asig1.id)" -ForegroundColor Gray
Write-Host "  Asignacion2 (Mesa):      $($asig2.id)" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 7: Consultor ve sus asignaciones ===" -ForegroundColor Cyan

$misAsig = Invoke-Api GET "/mis-asignaciones" -Token $CX -Label "Consultor lista mis-asignaciones"
Write-Host "  Asignaciones activas: $($misAsig.Count)" -ForegroundColor Gray

$horasAsig = Invoke-Api GET "/registro-horas-asignaciones" -Token $CX -Label "Consultor lista asignaciones para reportar horas"
Write-Host "  Asignaciones para reporte horas: $($horasAsig.Count)" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 8: Flujo Full Time: reportar -> aprobar -> reportar -> aprobar ===" -ForegroundColor Cyan

# Quincena 1: Consultor reporta -> Coord1 aprueba
$reporte1 = Invoke-Api POST "/reportar-horas" @{
    id_registro_asignacion    = $asig1.id
    cantidad_dias_reportados  = 10
    tipo_servicio             = "Servicio"
} -Token $CX -Label "Consultor reporta 10 dias (quincena 1)"
Write-Host "  Reporte1 id: $($reporte1.id)" -ForegroundColor Gray

if ($reporte1) {
    Invoke-Api PUT "/aprobaciones/$($reporte1.id)" @{ estado = "Aprobado" } -Token $C1 -Label "Coord1 aprueba quincena 1" | Out-Null
}

# Quincena 2: Consultor reporta -> Coord1 rechaza (para probar rechazo) -> re-reporta
$reporte2 = Invoke-Api POST "/reportar-horas" @{
    id_registro_asignacion    = $asig1.id
    cantidad_dias_reportados  = 10
    tipo_servicio             = "Servicio"
} -Token $CX -Label "Consultor reporta 10 dias (quincena 2)"
Write-Host "  Reporte2 id: $($reporte2.id)" -ForegroundColor Gray

if ($reporte2) {
    Invoke-Api PUT "/aprobaciones/$($reporte2.id)" @{ estado = "Rechazado"; motivo = "Falta soporte de dias" } -Token $C1 -Label "Coord1 rechaza quincena 2 (prueba rechazo)" | Out-Null
    # Consultor re-reporta (el rechazo libera el bloqueo)
    $reporte2b = Invoke-Api POST "/reportar-horas" @{
        id_registro_asignacion   = $asig1.id
        cantidad_dias_reportados = 10
        tipo_servicio            = "Servicio"
    } -Token $CX -Label "Consultor re-reporta quincena 2 (tras rechazo)"
    Write-Host "  Reporte2b id: $($reporte2b.id)" -ForegroundColor Gray
    if ($reporte2b) {
        Invoke-Api PUT "/aprobaciones/$($reporte2b.id)" @{ estado = "Aprobado" } -Token $C1 -Label "Coord1 aprueba quincena 2 en segundo intento" | Out-Null
        $reporte2 = $reporte2b  # usar este para la cuenta de cobro
    }
}

# ============================================================
Write-Host "`n=== PASO 9: Mesa de Servicio - Consultor crea tickets (Coord2) ===" -ForegroundColor Cyan

if (-not $asig2 -or -not $asig2.id) {
    Write-Host "  [SKIP] No hay asignacion mesa de servicio disponible" -ForegroundColor Yellow
    $ticket1 = $null; $ticket2 = $null
} else {
$ticket1 = Invoke-Api POST "/mesa-fabrica/$($asig2.id)/enviar-aprobacion" @{
    horas_reportadas = 8
    total_cobrar = 600000
    tipo_servicio = "Servicio"
    nro_caso_int_ext = "INC-001"
    nro_caso_cliente = "CL-001"
    observacion_mesa_fabrica = "Soporte por incidente en modulo FI"
    fecha_cierre_mesa_fab = $hoy
    estado_mesa_servicio = "Cerrado"
    scope = "mesa"
} -Token $CX -Label "Consultor crea y envia ticket mesa 1 a aprobacion"

$ticket2 = Invoke-Api POST "/mesa-fabrica/$($asig2.id)/enviar-aprobacion" @{
    horas_reportadas = 4
    total_cobrar = 300000
    tipo_servicio = "Servicio"
    nro_caso_int_ext = "INC-002"
    nro_caso_cliente = "CL-002"
    observacion_mesa_fabrica = "Soporte configuracion de impuestos"
    fecha_cierre_mesa_fab = $hoy
    estado_mesa_servicio = "Cerrado"
    scope = "mesa"
} -Token $CX -Label "Consultor crea y envia ticket mesa 2 a aprobacion"

Write-Host "  Ticket1 id: $($ticket1.id)" -ForegroundColor Gray
Write-Host "  Ticket2 id: $($ticket2.id)" -ForegroundColor Gray
} # end if asig2

# ============================================================
Write-Host "`n=== PASO 10: Coord1 verifica su bandeja de pendientes ===" -ForegroundColor Cyan

$pendientesC1 = Invoke-Api GET "/aprobaciones/pendientes" -Token $C1 -Label "Coord1 ve aprobaciones pendientes"
$contPendC1 = @($pendientesC1).Count
Write-Host "  Pendientes Coord1 actuales: $contPendC1" -ForegroundColor Gray

# ============================================================
Write-Host "`n=== PASO 11: Coord2 aprueba tickets de mesa ===" -ForegroundColor Cyan

$pendientesC2 = Invoke-Api GET "/aprobaciones/pendientes" -Token $C2 -Label "Coord2 ve aprobaciones pendientes"
Write-Host "  Pendientes Coord2: $($pendientesC2.Count)" -ForegroundColor Gray

if ($ticket1) {
    Invoke-Api PUT "/aprobaciones/$($ticket1.id)" @{ estado = "Aprobado" } -Token $C2 -Label "Coord2 aprueba ticket mesa 1" | Out-Null
}
if ($ticket2) {
    Invoke-Api PUT "/aprobaciones/$($ticket2.id)" @{ estado = "Aprobado" } -Token $C2 -Label "Coord2 aprueba ticket mesa 2" | Out-Null
}

# ============================================================
Write-Host "`n=== PASO 12: Consultor genera cuentas de cobro ===" -ForegroundColor Cyan

# El JWT payload tiene public_id como "id" del usuario en la cuenta de cobro
$consultorId = $uConsul.id

# Horas por cobrar (reportes aprobados aun sin cuenta)
$horasCobrar = Invoke-Api GET "/horas-por-cobrar/$consultorId" -Token $CX -Label "Consultor ve horas aprobadas por cobrar"
Write-Host "  Reportes aprobados sin cobrar: $($horasCobrar.Count)" -ForegroundColor Gray

# Preview de la cuenta de cobro con el reporte 1 aprobado
$idsAprobados = @($horasCobrar | ForEach-Object { $_.id })
if ($idsAprobados.Count -gt 0) {
    $preview = Invoke-Api POST "/cuentas-cobro/preview" @{
        consultor_id = $consultorId
        ids_reportes = $idsAprobados
    } -Token $CX -Label "Preview cuenta de cobro"
    # El preview devuelve 'total' (no 'total_numeros')
    Write-Host "  Total a cobrar: $($preview.total) $($preview.moneda)" -ForegroundColor Gray

    # Generar la cuenta de cobro real
    $fechaIniCC = if ($preview.fecha_inicio) { $preview.fecha_inicio } else { $hoy }
    $fechaFinCC = if ($preview.fecha_fin)    { $preview.fecha_fin }    else { $finMes }
    $cuenta = Invoke-Api POST "/cuentas-cobro" @{
        consultor_id  = $consultorId
        fecha_inicio  = $fechaIniCC
        fecha_fin     = $fechaFinCC
        ciudad_cobro  = "Bogota"
        total_numeros = $preview.total
        total_letras  = $preview.total_letras
        ids_reportes  = $idsAprobados
    } -Token $CX -Label "Generar cuenta de cobro"
    Write-Host "  Cuenta de cobro creada: $($cuenta.id)" -ForegroundColor Gray
} else {
    Write-Host "  No hay reportes aprobados para cobrar aun" -ForegroundColor Yellow
}

# ============================================================
Write-Host "`n=== RESUMEN ===" -ForegroundColor Cyan
Write-Host "  Pasos exitosos : $OK" -ForegroundColor Green
Write-Host "  Pasos fallidos : $FAIL" -ForegroundColor Red
Write-Host ""
if ($FAIL -eq 0) {
    Write-Host "  FLUJO COMPLETO OK" -ForegroundColor Green
} else {
    Write-Host "  Revisa los errores arriba" -ForegroundColor Yellow
}
