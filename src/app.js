const path = require('path');
const express = require('express');

const publicRoutes = require('./routes/admin');
const mpRoutes = require('./routes/mp');
const webhookRoutes = require('./routes/webhook');
const syncRoutes = require('./routes/sync');

const app = express();

app.use(express.json({ limit: '1mb' }));

// Rutas API
app.use('/api', publicRoutes);
app.use('/api', mpRoutes);
app.use('/api', webhookRoutes);
app.use('/api', syncRoutes);

// Estáticos (solo en desarrollo local; en Vercel los sirve la plataforma)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

// Manejador de errores
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err.message || 'Error interno' });
});

module.exports = app;
