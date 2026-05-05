const fs = require('fs');
const file = 'front/js/solicitudes-recl.js';
let content = fs.readFileSync(file, 'utf8');

const newMethods = `
        initFechasExcel() {
            const hoy = new Date();
            const primerDia = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
            const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
            
            const formatDate = (date) => {
                const y = date.getFullYear();
                const m = String(date.getMonth() + 1).padStart(2, '0');
                const d = String(date.getDate()).padStart(2, '0');
                return \`\${y}-\${m}-\${d}\`;
            };
            
            this.fechaInicioExcel = formatDate(primerDia);
            this.fechaFinExcel = formatDate(ultimoDia);
        },

        async descargarExcel() {
            if (!this.fechaInicioExcel || !this.fechaFinExcel) {
                alert("Por favor, selecciona las fechas de inicio y fin.");
                return;
            }

            this.generandoExcel = true;
            try {
                if (typeof window.XLSX === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
                        script.onload = resolve;
                        script.onerror = reject;
                        document.head.appendChild(script);
                    });
                }

                const dInicio = new Date(this.fechaInicioExcel + "T00:00:00");
                const dFin = new Date(this.fechaFinExcel + "T23:59:59");

                const solicitudesEnRango = this.solicitudes.filter(s => {
                    const fechaAtributo = s.fecha_inicio || s.fecha_inicio_esperada;
                    if (!fechaAtributo) return false;
                    
                    const soloFechaStr = String(fechaAtributo).trim().substring(0, 10);
                    const dSolicitud = new Date(soloFechaStr + "T00:00:00");
                    
                    return dSolicitud >= dInicio && dSolicitud <= dFin;
                });

                if (solicitudesEnRango.length === 0) {
                    alert("No se encontraron solicitudes en el rango de fechas seleccionado.");
                    this.generandoExcel = false;
                    return;
                }

                const datosExcel = solicitudesEnRango.map(s => ({
                    "ID": s.id || "-",
                    "Perfil": s.perfil || "-",
                    "Cliente": s.cliente || "-",
                    "Módulo": s.modulo || "-",
                    "Solicitante": s.solicitante || "-",
                    "Prioridad": s.prioridad || "-",
                    "Estado": s.estado || "-",
                    "Nivel": s.nivel || "-",
                    "Tiempo": s.tiempo || "-",
                    "Ubicación": s.ubicacion || "-",
                    "Modalidad": s.modalidad || "-",
                    "Inicio Esperado": this.formatFecha(s.fecha_inicio || s.fecha_inicio_esperada),
                    "Tipo Proyecto": s.tipo_proyecto || "-",
                    "Presupuesto": s.presupuesto || "-",
                    "Experiencia": s.experiencia || "-",
                    "Descripción": s.descripcion || "-",
                    "Información Adicional": s.informacion_adicional || "-",
                    "Observaciones RRHH": s.observaciones_rrhh || "-"
                }));

                const hoja = window.XLSX.utils.json_to_sheet(datosExcel);
                const libro = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(libro, hoja, "Pool_RRHH");

                const mesStr = new Date().toLocaleDateString("es-CO", { month: "long" }).replace(/^\\w/, c => c.toUpperCase());
                const nombreArchivo = \`Informe_RRHH_\${mesStr}.xls\`;
                
                window.XLSX.writeFile(libro, nombreArchivo);
                this.modalExcel = false;
            } catch (error) {
                console.error("Error al generar el Excel:", error);
                alert("Hubo un problema al generar el archivo Excel. Por favor, intenta nuevamente.");
            } finally {
                this.generandoExcel = false;
            }
        }
`;

// Insert the new methods before the last formatFecha function to be safe
content = content.replace('        formatFecha(fecha) {', newMethods + '\\n        formatFecha(fecha) {');
fs.writeFileSync(file, content);
console.log('updated');
