// vercel-webhook-service.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PrismaClient } = require('@prisma/client/edge');
const { withAccelerate } = require('@prisma/extension-accelerate');

const app = express();
const server = http.createServer(app);

// --- NEW: Added heartbeat configuration for connection stability ---
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    // Proactively check connection health every 25 seconds
    pingInterval: 25000, 
    // Wait 20 seconds for a response before disconnecting
    pingTimeout: 20000   
});

const prisma = new PrismaClient().$extends(withAccelerate());

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and environment variables
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const socketSecret = process.env.SOCKET_IO_SECRET; // For security

// In-memory store for logger page (for development)
const recentEvents = [];
const MAX_EVENTS = 50;

// Socket.IO Security Middleware: Ensures only authenticated clients can connect.
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token && token === socketSecret) {
        next();
    } else {
        console.warn('Unauthorized Socket.IO connection attempt rejected.');
        next(new Error("Authentication error"));
    }
});

io.on('connection', (socket) => {
    console.log(`A backend service connected via Socket.IO (ID: ${socket.id})`);
    socket.on('disconnect', (reason) => {
        console.log(`A backend service disconnected (ID: ${socket.id}, Reason: ${reason})`);
    });
});

// Route for GET requests (Webhook Verification)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

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


// Route for POST requests (Incoming Webhooks)
app.post('/', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`\nWebhook received at ${timestamp}`);

  if (process.env.DEV_MODE === 'true') {
    recentEvents.unshift({ id: new Date().getTime(), timestamp: timestamp, payload: req.body });
    if (recentEvents.length > MAX_EVENTS) { recentEvents.pop(); }
  }

  try {
    // Persist the event to the database
    await prisma.webhookEvent.create({
      data: { payload: req.body },
    });
    console.log('Webhook event saved to database.');

    // Emit the event to all connected backend services
    io.emit('new_webhook_event', req.body);
    console.log('Emitted new_webhook_event via Socket.IO');

    res.sendStatus(200);
  } catch (error) {
    console.error('Error in webhook handler:', error);
    res.sendStatus(500);
  }
});

// Route for event polling (as a fallback or for other services)
app.get('/events', async (req, res) => {
  // Security Check: Ensure only authorized services can poll for events
  const providedApiKey = req.headers['x-internal-api-key'];
  const expectedApiKey = process.env.INTERNAL_API_KEY;

  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    console.warn('Unauthorized attempt to access /events');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    // Find unprocessed events
    const unprocessedEvents = await prisma.webhookEvent.findMany({
      where: { processed: false },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    if (unprocessedEvents.length > 0) {
      const eventIds = unprocessedEvents.map(event => event.id);
      // Mark events as processed
      await prisma.webhookEvent.updateMany({
        where: { id: { in: eventIds } },
        data: { processed: true },
      });
      console.log(`Fetched and marked ${unprocessedEvents.length} events as processed.`);
    }
    
    // Return the events
    res.json(unprocessedEvents);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});
// --- Development-only Logger Page ---
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

// --- Development-only Database Viewer Page ---
app.get('/seeme', async (req, res) => {
  if (process.env.DEV_MODE !== 'true') {
    return res.status(404).send('Not Found');
  }

  try {
    const events = await prisma.webhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20, // Get the last 20 events
    });

    // Generate a simple HTML table to display the events
    let html = `
      <style>
        body { font-family: sans-serif; background-color: #f4f4f9; color: #333; padding: 20px; }
        h1 { color: #444; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 12px; border: 1px solid #ddd; text-align: left; }
        th { background-color: #007bff; color: white; }
        tr:nth-child(even) { background-color: #f2f2f2; }
        pre { background-color: #eee; padding: 10px; border-radius: 4px; white-space: pre-wrap; word-wrap: break-word; }
      </style>
      <head><title>Database Viewer</title><meta http-equiv="refresh" content="5"></head>
      <body>
        <h1>Webhook Database Viewer</h1>
        <p>Showing the last ${events.length} events saved to the database (auto-refreshes every 5 seconds).</p>
        <table>
          <tr>
            <th>ID</th>
            <th>Received At</th>
            <th>Processed?</th>
            <th>Payload</th>
          </tr>
    `;

    if (events.length === 0) {
      html += '<tr><td colspan="4">No events found in the database.</td></tr>';
    } else {
      events.forEach(event => {
        html += `
          <tr>
            <td>${event.id}</td>
            <td>${new Date(event.createdAt).toLocaleString()}</td>
            <td>${event.processed}</td>
            <td><pre><code>${JSON.stringify(event.payload, null, 2)}</code></pre></td>
          </tr>
        `;
      });
    }

    html += '</table></body>';
    res.send(html);

  } catch (error) {
    console.error('Error fetching from database:', error);
    res.status(500).send('Error fetching data from the database.');
  }
});

module.exports = server;
