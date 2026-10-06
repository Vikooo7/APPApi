// Solo para probar en la PC: `npm start` con la variable DATABASE_URL definida.
const app = require('./src/app');

const puerto = process.env.PORT || 3000;
app.listen(puerto, () => {
  console.log(`API RutaLog en http://localhost:${puerto}`);
});
