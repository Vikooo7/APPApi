# Prueba de conflicto para la exposición.
# Simula que el CLIENTE dueño de un envío le cambia el peso desde su app, mientras el operador
# tiene un cambio guardado sin conexión para ese mismo envío. Al subir la versión en el servidor,
# el cambio del operador se rechaza con 409 VERSION_DESACTUALIZADA cuando recupera la conexión.
#
# Uso:   .\simular-conflicto.ps1 -Guia "RLP-26-300025-0"
# Nota:  el envío debe seguir "pendiente" en el servidor; un cliente no puede editar uno ya recogido.

param(
    [Parameter(Mandatory = $true)][string]$Guia,
    [double]$Aumento = 15,
    [string]$Api = "https://app-api-rutalog.vercel.app/api",
    # Cuentas de cliente de ejemplo (ver README de la API).
    [string[]]$Cuentas = @("cliente@rutalog.pe", "cliente2@rutalog.pe"),
    [string]$Clave = "1234"
)

$ErrorActionPreference = "Stop"

function Leer-Error($excepcion) {
    try { return ($excepcion.ErrorDetails.Message | ConvertFrom-Json) } catch { return $null }
}

foreach ($correo in $Cuentas) {
    $login = Invoke-RestMethod -Method Post -Uri "$Api/auth/login" -ContentType "application/json" `
        -Body (@{ correo = $correo; clave = $Clave } | ConvertTo-Json)
    $cabeceras = @{ Authorization = "Bearer $($login.token)" }

    $envio = (Invoke-RestMethod -Uri "$Api/envios" -Headers $cabeceras).datos |
        Where-Object { $_.numeroGuia -eq $Guia }
    if (-not $envio) { continue }

    Write-Host "Envío encontrado. Dueño: $correo"
    Write-Host ("  Antes:   estado={0}  peso={1} kg  versión={2}" -f $envio.estado, $envio.pesoKg, $envio.version)

    $cuerpo = @{
        uuidOperacion = [guid]::NewGuid().ToString()
        ruta          = $envio.ruta
        pesoKg        = $envio.pesoKg + $Aumento
        version       = $envio.version
    } | ConvertTo-Json

    try {
        $nuevo = Invoke-RestMethod -Method Put -Uri "$Api/envios/$($envio.id)" -Headers $cabeceras `
            -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo))
    } catch {
        $detalle = Leer-Error $_
        if ($detalle) { Write-Host "El servidor rechazó el cambio: $($detalle.codigo) - $($detalle.mensaje)" }
        else { Write-Host "No se pudo cambiar el envío: $($_.Exception.Message)" }
        exit 1
    }

    Write-Host ("  Después: estado={0}  peso={1} kg  versión={2}" -f $nuevo.estado, $nuevo.pesoKg, $nuevo.version)
    Write-Host "Listo. Ahora quita el modo avión en el teléfono del operador: su cambio debe quedar Rechazado."
    exit 0
}

Write-Host "Ninguna de las cuentas de cliente tiene un envío con la guía $Guia."
exit 1
