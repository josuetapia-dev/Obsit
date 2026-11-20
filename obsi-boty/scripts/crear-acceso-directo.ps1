# Crea accesos directos de Obsi-boty en el Escritorio y en el menú Inicio.
# Uso (desde la carpeta obsi-boty):  npm run acceso-directo
# Requiere haber hecho "npm install" antes.

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot                       # ...\obsi-boty
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $app 'assets\obsi-boty.ico'

if (-not (Test-Path $electron)) {
  Write-Host 'No encuentro Electron. Ejecuta "npm install" en la carpeta obsi-boty y vuelve a intentarlo.' -ForegroundColor Red
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$destinos = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs')                    # menu Inicio
)

foreach ($carpeta in $destinos) {
  $lnk = $shell.CreateShortcut((Join-Path $carpeta 'Obsi-boty.lnk'))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$app`""
  $lnk.WorkingDirectory = $app
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Obsi-boty: el robot del equipo Obsi que explica el proyecto'
  $lnk.Save()
  Write-Host "Acceso directo creado: $(Join-Path $carpeta 'Obsi-boty.lnk')" -ForegroundColor Green
}
