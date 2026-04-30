const jwt = require("jsonwebtoken"); // Herramienta para leer credenciales
const { env } = require("../config/env"); // Configuración del servidor

const { JWT_SECRET } = env; // Clave secreta para firmar y verificar tokens
const normalizeValue = (value) => String(value || "").toLowerCase().trim(); // Convierte a texto, quita espacios y pone minúsculas

const hasAccess = (req, { roles = [], tipos = [] }) => {
  const userRole = normalizeValue(req.user?.rol); // Rol del usuario
  const userTipo = normalizeValue(req.user?.tipo_consultor); // Tipo de consultor del usuario
  const allowedRoles = roles.map(normalizeValue); // Roles permitidos
  const allowedTipos = tipos.map(normalizeValue); // Tipos de consultor permitidos
  return (
    (allowedRoles.length > 0 && allowedRoles.includes(userRole)) || // Verifica que el rol del usuario esté en los roles permitidos
    (allowedTipos.length > 0 && allowedTipos.includes(userTipo)) // Verifica que el tipo de consultor del usuario esté en los tipos de consultor permitidos
  );
};

const requireAccess = ({ roles = [], tipos = [] } = {}) => (req, res, next) => {
  if (!roles.length && !tipos.length) return next(); // Si no se especifican roles ni tipos, se permite el acceso
  if (!req.user) { // Si no hay usuario, se busca el token en la cabecera
    const auth = req.headers.authorization || ""; // Se obtiene el token de la cabecera
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null; // Se extrae el token
    if (!token) return res.status(401).json({ error: "No autorizado" }); // Si no hay token, se deniega el acceso
    try {
      req.user = jwt.verify(token, JWT_SECRET); // Se verifica el token
    } catch (err) {
      return res.status(401).json({ error: "Token inválido" }); // Si el token es inválido, se deniega el acceso
    }
  }
  if (!hasAccess(req, { roles, tipos })) { // Si el usuario no tiene acceso, se deniega el acceso
    return res.status(403).json({ error: "Acceso denegado" }); // Si el usuario no tiene acceso, se deniega el acceso
  }
  return next(); // Si el usuario tiene acceso, se permite el acceso
};

const requireAuthenticated = (req, res, next) => {
  if (req.user?.id) return next(); // Si hay usuario, se permite el acceso
  const auth = req.headers.authorization || ""; // Se obtiene el token de la cabecera
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null; // Se extrae el token
  if (!token) return res.status(401).json({ error: "No autorizado" }); // Si no hay token, se deniega el acceso
  try {
    req.user = jwt.verify(token, JWT_SECRET); // Se verifica el token
    return next(); // Si el token es válido, se permite el acceso
  } catch (err) {
    return res.status(401).json({ error: "Token inválido" }); // Si el token es inválido, se deniega el acceso
  }
};

module.exports = { hasAccess, requireAccess, requireAuthenticated }; // Exporta las funciones
