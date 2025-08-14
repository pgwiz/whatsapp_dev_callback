const express = require('express');
// highlight-start
// Import the Edge-optimized client and the extension
const { PrismaClient } = require('@prisma/client/edge');
const { withAccelerate } = require('@prisma/extension-accelerate');
// highlight-end

// Initialize Express
const app = express();

// highlight-start
// Initialize Prisma with the Accelerate extension
// It will automatically use the DATABASE_URL from your environment
const prisma = new PrismaClient().$extends(withAccelerate());

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// --- NEW: In-memory store for recent events (for logger page) ---
const recentEvents = [];
const MAX_EVENTS = 50; // Store the last 50 events

// Route for GET requests (Webhook Verification)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  // --- MODIFIED: Add logging and trim whitespace for robust verification ---
  console.log('--- VERIFICATION ATTEMPT ---');
  console.log('Token from Meta:', token);
  console.log('Token from .env:', verifyToken);

  if (mode === 'subscribe' && token && verifyToken && token.trim() === verifyToken.trim()) {
    console.log('WEBHOOK VERIFIED SUCCESSFULLY');
    res.status(200).send(challenge);
  } else {
    console.error('WEBHOOK VERIFICATION FAILED');
    res.sendStatus(403);
  }
  console.log('--- END VERIFICATION ---');
});



// Route for POST requests (Receiving Webhooks)
app.post('/', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\nWebhook received at ${timestamp}\n`);

  // --- NEW: Add event to our in-memory logger if in DEV_MODE ---
  if (process.env.DEV_MODE === 'true') {
    recentEvents.unshift({
      id: new Date().getTime(),
      timestamp: timestamp,
      payload: req.body,
    });
    // Keep the array from getting too large
    if (recentEvents.length > MAX_EVENTS) {
      recentEvents.pop();
    }
  }

  try {
    // Save the webhook payload to the database
    await prisma.webhookEvent.create({
      data: {
        payload: req.body,
      },
    });
    console.log('Webhook event saved to database.');
    res.sendStatus(200);
  } catch (error) {
    console.error('Error saving webhook to database:', error);
    res.sendStatus(500);
  }
});

// Endpoint for the Python worker (unchanged)
app.get('/events', async (req, res) => {
  try {
    // 1. Find all unprocessed events
    const unprocessedEvents = await prisma.webhookEvent.findMany({
      where: { processed: false },
      orderBy: { createdAt: 'asc' }, // Process oldest first
      take: 10, // Process in batches of 10
    });

    if (unprocessedEvents.length === 0) {
      return res.json([]);
    }

    // 2. Mark these events as processed so they aren't fetched again
    const eventIds = unprocessedEvents.map(event => event.id);
    await prisma.webhookEvent.updateMany({
      where: { id: { in: eventIds } },
      data: { processed: true },
    });

    console.log(`Fetched and marked ${unprocessedEvents.length} events as processed.`);
    
    // 3. Return the events to the worker
    res.json(unprocessedEvents);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});
// --- NEW: Logger page route, only active in DEV_MODE ---
app.get('/logger', (req, res) => {
  if (process.env.DEV_MODE !== 'true') {
    return res.status(404).send('Not Found');
  }

  // Generate a simple HTML page to display the events
  let html = `
    <style>
      body { font-family: monospace; background-color: #1e1e1e; color: #d4d4d4; padding: 20px; }
      h1 { color: #569cd6; }
      div { background-color: #252526; border: 1px solid #333; border-radius: 4px; padding: 15px; margin-bottom: 15px; }
      pre { white-space: pre-wrap; word-wrap: break-word; }
    </style>
    <head><title>Webhook Logger</title><meta http-equiv="refresh" content="5"></head>
    <body><h1>Live Webhook Logger</h1>
    <h2>Last ${recentEvents.length} events (auto-refreshes every 5 seconds):</h2>
  `;

  if (recentEvents.length === 0) {
    html += '<div><p>No events received yet. Send a message to your WhatsApp number.</p></div>';
  } else {
    recentEvents.forEach(event => {
      html += `
        <div>
          <p><strong>Received at:</strong> ${event.timestamp}</p>
          <pre><code>${JSON.stringify(event.payload, null, 2)}</code></pre>
        </div>
      `;
    });
  }

  html += '</body>';
  res.send(html);
});


// Start the server
app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
