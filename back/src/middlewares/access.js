const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

const { JWT_SECRET } = env;
const normalizeValue = (value) => String(value || "").toLowerCase().trim();

const hasAccess = (req, { roles = [], tipos = [] }) => {
  const userRole = normalizeValue(req.user?.rol);
  const userTipo = normalizeValue(req.user?.tipo_consultor);
  const allowedRoles = roles.map(normalizeValue);
  const allowedTipos = tipos.map(normalizeValue);
  return (
    (allowedRoles.length > 0 && allowedRoles.includes(userRole)) ||
    (allowedTipos.length > 0 && allowedTipos.includes(userTipo))
  );
};

const requireAccess = ({ roles = [], tipos = [] } = {}) => (req, res, next) => {
  if (!roles.length && !tipos.length) return next();
  if (!req.user) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Token inválido" });
    }
  }
  if (!hasAccess(req, { roles, tipos })) {
    return res.status(403).json({ error: "Acceso denegado" });
  }
  return next();
};

const requireAuthenticated = (req, res, next) => {
  if (req.user?.id) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" });
  }
};

module.exports = { hasAccess, requireAccess, requireAuthenticated };
