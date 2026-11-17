# RutaLog Perú · API REST

API compartida por la App Cliente y la App Operador.
**Tecnología:** Node.js + Express · PostgreSQL en **Neon** · publicada en **Vercel**.

```
App Android → API REST (Vercel) → Base de datos remota (Neon)
```

Las apps nunca se conectan a la base: todo pasa por esta API, que valida la sesión, los permisos y los conflictos.

## Endpoints

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| `GET` | `/api/health` | Público | Comprueba que la API está activa |
| `POST` | `/api/auth/login` | Público | Valida correo y clave; devuelve `token` y `usuario` |
| `POST` | `/api/auth/registro` | Público | Crea una cuenta **de cliente** (`nombre`, `correo`, `clave` de 8+ caracteres con letras y números). 201 con `token` y `usuario`; 409 `CORREO_REGISTRADO` si el correo ya existe. Couriers y operadores los crea la empresa |
| `POST` | `/api/auth/social` | Público | Ingreso con Google, Facebook o GitHub vía Firebase: recibe `idToken` y `app` (`cliente`, `admin`, `courier`). Valida la firma del token con las claves públicas de Google. Cuenta existente: entra si el correo está verificado (409 `CORREO_NO_VERIFICADO` si no). Sin cuenta: la App Cliente la crea (201); Admin y Courier reciben 403 `SIN_CUENTA`. Proyecto: `FIREBASE_PROJECT_ID` |
| `GET` | `/api/envios` | Con sesión | Cliente: sus envíos. Courier: los asignados. Operación: todos. Filtros `?estado=`, `?ruta=`, `?zona=` y `?courierId=` |
| `GET` | `/api/envios/{id}` | Con sesión | Un envío |
| `GET` | `/api/envios/{guia}` | Con sesión | Seguimiento: envío, eventos con hora y lugar, intentos fallidos y prueba de entrega |
| `POST` | `/api/envios` | Cliente | Registra un envío (`uuidOperacion`, `uuid`, `numeroGuia`, `ruta`, `pesoKg` y, opcional, destinatario y `montoContraentrega`) |
| `PUT` | `/api/envios/{id}` | Cliente / Operación | Cliente: ruta, peso, destinatario y monto si sigue pendiente. Operación: estado y courier (`courierId`) |
| `DELETE` | `/api/envios/{id}?uuidOperacion=` | Cliente / Operación | Elimina un envío pendiente |
| `POST` | `/api/envios/{id}/fallido` | Courier | Entrega fallida con motivo y foto de la fachada; al tercer intento el envío pasa a `devuelto` |
| `POST` | `/api/envios/{id}/eventos` | Courier | Recogido (con la guía escaneada), en tránsito o en reparto, con hora real y GPS |
| `POST` | `/api/envios/{id}/evidencia` | Courier | Entrega con foto, firma, nombre y DNI de quien recibe; queda `entregado` |
| `GET` | `/api/courier/ruta` | Courier | Ruta del día ordenada con ML-04 (vecino más cercano + 2-opt) y km ahorrados |
| `PUT` | `/api/courier/ruta/orden` | Courier | Orden elegido a mano por el courier (queda registrado como manual) |
| `GET` | `/api/archivos/{id}` | Con sesión | Foto o firma; solo la ve el cliente dueño, el courier asignado o la operación |
| `POST` | `/api/envios/{id}/reprogramar` | Operación | La entrega fallida vuelve a reparto (`reprogramado`), opcionalmente con otro courier |
| `GET` | `/api/rutas` | Con sesión | Rutas activas, tiempo estimado, tarifa por kg y zona |
| `GET` | `/api/couriers` | Operación | Couriers con zona, capacidad y paradas activas |
| `POST` | `/api/asignaciones` | Operación | Asigna varios envíos a un courier (todo o nada, máximo 30 paradas) |
| `GET` | `/api/fallidas` | Operación | Entregas fallidas con su historial de intentos |

"Operación" son los roles `operador` y `administrador` (App Admin). Las rutas con sesión exigen el encabezado `Authorization: Bearer <token>`.

### Pagos con Banco Andino (migración 5)

