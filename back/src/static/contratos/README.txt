CARPETA DE DOCUMENTOS INFORMATIVOS — PROCESO DE FIRMA DE CONTRATOS
===================================================================

Coloca aquí los 3 PDFs informativos que la persona debe leer antes de firmar.

Nombres exactos requeridos:
  - informativo_1.pdf
  - informativo_2.pdf
  - informativo_3.pdf

Estos archivos son estáticos (iguales para todos los contratistas).
El backend los sirve en la ruta GET /contratacion/pdf/:nombre
protegida por el JWT temporal del proceso de firma.

Si algún archivo no existe, el endpoint devuelve 503 con un mensaje
explicativo en lugar de un error genérico.
