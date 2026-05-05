const fs = require('fs');
const file = 'front/views/solicitudesRecl.html';
let content = fs.readFileSync(file, 'utf8');

const exportButton = `
                <button @click="modalExcel = true" class="rrhh-btn-ghost px-3 py-1.5 text-xs flex items-center gap-1 border border-[#eef2f7]">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    Exportar Excel
                </button>
`;

const exportModal = `
    <!-- Modal Exportar Excel -->
    <div x-show="modalExcel" class="view-overlay bg-white/30 backdrop-blur-md" style="display: none;">
        <div class="w-11/12 max-w-md bg-white/80 backdrop-blur-lg rounded-3xl border border-white/60 shadow-2xl p-6">
            <h3 class="font-bold text-lg mb-2 text-[#20272f]">Descargar Informe Excel</h3>
            <p class="text-sm text-[#5b6678] mb-4">Selecciona el rango de fechas para exportar las solicitudes. Se descargarán todas las solicitudes de RRHH en el rango seleccionado.</p>
            
            <div class="space-y-4">
                <div>
                    <label class="text-xs text-[#20272f] block mb-1 font-semibold">Fecha Inicio</label>
                    <input type="date" x-model="fechaInicioExcel" class="rrhh-input text-sm">
                </div>
                <div>
                    <label class="text-xs text-[#20272f] block mb-1 font-semibold">Fecha Fin</label>
                    <input type="date" x-model="fechaFinExcel" class="rrhh-input text-sm">
                </div>
            </div>

            <div class="mt-6 flex justify-end gap-3">
                <button @click="modalExcel = false" class="rrhh-btn-ghost px-4 py-2 text-sm">Cancelar</button>
                <button 
                    @click="descargarExcel" 
                    :disabled="generandoExcel"
                    class="rrhh-btn-primary px-4 py-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2">
                    <span x-show="!generandoExcel">Descargar Excel</span>
                    <span x-show="generandoExcel">Generando...</span>
                </button>
            </div>
        </div>
    </div>
`;

// Insert the button right after the last filter button
content = content.replace(
    '<button @click="filtro = \'Entrevistas\'" class="rrhh-btn-primary px-3 py-1.5 text-xs">Entrevistas</button>',
    '<button @click="filtro = \'Entrevistas\'" class="rrhh-btn-primary px-3 py-1.5 text-xs">Entrevistas</button>' + exportButton
);

// Insert the modal right before the final closing div
content = content.replace(
    /<\/div>\s*$/, 
    exportModal + '\\n</div>\\n'
);

fs.writeFileSync(file, content);
console.log('updated html');
