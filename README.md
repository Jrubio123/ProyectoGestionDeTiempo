## ProyectoGestionDeTiempo

### Migracion segura de repositorio (cambio de cuenta)
1. No subas archivos reales de entorno (`.env`, `.env_produccion`, `.env_tunnels`).
2. Usa solo plantillas versionadas:
   - `.env.example`
   - `.env_produccion.example`
   - `.env_tunnels.example`
3. Carga variables reales en Azure App Service (Application Settings), no en Git.
4. Rota secretos si alguna vez estuvieron en el repo:
   - `DB_PASSWORD`
   - `JWT_SECRET`
   - `AZURE_CLIENT_SECRET`
   - cualquier API key o token

### Cargar variables masivamente en Azure App Service
Script incluido: `scripts/set-azure-appsettings.ps1`

Ejemplo:
```powershell
./scripts/set-azure-appsettings.ps1 `
  -ResourceGroup "AppSilver" `
  -AppName "BackApp" `
  -EnvFile ".env_produccion"
```

Dry run:
```powershell
./scripts/set-azure-appsettings.ps1 `
  -ResourceGroup "AppSilver" `
  -AppName "BackApp" `
  -EnvFile ".env_produccion" `
  -DryRun
```

### Nota importante sobre historial Git
Aunque dejes de versionar `.env_*`, los secretos antiguos siguen en el historial de commits.
Antes de publicar/migrar, evalua limpiar historial o crear un repo nuevo desde un snapshot limpio.
