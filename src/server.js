require('dotenv').config();
const express = require('express');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const mapRoutes = require('./routes/map');
const authRoutes = require('./routes/auth');
const zonesRoutes = require('./routes/zones');
const socialRoutes = require('./routes/social');

const { requireAuth } = require('./middleware/auth');
const { verifyWebhook } = require('./middleware/webhookSignature');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'zamindar-backend', timestamp: new Date().toISOString() });
});

app.use('/auth', authRoutes);

app.use('/webhook', verifyWebhook, webhookRoutes);

app.use('/api/map', requireAuth, mapRoutes);
app.use('/api/zones', requireAuth, zonesRoutes);
app.use('/api/social', requireAuth, socialRoutes);

app.use(express.static('public'));

app.listen(PORT, () => {
    console.log(`Zamindar backend running on port ${PORT}`);
});
