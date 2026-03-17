require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook');
const mapRoutes = require('./routes/map');
const authRoutes = require('./routes/auth');
const zonesRoutes = require('./routes/zones');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'zamindar-backend', timestamp: new Date().toISOString() });
  });

  app.use('/webhook', webhookRoutes);
  app.use('/map', mapRoutes);
  app.use('/auth', authRoutes);
app.use('/zones', zonesRoutes);
  app.use(express.static('public'));

  app.listen(PORT, () => {
    console.log(`Zamindar backend running on port ${PORT}`);
    });
