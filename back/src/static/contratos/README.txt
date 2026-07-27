CARPETA DE DOCUMENTOS ESTÁTICOS — PROCESO DE BIENVENIDA / CONTRATACIÓN
=======================================================================

Coloca aquí los archivos con los nombres exactos indicados abajo.
Son iguales para todos los consultores que ingresan al proceso.

DOCUMENTOS PDF (7 archivos):
  - POLÍTICA DE PAGO A PROVEEDORES - GENERAL.pdf
    → Política de pago de proveedores
  - Silver Consulting - Código de ética y conducta.pdf
    → Código de ética y conducta
  - REQUISITOS DE CONTRATO OUTSOURCING.pdf
    → Requisitos de Contrato
  - SC-PS-Seguridad Equipos V1.pdf
    → Seguridad de Equipos (al confirmar lectura se descarga PLANTILLA DE TIEMPOS.xlsx)
  - Silver Consulting - Configurar Autenticación Multifactor - Office 365.pdf
    → Guía Autenticador Office 365
  - Silver Consulting - configurar MFA Silver Consulting - Office 365.pdf
    → Guía MFA Office 365
  - Silver Consulting - Ingresar a Microsoft 365 Estándar.pdf
    → Guía ingreso Microsoft 365 Estándar

VIDEO DE BIENVENIDA (1 archivo):
  - Silver Consulting - Bienvenida.mp4
                                → Video vertical (formato retrato 9:16 recomendado)
                                 Si no existe, se muestra un placeholder en la UI.

LINK EXTERNO (no es un archivo, ya está hardcodeado en el backend):
  - El formulario de Office Forms se abre en nueva pestaña
    y se marca como completado automáticamente.

RUTAS DEL BACKEND:
  - GET /contratacion/pdf/:nombre   → sirve cualquiera de los 7 PDFs (requiere JWT)
  - GET /contratacion/video         → sirve bienvenida.mp4 con soporte de rango (requiere JWT)
  - GET /contratacion/docs-info     → devuelve la lista de docs al frontend (requiere JWT)
  - PATCH /contratacion/check       → marca un doc como leído { clave: "politica_pago" }

Si un PDF no existe, el endpoint devuelve 503 con mensaje explicativo.
Si el video no existe, la UI muestra un placeholder (no bloquea el proceso).
