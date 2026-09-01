const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.resolve(__dirname, "../../front/js/entregas-servicio.js");

function createApp() {
  global.window = {
    auth: { getRoleKey: () => "comercial" }
  };
  delete require.cache[scriptPath];
  require(scriptPath);
  return global.window.entregasServicioApp();
}

function fillBase(app) {
  app.form.cliente_id = "cliente";
  app.form.coordinador_id = "coordinador";
  app.form.perfil_cliente = "CLAVE";
  app.form.contacto_nuevo = { nombre: "Contacto", cargo: "Interventor", telefono: "300", email: "" };
  app.form.modulos_ids = ["modulo"];
}

test("el formulario de proyecto valida los campos comerciales", () => {
  const app = createApp();
  fillBase(app);
  app.form.enlaces = [{ titulo: "Propuesta", url: "https://empresa.com/propuesta.pdf" }];
  Object.assign(app.form.detalle, {
    nombre_proyecto: "Proyecto Uno",
    objeto_proyecto: "Implementación",
    valor_total: 100,
    forma_pago: "50% al inicio y 50% al finalizar",
    equipo_estimacion: "Equipo comercial"
  });
  assert.equal(app.formularioValido, true);
});

test("permite agregar varios enlaces y exige uno en proyecto", () => {
  const app = createApp();
  fillBase(app);
  Object.assign(app.form.detalle, {
    nombre_proyecto: "Proyecto Uno",
    objeto_proyecto: "Implementación",
    valor_total: 100,
    forma_pago: "Contado",
    equipo_estimacion: "Equipo comercial"
  });
  assert.equal(app.formularioValido, false);

  app.form.enlaces[0] = { titulo: "Propuesta", url: "https://empresa.com/propuesta" };
  app.agregarEnlace();
  app.form.enlaces[1] = { titulo: "Carpeta", url: "https://empresa.com/carpeta" };
  assert.equal(app.formularioValido, true);
});

test("el frontend exige consultor en outsourcing", () => {
  const app = createApp();
  fillBase(app);
  app.form.tipo_servicio = "OUTSOURCING";
  Object.assign(app.form.detalle, {
    tiempo_descripcion: "6 meses",
    valor_cliente: 150,
    tiene_contrato: "true"
  });
  assert.equal(app.formularioValido, false);
  app.form.consultores_ids = ["consultor"];
  app.form.consultores_tarifas.consultor = { tarifa_consultoria: 100, moneda_tarifa_consultoria: "COP" };
  assert.equal(app.formularioValido, true);
});

test("un consultor no registrado completo satisface outsourcing", () => {
  const app = createApp();
  fillBase(app);
  app.form.tipo_servicio = "OUTSOURCING";
  Object.assign(app.form.detalle, {
    tiempo_descripcion: "6 meses",
    valor_cliente: 150,
    tiene_contrato: "false"
  });
  app.agregarConsultorExterno();
  app.form.consultores_externos[0] = {
    nombre: "Consultor externo",
    telefono: "3001234567",
    tarifa_consultoria: 100,
    moneda_tarifa_consultoria: "USD"
  };

  assert.equal(app.formularioValido, true);
  app.form.consultores_externos[0].telefono = "";
  assert.equal(app.formularioValido, false);
});

test("exige tarifa para cada consultor agregado en cualquier tipo", () => {
  const app = createApp();
  fillBase(app);
  app.form.enlaces = [{ titulo: "Propuesta", url: "https://empresa.com/propuesta" }];
  Object.assign(app.form.detalle, {
    nombre_proyecto: "Proyecto Uno",
    objeto_proyecto: "Implementación",
    valor_total: 100,
    forma_pago: "Contado",
    equipo_estimacion: "Equipo comercial"
  });
  app.form.consultores_ids = ["consultor"];
  assert.equal(app.formularioValido, false);
  app.form.consultores_tarifas.consultor = { tarifa_consultoria: 250, moneda_tarifa_consultoria: "EUR" };
  assert.equal(app.formularioValido, true);
});

test("carga el perfil almacenado al seleccionar un cliente existente", async () => {
  const app = createApp();
  global.axios = { get: async () => ({ data: [] }) };
  app.catalogos.clientes = [
    { id: "cliente", nombre: "Cliente Uno", perfil_cliente: "NO_CLAVE" }
  ];
  app.form.cliente_id = "cliente";

  await app.cambiarCliente();

  assert.equal(app.form.perfil_cliente, "NO_CLAVE");
  delete global.axios;
});

