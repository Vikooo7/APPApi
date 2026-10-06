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
| `GET` | `/api/envios` | Con sesión | Cliente: solo sus envíos. Administrador: todos. Filtros `?estado=` y `?ruta=` |
| `GET` | `/api/envios/{id}` | Con sesión | Un envío |
| `POST` | `/api/envios` | Cliente | Registra un envío (`uuidOperacion`, `uuid`, `numeroGuia`, `ruta`, `pesoKg`) |
| `PUT` | `/api/envios/{id}` | Cliente / Administrador | Cliente: ruta y peso si sigue pendiente. Administrador: estado y transportista |
| `DELETE` | `/api/envios/{id}?uuidOperacion=` | Cliente / Administrador | Elimina un envío pendiente |
| `GET` | `/api/rutas` | Con sesión | Rutas activas, tiempo estimado y tarifa por kg |

Las rutas con sesión exigen el encabezado `Authorization: Bearer <token>`.

## Reglas que valida el servidor

- **Sesión:** token JWT firmado, válido por 30 días.
- **Contraseñas:** se guardan como hash bcrypt, nunca en texto plano.
- **Permisos:** un cliente solo ve y modifica sus propios envíos (`403` si no es suyo).
- **Peso:** debe ser mayor que 0 y como máximo 30 000 kg (`422`).
- **Costo:** lo calcula la API (`pesoKg × tarifaPorKg` de la ruta); no se confía en el que envíe la app.
- **Duplicados (RF15):** cada escritura lleva un `uuidOperacion`. Si llega repetido, la API devuelve la respuesta guardada con `"duplicado": true` y no repite el cambio. Además, `envios.uuid` es único.
- **Conflictos (`409`):**
  - `ENVIO_NO_EDITABLE`: el cliente intenta cambiar o eliminar un envío que ya fue recogido.
  - `VERSION_DESACTUALIZADA`: el envío cambió en el servidor después de la última sincronización.
  - La respuesta incluye `envio`, con el estado real en el servidor.
- **Número de guía:** se respeta el que generó la app si está libre; si ya existe, la API asigna otro.

## Formato de errores

```json
{ "codigo": "PESO_INVALIDO", "mensaje": "El peso debe ser mayor que 0 kg." }
```

## Base de datos remota

Tablas: `usuarios`, `rutas`, `envios` y `operaciones_procesadas`. El esquema está en [db/esquema.sql](db/esquema.sql).
La API crea las tablas y los datos de ejemplo sola la primera vez que se usa.

**Cuentas de ejemplo** (clave `1234`): `cliente@rutalog.pe`, `cliente2@rutalog.pe` y `operador@rutalog.pe` (administrador).

## Prueba de error del servidor

Cualquier petición con el encabezado `X-Simular-Error: 1` recibe `503`. La app lo usa desde su pantalla de sincronización para demostrar que no pierde datos cuando el servidor falla.

## Publicar en Vercel

1. Subir este proyecto a un repositorio de GitHub.
2. En Vercel: **Add New → Project → Import** el repositorio.
3. En **Storage → rutalog-db → Connect Project**, elegir este proyecto (crea `DATABASE_URL`).
4. Opcional: agregar la variable `JWT_SECRET` con un texto largo y aleatorio, y volver a desplegar.
5. Abrir `https://<tu-proyecto>.vercel.app/api/health` para comprobar.