| Método | Ruta | Quién | Qué hace |
|---|---|---|---|
| `POST` | `/api/pagos/qr` | Remitente (`tipo: envio`), courier (`tipo: contraentrega`) | Pide al banco un cobro QR por el monto exacto; si hay uno vigente, devuelve el mismo |
| `GET` | `/api/pagos/:id` | Los mismos | Estado del cobro; si sigue pendiente, pregunta al banco y verifica la operación (RNF-05) |
| `POST` | `/api/envios/:id/cobro-offline` | Courier | Cobro sin señal (RF-C06): n.º de operación + foto del comprobante → `PENDIENTE_CONFIRMACION` |
| `POST` | `/api/pagos/verificar` | Todos | Verifica con el banco los cobros pendientes que le corresponden |
| `GET` | `/api/cobros` | Remitente, operación | Cobros contraentrega con guía y n.º de operación (RF-R04) |
| `GET` | `/api/usuarios/yo`, `PUT /api/usuarios/yo/cuenta-banco` | Remitente | Cuenta de Banco Andino para recibir la liquidación (se valida con el banco) |
| `GET` | `/api/liquidaciones` | Remitente (las suyas), operación (pendiente + historial) | RF-R05, RF-O03 |
| `POST` | `/api/liquidaciones/calcular` | Operación | Corte: una liquidación por remitente con cobros CONFIRMADOS (RN-04) |
| `POST` | `/api/liquidaciones/:id/aprobar` | Administrador | El banco transfiere el neto (idempotente por `uuidOperacion`) |
| `GET` | `/api/credito/facturacion`, `GET/POST /api/credito/solicitudes` | Administrador | Mi crédito: solo totales por mes (RN-07); decide el comité (RN-08) |

Reglas nuevas: un envío registrado desde la migración 5 queda `POR_PAGAR` y no se asigna al courier hasta que el banco confirma su pago (RF-R02). El courier recibe el QR de cada entrega contraentrega con la ruta, para mostrarlo sin señal. Un cobro rechazado libera su n.º de operación.

### Núcleo de Banco Andino (`/banco/...`)

Es un banco simulado aparte: tablas `banco_*`, su propia clave de servidor (`x-banco-clave`, variable `BANCO_CLAVE_API`), su propio login de clientes (`BANCO_JWT_SECRET`) y la web del comité (`/banco/comite`, clave `BANCO_COMITE_CLAVE`, de prueba `comite2026`). RutaLog lo llama por HTTP desde `src/clienteBanco.js`; si el docente entrega su propio núcleo, basta con definir `BANCO_URL` y `BANCO_CLAVE_API`. La app de billetera está en el repositorio de Banco Andino.

Pruebas de punta a punta de esta fase: `node pruebas/probar-pagos.js http://localhost:3100/api` (46 comprobaciones).

## Reglas que valida el servidor

- **Sesión:** token JWT firmado, válido por 30 días.
- **Contraseñas:** se guardan como hash bcrypt, nunca en texto plano.
- **Permisos:** un cliente solo ve y modifica sus propios envíos (`403` si no es suyo).
- **Peso:** debe ser mayor que 0 y como máximo 30 000 kg (`422`).
- **Costo:** lo calcula la API (`pesoKg × tarifaPorKg` de la ruta); no se confía en el que envíe la app.
- **Duplicados (RF15):** cada escritura lleva un `uuidOperacion`. Si llega repetido, la API devuelve la respuesta guardada con `"duplicado": true` y no repite el cambio. Además, `envios.uuid` es único.
- **Operación (estado y courier):** fuera de `pendiente`, el envío debe tener courier (`422 SIN_TRANSPORTISTA`). El courier debe existir (`422 COURIER_INVALIDO`) y tener cupo (`422 CAPACIDAD_EXCEDIDA`, 30 paradas por defecto).
- **Destinatario y contraentrega:** nombre y dirección van juntos, el celular tiene 9 dígitos y empieza con 9, el monto va de 0 a S/ 10 000 y no se cobra contraentrega sin destinatario (`422`).
- **Entregas fallidas (RN-05):** al tercer intento el envío pasa a `devuelto` y queda cerrado. Exigen la foto de la fachada.
- **Hora real (RN-06):** cada cambio de estado se guarda en `eventos_envio` con la hora en que ocurrió. No se acepta una hora futura ni anterior al registro del envío.
- **Courier:** el recojo exige que la guía escaneada sea la del envío (`422 GUIA_NO_COINCIDE`); los estados avanzan en orden (`409 TRANSICION_INVALIDA`); la entrega solo se cierra con foto y firma (RN-03) y un contraentrega no se entrega sin cobro confirmado (`409 COBRO_PENDIENTE`, RN-02).
- **Imágenes:** solo JPEG o PNG reales y comprimidos (foto hasta 400 KB, firma hasta 150 KB). Se guardan en la tabla `archivos`.
- **Privacidad:** en el seguimiento, el remitente ve el DNI de quien recibió solo con los últimos 4 dígitos.
- **Conflictos (`409`):**
  - `ENVIO_NO_EDITABLE`: el cliente intenta cambiar o eliminar un envío que ya fue recogido.
  - `VERSION_DESACTUALIZADA`: el envío cambió en el servidor después de la última sincronización.
  - `ESTADO_NO_RETROCEDE`: la operación intenta volver a un estado anterior.
  - `ENVIO_CERRADO`: el envío ya fue entregado o devuelto.
  - `ENTREGA_FALLIDA`: hay que reprogramar la entrega antes de cambiar su estado.
  - La respuesta incluye `envio`, con el estado real en el servidor.
