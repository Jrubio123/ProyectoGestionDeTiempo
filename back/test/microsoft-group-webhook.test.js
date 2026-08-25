const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MicrosoftGroupWebhookError,
  normalizeWebhookIdentity,
  resolveAllowedMicrosoftIdentity,
  selectPendingSolicitud,
  requestedRoleTitle,
  relinkMicrosoftPlaceholder,
  syncConsultoresGroupMember
} = require("../src/services/microsoft-group-webhook.service");

const identity = {
  oid: "11111111-1111-4111-8111-111111111111",
  email: "persona@silverconsulting.com.co",
  displayName: "María José Pérez López",
  personalEmail: null,
  documentNumber: null,
  solicitudId: null
};

test("normaliza el payload enviado por Power Automate", () => {
  const result = normalizeWebhookIdentity({
    id_azure: identity.oid,
    nombre: identity.displayName,
    correo: " Persona@SilverConsulting.com.co ",
    telefono_movil: "3001234567",
    documento: ["1012345678"],
    correo_personal: ["personal@example.com"]
  });

  assert.equal(result.oid, identity.oid);
  assert.equal(result.email, identity.email);
  assert.equal(result.displayName, identity.displayName);
  assert.equal(result.phone, "3001234567");
  assert.equal(result.documentNumber, "1012345678");
  assert.equal(result.personalEmail, "personal@example.com");
});

test("Graph reemplaza nombre y correo del body y confirma AZURE_ALLOWED_GROUPS", async () => {
  const calls = [];
  const result = await resolveAllowedMicrosoftIdentity({
    id_azure: identity.oid,
    nombre: "Nombre manipulado",
    correo: "falso@silverconsulting.com.co",
    telefono_movil: "000",
    documento: ["999"],
    correo_personal: "falso@example.com"
  }, {
    allowedGroupIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    getGraphAccessToken: async () => "graph-token",
    graphJsonRequest: async (request) => {
      calls.push(request);
      if (request.method === "GET") {
        return {
          id: identity.oid,
          displayName: identity.displayName,
          mail: identity.email,
          mobilePhone: "3007654321",
          businessPhones: ["1098765432"],
          otherMails: ["graph-personal@example.com"]
        };
      }
      return { value: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] };
    }
  });

  assert.equal(result.displayName, identity.displayName);
  assert.equal(result.email, identity.email);
  assert.equal(result.phone, "3007654321");
  assert.equal(result.documentNumber, "1098765432");
  assert.equal(result.personalEmail, "graph-personal@example.com");
  assert.match(calls.find((call) => call.method === "POST").path, /checkMemberGroups/);
});

test("rechaza identidades que Graph no encuentra en los grupos permitidos", async () => {
  await assert.rejects(
    () => resolveAllowedMicrosoftIdentity({ id_azure: identity.oid }, {
      allowedGroupIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      getGraphAccessToken: async () => "graph-token",
      graphJsonRequest: async ({ method }) => method === "GET"
        ? { id: identity.oid, displayName: identity.displayName, mail: identity.email }
        : { value: [] }
    }),
    (error) => {
      assert.ok(error instanceof MicrosoftGroupWebhookError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "GROUP_MEMBERSHIP_REQUIRED");
      return true;
    }
  );
});

test("relaciona una solicitud pendiente por nombre sin depender de tildes u orden", () => {
  const selected = selectPendingSolicitud([
    {
      id: 7,
      public_id: "solicitud-7",
      nombre: "Maria Jose",
      apellidos: "Perez Lopez",
      estado: "Pendiente Correo Silver"
    }
  ], identity);

  assert.equal(selected.id, 7);
});

test("prioriza el documento de businessPhones para relacionar la solicitud", () => {
  const selected = selectPendingSolicitud([
    { id: 7, nombre: "Nombre distinto", apellidos: "", numero_documento: "10.987.654.32" },
    { id: 8, nombre: "Maria Jose", apellidos: "Perez Lopez", numero_documento: "555" }
  ], {
    ...identity,
    documentNumber: "1098765432"
  });

  assert.equal(selected.id, 7);
});

