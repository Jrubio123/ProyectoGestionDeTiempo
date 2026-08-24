const express = require("express");
const crypto = require("crypto");
const { env } = require("../config/env");
const clicksignService = require("../services/clicksign.service");
const {
  MicrosoftGroupWebhookError,
  syncConsultoresGroupMember
} = require("../services/microsoft-group-webhook.service");

const router = express.Router();

function safeTokenEquals(inbound, expected) {
  const inboundBuffer = Buffer.from(String(inbound || "").trim());
  const expectedBuffer = Buffer.from(String(expected || "").trim());
  return inboundBuffer.length === expectedBuffer.length &&
    inboundBuffer.length > 0 &&
    crypto.timingSafeEqual(inboundBuffer, expectedBuffer);
}

router.post("/clicksign/signature", async (req, res) => {
  try {
    if (!env.CLICKSIGN_WEBHOOK_TOKEN) {
      console.error("[clicksign-webhook] CLICKSIGN_WEBHOOK_TOKEN no configurado");
      return res.status(503).json({ ok: false, error: "Webhook deshabilitado" });
    }

    const inboundToken = String(
      req.headers["x-clicksign-token"] ||
      req.headers["x-webhook-token"] ||
      req.query?.token ||
      ""
    ).trim();
    if (!safeTokenEquals(inboundToken, env.CLICKSIGN_WEBHOOK_TOKEN)) {
      return res.status(401).json({ ok: false, error: "Webhook no autorizado" });
    }

    const event = req.body && typeof req.body === "object" ? req.body : {};
    console.log("[clicksign-webhook] recibido", {
      contentType: req.headers["content-type"] || "",
      keys: Object.keys(event),
      body: JSON.stringify(event).slice(0, 4000)
    });
    const queued = await clicksignService.enqueueSignatureEvent(event);
    res.status(200).json({ ok: true, event_id: queued.id });

    setImmediate(() => {
      clicksignService
        .processQueuedSignatureEvent(queued.id)
        .catch((err) => console.error("[clicksign-webhook]", err?.message || err));
    });
  } catch (err) {
    console.error("Error webhook Click&Sign:", err);
    return res.status(500).json({ ok: false });
  }
});

router.post("/microsoft/consultores", async (req, res) => {
  try {
    const result = await syncConsultoresGroupMember(req.body || {});
    console.log("[microsoft-group-webhook] identidad sincronizada", {
      correo: result?.usuario?.correo || null,
      accion: result?.accion || null,
      solicitud_id: result?.solicitud_id || null,
      rol: result?.rol || null
    });
    return res.status(result?.accion === "onboarding_completado" ? 200 : 201).json({
      ok: true,
      ...result
    });
  } catch (error) {
    const status = error instanceof MicrosoftGroupWebhookError
      ? error.statusCode
      : 500;
    console.error("[microsoft-group-webhook] error:", error?.message || error);
    return res.status(status).json({
      ok: false,
      error: status >= 500 ? "Error sincronizando la identidad de Microsoft" : error.message,
      code: error?.code || "MICROSOFT_GROUP_SYNC_ERROR"
    });
  }
});

module.exports = router;