test("solo Comercial puede abrir nuevas entregas", () => {
  const app = createApp();
  assert.equal(app.puedeCrear, true);
  global.window.auth.getRoleKey = () => "coordinador";
  assert.equal(app.puedeCrear, false);
  global.window.auth.getRoleKey = () => "admin";
  assert.equal(app.puedeCrear, false);
});

test("adapta el historial al rol que consulta", () => {
  const app = createApp();
  assert.equal(app.historialTitulo, "Mis entregas realizadas");
  global.window.auth.getRoleKey = () => "coordinador";
  assert.equal(app.historialTitulo, "Servicios entregados a mí");
  global.window.auth.getRoleKey = () => "admin";
  assert.equal(app.historialTitulo, "Todas las entregas de servicio");
});

test("coordinador solo acepta y administrador asignado puede aceptar o devolver", () => {
  const app = createApp();
  const item = { id: "entrega", estado: "REGISTRADA", coordinador_id: "admin" };

  global.window.auth.getRoleKey = () => "coordinador";
  assert.equal(app.puedeAceptar(item), true);
  assert.equal(app.puedeDevolver(item), false);

  global.window.auth.getRoleKey = () => "admin";
  app.catalogos.coordinadores = [{ id: "admin", es_actual: true }];
  assert.equal(app.puedeAceptar(item), true);
  assert.equal(app.puedeDevolver(item), true);
  assert.equal(app.puedeReasignar(item), true);

  item.coordinador_id = "otro";
  assert.equal(app.puedeAceptar(item), false);
  assert.equal(app.puedeDevolver(item), false);
});

test("solo Comercial puede rectificar una entrega devuelta", () => {
  const app = createApp();
  assert.equal(app.puedeRectificar({ estado: "CANCELADA" }), true);
  assert.equal(app.puedeRectificar({ estado: "REGISTRADA" }), false);

  global.window.auth.getRoleKey = () => "admin";
  assert.equal(app.puedeRectificar({ estado: "CANCELADA" }), false);
});

test("precarga todos los datos de una entrega devuelta para corregirla", async () => {
  const app = createApp();
  global.axios = {
    get: async () => ({
      data: [{ id: "contacto", nombre: "Interventor", es_contacto_principal: true }]
    })
  };
  global.window.scrollTo = () => {};

  await app.rectificar({
    id: "entrega",
    estado: "CANCELADA",
    tipo_servicio: "OUTSOURCING",
    cliente_id: "cliente",
    coordinador_id: "coordinador",
    nombre_servicio: "Outsourcing FI",
    perfil_cliente: "CLAVE",
    acuerdos_comerciales: "Pago mensual",
    interventor: { id: "contacto" },
    consultores: [
      {
        id: "consultor",
        tipo: "USUARIO",
        tarifa_consultoria: "500000",
        moneda_tarifa_consultoria: "COP"
      },
      {
        id: "externo",
        tipo: "EXTERNO",
        nombre: "Consultor externo",
        telefono: "300",
        tarifa_consultoria: "50",
        moneda_tarifa_consultoria: "USD"
      }
    ],
    modulos: [{ id: "modulo", nombre: "FI" }, { id: "", nombre: "RE" }],
    enlaces: [{ titulo: "Propuesta", url: "https://empresa.com/propuesta" }],
    detalle: {
      tiempo_descripcion: "6 meses",
      valor_cliente: "8000000",
      moneda: "COP",
      tiene_contrato: false
    }
  });

  assert.equal(app.entregaEditandoId, "entrega");
  assert.equal(app.tab, "nueva");
  assert.equal(app.form.contacto_id, "contacto");
  assert.deepEqual(app.form.consultores_ids, ["consultor"]);
  assert.equal(app.form.consultores_externos[0].nombre, "Consultor externo");
  assert.deepEqual(app.form.modulos_ids, ["modulo"]);
  assert.equal(app.form.modulos_otros_texto, "RE");
  assert.equal(app.form.detalle.tiene_contrato, "false");

  delete global.axios;
});