test("no elige automáticamente cuando hay dos solicitudes con el mismo nombre", () => {
  assert.throws(
    () => selectPendingSolicitud([
      { id: 7, nombre: "Maria Jose", apellidos: "Perez Lopez" },
      { id: 8, nombre: "María José", apellidos: "Pérez López" }
    ], identity),
    (error) => error.code === "AMBIGUOUS_PENDING_REQUEST"
  );
});

test("resuelve el rol solicitado para externos y vinculados", () => {
  assert.equal(requestedRoleTitle(null), "Consultor");
  assert.equal(requestedRoleTitle({ grupo_app_tiempos: "CONSULTOR" }), "Consultor");
  assert.equal(requestedRoleTitle({ grupo_app_tiempos: "COMERCIAL" }), "Comercial");
  assert.equal(
    requestedRoleTitle({ grupo_app_tiempos: "Otro", grupo_usuario_otro: "Talento Humano" }),
    "Talento Humano"
  );
});

test("reutiliza el usuario provisional creado antes de identificar la solicitud", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (/SELECT id, persona_id, created_by/.test(query)) {
        return { rows: [{ id: 40, persona_id: 99, created_by: "ms_sso" }] };
      }
      if (/SELECT id, numero_documento, preregistro_id/.test(query)) {
        return {
          rows: [{
            id: 99,
            numero_documento: null,
            preregistro_id: null,
            numero_contacto: "3001234567",
            correo_silver: identity.email,
            azure_oid: identity.oid
          }]
        };
      }
      return { rows: [] };
    }
  };

  const relinked = await relinkMicrosoftPlaceholder(db, {
    person: { id: 20, public_id: "persona-real" },
    identity: { ...identity, phone: "3001234567" }
  });

  assert.equal(relinked, true);
  assert.ok(calls.some(({ query, params }) => /estado = 'inactivo'/.test(query) && params[0] === 99));
  assert.ok(calls.some(({ query, params }) => /UPDATE usuarios/.test(query) && params[0] === 20 && params[1] === 40));
});

test("consolida el usuario automático anterior antes de vincular la identidad SSO", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (/SELECT id, persona_id, created_by/.test(query)) {
        return { rows: [{ id: 1, persona_id: 6, created_by: "ms_sso" }] };
      }
      if (/SELECT id, numero_documento, preregistro_id/.test(query)) {
        return {
          rows: [{
            id: 6,
            numero_documento: null,
            preregistro_id: null,
            numero_contacto: "3126204046",
            correo_silver: identity.email,
            azure_oid: identity.oid
          }]
        };
      }
      if (/WHERE persona_id = \$1 AND id <> \$2/.test(query)) {
        return {
          rows: [{
            id: 21,
            email: "prueba@silverconsulting.com.co",
            azure_oid: null,
            created_by: "contratacion_th",
            activo: true
          }]
        };
      }
      return { rows: [] };
    }
  };

  const relinked = await relinkMicrosoftPlaceholder(db, {
    person: { id: 1, public_id: "persona-real" },
    identity: { ...identity, phone: "3126204046" }
  });

  assert.equal(relinked, true);
  assert.ok(calls.some(({ query, params }) =>
    /SET persona_id = NULL/.test(query) && params[0] === 21 && params[1] === 1
  ));
  assert.ok(calls.some(({ query, params }) =>
    /SET persona_id = \$1/.test(query) && params[0] === 1 && params[1] === 1
  ));
});

test("no desvincula automáticamente un usuario de origen manual", async () => {
  const db = {
    async query(sql) {
      const query = String(sql);
      if (/SELECT id, persona_id, created_by/.test(query)) {
        return { rows: [{ id: 1, persona_id: 6, created_by: "ms_sso" }] };
      }
      if (/SELECT id, numero_documento, preregistro_id/.test(query)) {
        return {
          rows: [{
            id: 6,
            numero_documento: null,
            preregistro_id: null,
            numero_contacto: null,
            correo_silver: identity.email,
            azure_oid: identity.oid
          }]
        };
      }
      if (/WHERE persona_id = \$1 AND id <> \$2/.test(query)) {
        return {
          rows: [{
            id: 21,
            email: "persona@silverconsulting.com.co",
            azure_oid: null,
            created_by: "admin_manual",
            activo: true
          }]
        };
      }
      return { rows: [] };
    }
  };

  await assert.rejects(
    () => relinkMicrosoftPlaceholder(db, {
      person: { id: 1 },
      identity
    }),
    (error) => error.code === "PERSON_USER_CONFLICT" && error.statusCode === 409
  );
});

