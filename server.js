require('dotenv').config();
const app = require('./src/app');

const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Servidor en http://localhost:${port}`);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('Aviso: Supabase no configurado. Copiá .env.example a .env y completá las claves.');
    }
  });
}

module.exports = app;
