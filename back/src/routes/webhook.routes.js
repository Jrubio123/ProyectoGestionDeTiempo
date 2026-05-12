const express = require("express");
const crypto = require("crypto");
const { env } = require("../config/env");
const clicksignService = require("../services/clicksign.service");

const router = express.Router();

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
    const expectedTokenBuffer = Buffer.from(env.CLICKSIGN_WEBHOOK_TOKEN);
    const inboundTokenBuffer = Buffer.from(inboundToken);
    if (
      inboundTokenBuffer.length !== expectedTokenBuffer.length ||
      !crypto.timingSafeEqual(inboundTokenBuffer, expectedTokenBuffer)
    ) {
      return res.status(401).json({ ok: false, error: "Webhook no autorizado" });
    }

    const event = req.body && typeof req.body === "object" ? req.body : {};
    console.log("[clicksign-webhook] recibido", {
      contentType: req.headers["content-type"] || "",
      keys: Object.keys(event),
      body: JSON.stringify(event).slice(0, 4000)
    });
    res.status(200).json({ ok: true });

    setImmediate(() => {
      clicksignService
        .processSignatureEvent(event)
        .catch((err) => console.error("[clicksign-webhook]", err?.message || err));
    });
  } catch (err) {
    console.error("Error webhook Click&Sign:", err);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