test("completa Pendiente Correo Silver y vincula persona, usuario y preregistro", async () => {
  const calls = [];
  const webhookIdentity = {
    ...identity,
    phone: "3001234567",
    documentNumber: "123"
  };
  const pending = {
    id: 7,
    public_id: "solicitud-7",
    preregistro_id: 9,
    nombre: "Maria Jose",
    apellidos: "Perez Lopez",
    numero_documento: "123",
    correo_personal: "personal@example.com",
    correo_empresarial: null,
    grupo_app_tiempos: "COMERCIAL",
    grupo_usuario_otro: null,
    datos_extra: {},
    estado: "Pendiente Correo Silver"
  };
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (/FROM solicitudes_contratacion sc/.test(text)) return { rows: [pending] };
      if (/FROM roles/.test(text)) return { rows: [{ id: 5, titulo: "Comercial" }] };
      if (/FROM solicitudes_contratacion\s+WHERE id/.test(text)) {
        return { rows: [{ id: 7, public_id: "solicitud-7", preregistro_id: 9, numero_documento: "123", estado: "Pendiente Correo Silver" }] };
      }
      if (/FROM personas/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: [{ id: 20, public_id: "persona-20", numero_documento: "123" }] };
      }
      if (/UPDATE usuarios u/.test(text)) {
        return { rows: [{ id: 30, public_id: "usuario-30", nombre_usuario: identity.displayName, email: identity.email, azure_oid: identity.oid }] };
      }
      if (/UPDATE solicitudes_contratacion/.test(text)) {
        return { rows: [{ public_id: "solicitud-7", estado: "Completado" }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const fakePool = { async connect() { return client; } };
  const result = await syncConsultoresGroupMember({}, {
    pool: fakePool,
    resolveAllowedMicrosoftIdentity: async () => webhookIdentity,
    syncMicrosoftIdentity: async (_db, input) => {
      assert.equal(input.personId, 20);
      assert.equal(input.defaultRoleId, 5);
      assert.equal(input.phone, webhookIdentity.phone);
      return { id: 30, public_id: "usuario-30", email: identity.email, azure_oid: identity.oid };
    }
  });

  assert.equal(result.accion, "onboarding_completado");
  assert.equal(result.estado, "Completado");
  assert.equal(result.rol, "Comercial");
  assert.ok(calls.some((sql) => /UPDATE preregistro_personas/.test(sql)));
  assert.equal(calls.at(-1), "COMMIT");
});

test("registra la identidad sin completar si TH todavia no llego a Pendiente Correo Silver", async () => {
  const calls = [];
  const pending = {
    id: 7,
    public_id: "solicitud-7",
    preregistro_id: 9,
    nombre: "Maria Jose",
    apellidos: "Perez Lopez",
    numero_documento: "123",
    correo_personal: "personal@example.com",
    correo_empresarial: null,
    grupo_app_tiempos: "COMERCIAL",
    grupo_usuario_otro: null,
    datos_extra: {},
    estado: "Pendiente Revision TH"
  };
  const client = {
    async query(sql) {
      const query = String(sql);
      calls.push(query);
      if (/FROM solicitudes_contratacion sc/.test(query)) return { rows: [pending] };
      if (/FROM solicitudes_contratacion\s+WHERE id/.test(query)) {
        return { rows: [{ ...pending }] };
      }
      if (/FROM personas/.test(query) && /FOR UPDATE/.test(query)) return { rows: [] };
      if (/UPDATE solicitudes_contratacion/.test(query)) {
        return { rows: [{ public_id: pending.public_id, estado: pending.estado }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  let syncCalled = false;
  const result = await syncConsultoresGroupMember({}, {
    pool: { async connect() { return client; } },
    resolveAllowedMicrosoftIdentity: async () => identity,
    syncMicrosoftIdentity: async () => {
      syncCalled = true;
      return {};
    }
  });

  assert.equal(result.accion, "correo_silver_registrado");
  assert.equal(result.estado, "Pendiente Revision TH");
  assert.equal(syncCalled, false);
  assert.ok(calls.some((query) => /UPDATE preregistro_personas/.test(query)));
  assert.equal(calls.at(-1), "COMMIT");
});