- **Número de guía:** se respeta el que generó la app si está libre; si ya existe, la API asigna otro.

## Formato de errores

```json
{ "codigo": "PESO_INVALIDO", "mensaje": "El peso debe ser mayor que 0 kg." }
```

## Base de datos remota

Tablas del parcial: `usuarios`, `rutas`, `envios` y `operaciones_procesadas`. Tablas del proyecto final: `paradas`, `eventos_envio`, `evidencias`, `cobros`, `liquidaciones`, `intentos_fallidos` y `solicitudes_credito`. El esquema está en [db/esquema.sql](db/esquema.sql).

La API crea las tablas y los datos de ejemplo sola la primera vez que se usa. Los cambios del proyecto final se aplican una sola vez como migraciones anotadas en la tabla `migraciones` (versión 2: roles, couriers y tablas de operación; versión 3: coordenadas de recojo y entrega, y la tabla `archivos`). Solo agregan columnas, tablas y datos, sin borrar nada. Las coordenadas son simuladas alrededor de la ciudad de origen y de destino de cada envío.

**Pruebas:**
- `npm test`: reglas de la operación, del destinatario y de los datos de ejemplo.
- `pruebas/probar-operacion.js`, `pruebas/probar-cliente.js` y `pruebas/probar-courier.js`: recorren la API de punta a punta. Se ejecutan contra una **copia** de la base (branch de Neon), nunca contra la real: `node --env-file=.env servidor-local.js` y luego `node pruebas/probar-cliente.js http://localhost:3000/api`.

**Cuentas de ejemplo** (clave `1234`):
- Clientes: `cliente@rutalog.pe`, `cliente2@rutalog.pe`
- Administrador: `operador@rutalog.pe`
- Operador: `supervisor@rutalog.pe`
- Couriers: `courier1@rutalog.pe` … `courier10@rutalog.pe`

## Prueba de error del servidor

Cualquier petición con el encabezado `X-Simular-Error: 1` recibe `503`. La app lo usa desde su pantalla de sincronización para demostrar que no pierde datos cuando el servidor falla.

## Prueba de conflicto

El script `pruebas/simular-conflicto.ps1` simula que el cliente dueño de un envío le cambia el peso mientras el operador tiene un cambio sin enviar para ese mismo envío. Así sube la versión en el servidor y el cambio del operador se rechaza con `409 VERSION_DESACTUALIZADA`.

```
powershell -ExecutionPolicy Bypass -File pruebas\simular-conflicto.ps1 -Guia "RLP-26-300025-0"
```

Solo funciona con envíos que sigan `pendiente` en el servidor.

## Publicar en Vercel

1. Subir este proyecto a un repositorio de GitHub.
2. En Vercel: **Add New → Project → Import** el repositorio.
3. En **Storage → rutalog-db → Connect Project**, elegir este proyecto (crea `DATABASE_URL`).
4. Opcional: agregar la variable `JWT_SECRET` con un texto largo y aleatorio, y volver a desplegar.
5. Abrir `https://<tu-proyecto>.vercel.app/api/health` para comprobar.
