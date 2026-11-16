const test = require('node:test');
const assert = require('node:assert/strict');
const { validarRegistro } = require('../src/auth');

const falla = (cuerpo, codigo) =>
  assert.throws(() => validarRegistro(cuerpo), (e) => e.estado === 422 && e.codigo === codigo);

test('una cuenta válida se limpia: correo en minúsculas y nombre sin espacios de más', () => {
  const r = validarRegistro({ nombre: '  Ana   Quispe ', correo: ' Ana.Quispe@Gmail.com ', clave: 'envios2026' });
  assert.deepEqual(r, { nombre: 'Ana Quispe', correo: 'ana.quispe@gmail.com', clave: 'envios2026' });
});

test('faltan datos (422)', () => {
  falla({ correo: 'a@b.pe', clave: 'clave1234' }, 'DATOS_INCOMPLETOS');
  falla({ nombre: 'Ana', clave: 'clave1234' }, 'DATOS_INCOMPLETOS');
  falla(undefined, 'DATOS_INCOMPLETOS');
});

test('correo con formato inválido (422)', () => {
  falla({ nombre: 'Ana', correo: 'ana@gmail', clave: 'clave1234' }, 'CORREO_INVALIDO');
  falla({ nombre: 'Ana', correo: 'ana gmail.com', clave: 'clave1234' }, 'CORREO_INVALIDO');
});

test('contraseña corta o solo letras / solo números (422)', () => {
  falla({ nombre: 'Ana', correo: 'ana@gmail.com', clave: 'abc12' }, 'CLAVE_DEBIL');
  falla({ nombre: 'Ana', correo: 'ana@gmail.com', clave: 'solamenteletras' }, 'CLAVE_DEBIL');
  falla({ nombre: 'Ana', correo: 'ana@gmail.com', clave: '1234567890' }, 'CLAVE_DEBIL');
});

test('nombre demasiado corto (422)', () => {
  falla({ nombre: 'A', correo: 'ana@gmail.com', clave: 'clave1234' }, 'NOMBRE_INVALIDO');
});

test('el rol nunca viene del cliente: se ignora si lo envían', () => {
  const r = validarRegistro({ nombre: 'Ana', correo: 'ana@gmail.com', clave: 'clave1234', rol: 'administrador' });
  assert.equal(r.rol, undefined);
});
