function verifyWebhook(req, res, next) {
    if (req.method === 'GET') {
          const token = req.query['hub.verify_token'];
          if (!token || token !== process.env.STRAVA_VERIFY_TOKEN) {
                  console.warn('Webhook GET verification failed: token mismatch');
                  return res.status(403).json({ error: 'Verification failed' });
          }
          return next();
    }

  if (req.method === 'POST') {
        const { object_type, aspect_type, object_id, owner_id } = req.body || {};

      if (!object_type || !aspect_type || object_id === undefined || owner_id === undefined) {
              console.warn('Webhook POST rejected: missing required Strava fields', req.body);
              return res.status(400).json({ error: 'Invalid webhook payload' });
      }

      const validObjectTypes = ['activity', 'athlete'];
        const validAspectTypes = ['create', 'update', 'delete'];

      if (!validObjectTypes.includes(object_type) || !validAspectTypes.includes(aspect_type)) {
              console.warn('Webhook POST rejected: invalid event type', { object_type, aspect_type });
              return res.status(400).json({ error: 'Invalid event type' });
      }

      const subId = req.body.subscription_id;
        const expectedSubId = process.env.STRAVA_SUBSCRIPTION_ID;
        if (expectedSubId && subId && String(subId) !== String(expectedSubId)) {
                console.warn('Webhook POST rejected: subscription_id mismatch', { subId, expectedSubId });
                return res.status(403).json({ error: 'Subscription mismatch' });
        }

      return next();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = { verifyWebhook };
