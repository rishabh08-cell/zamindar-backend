import express from 'express';
import cors from 'cors';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import cmsRoutes from './routes/cms';
import contentRoutes from './routes/content';
import publishRoutes from './routes/publish';

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Health check ---
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cms-connector', version: '0.1.0' });
});

// --- Routes ---
app.use('/auth', authRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/publish', publishRoutes);

// --- Error handler ---
app.use(errorHandler);

// --- Start ---
app.listen(config.port, () => {
  console.log(`CMS Connector running on port ${config.port} [${config.nodeEnv}]`);
});

export default app;
