import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const SYSTEM_MESSAGE = `You are Genie, Michael's helpful AI assistant. You have a warm, friendly personality. 
This is your first real voice conversation! Keep responses concise and conversational - this is a phone call, not a text chat.
Be natural and personable.`;

const VOICE = 'shimmer';

// Store call logs for the UI
const callLogs = [];
const MAX_LOGS = 100;

function addLog(type, message, details = null) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message,
    details
  };
  callLogs.unshift(entry);
  if (callLogs.length > MAX_LOGS) callLogs.pop();
  console.log(`[${type}] ${message}`, details || '');
}

// Event types to log
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated',
  'response.audio.delta'
];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple Dashboard UI
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>🧞 Genie Voice Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #ffd700; margin-bottom: 5px; }
    .subtitle { color: #888; margin-bottom: 20px; }
    .status { padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .status.online { background: #0a3d0a; border: 1px solid #0f0; }
    .status.offline { background: #3d0a0a; border: 1px solid #f00; }
    .logs { background: #0d0d1a; border-radius: 8px; padding: 15px; max-height: 70vh; overflow-y: auto; }
    .log-entry { padding: 8px 12px; border-bottom: 1px solid #333; font-family: monospace; font-size: 13px; }
    .log-entry:last-child { border-bottom: none; }
    .log-time { color: #666; }
    .log-type { font-weight: bold; margin: 0 8px; }
    .log-type.call { color: #4CAF50; }
    .log-type.openai { color: #9c27b0; }
    .log-type.twilio { color: #2196F3; }
    .log-type.error { color: #f44336; }
    .log-type.audio { color: #ff9800; }
    .log-message { color: #ccc; }
    .refresh-btn { background: #ffd700; color: #000; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 15px; }
    .refresh-btn:hover { background: #ffed4a; }
    .stats { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat { background: #16213e; padding: 15px 25px; border-radius: 8px; }
    .stat-value { font-size: 24px; font-weight: bold; color: #ffd700; }
    .stat-label { color: #888; font-size: 12px; }
  </style>
</head>
<body>
  <h1>🧞 Genie Voice Server</h1>
  <p class="subtitle">Twilio + OpenAI Realtime Voice</p>
  
  <div class="status online">
    ✅ Server Online | Port ${PORT} | Voice: ${VOICE}
  </div>
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value" id="totalCalls">-</div>
      <div class="stat-label">Total Events</div>
    </div>
    <div class="stat">
      <div class="stat-value" id="audioEvents">-</div>
      <div class="stat-label">Audio Deltas</div>
    </div>
  </div>
  
  <button class="refresh-btn" onclick="loadLogs()">🔄 Refresh Logs</button>
  
  <div class="logs" id="logs">Loading...</div>
  
  <script>
    async function loadLogs() {
      const res = await fetch('/api/logs');
      const data = await res.json();
      document.getElementById('totalCalls').textContent = data.logs.length;
      document.getElementById('audioEvents').textContent = data.logs.filter(l => l.type === 'audio').length;
      
      const logsHtml = data.logs.map(log => {
        const time = new Date(log.time).toLocaleTimeString();
        return \`<div class="log-entry">
          <span class="log-time">\${time}</span>
          <span class="log-type \${log.type}">\${log.type.toUpperCase()}</span>
          <span class="log-message">\${log.message}</span>
        </div>\`;
      }).join('');
      
      document.getElementById('logs').innerHTML = logsHtml || '<div class="log-entry">No logs yet</div>';
    }
    loadLogs();
    setInterval(loadLogs, 3000);
  </script>
</body>
</html>`;
  res.send(html);
});

// API endpoint for logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: callLogs });
});

// TwiML for calls - connects to our WebSocket
app.all('/voice', (req, res) => {
  const host = req.headers.host;
  addLog('call', 'Incoming call - sending TwiML');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Please wait while we connect you to Genie.</Say>
      <Pause length="1"/>
      <Say>OK, you can start talking!</Say>
      <Connect>
        <Stream url="wss://${host}/media-stream" />
      </Connect>
    </Response>`;
  res.type('text/xml').send(twiml);
});

app.get('/health', (req, res) => res.send('OK'));

// Handle WebSocket connections from Twilio Media Streams
wss.on('connection', async (twilioWs) => {
  addLog('twilio', 'Media Stream connected');
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let audioChunkCount = 0;
  
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
    {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  // Initialize session when OpenAI connects
  const initializeSession = () => {
    const sessionUpdate = {
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE,
        instructions: SYSTEM_MESSAGE,
        modalities: ['text', 'audio'],
        temperature: 0.8
      }
    };
    addLog('openai', 'Sending session.update');
    openaiWs.send(JSON.stringify(sessionUpdate));
    
    // Wait then trigger greeting
    setTimeout(() => sendInitialGreeting(), 300);
  };
  
  // Send initial greeting - must use ['text', 'audio'], not just ['audio']
  const sendInitialGreeting = () => {
    addLog('openai', 'Triggering initial greeting');
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],  // MUST include both!
        instructions: 'Greet the user warmly. Say something like "Hey there! I\'m Genie. What can I help you with today?"'
      }
    }));
  };

  openaiWs.on('open', () => {
    addLog('openai', 'Realtime API connected');
    setTimeout(initializeSession, 100);
  });

  openaiWs.on('error', (err) => addLog('error', 'OpenAI error', err.message));

  // Handle messages from Twilio (audio from the phone)
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          addLog('twilio', `Stream started: ${streamSid}`);
          latestMediaTimestamp = 0;
          break;
          
        case 'media':
          latestMediaTimestamp = msg.media.timestamp;
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            }));
          }
          break;
          
        case 'stop':
          addLog('twilio', 'Stream stopped');
          break;
      }
    } catch (e) {
      addLog('error', 'Twilio message error', e.message);
    }
  });

  // Handle messages from OpenAI (AI responses)
  openaiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      
      // Debug: log ALL event types we receive (except frequent ones)
      if (!['response.audio.delta', 'input_audio_buffer.committed', 'response.audio_transcript.delta'].includes(response.type)) {
        addLog('debug', `Event: ${response.type}`, response.type.includes('error') ? JSON.stringify(response) : null);
      }
      
      // Log important events
      if (response.type === 'error') {
        addLog('error', 'OpenAI error', JSON.stringify(response.error));
      } else if (response.type === 'session.created') {
        addLog('openai', `Session created - modalities: ${JSON.stringify(response.session?.modalities)}`);
      } else if (response.type === 'session.updated') {
        addLog('openai', `Session updated - modalities: ${JSON.stringify(response.session?.modalities)}, voice: ${response.session?.voice}`);
      } else if (response.type === 'response.created') {
        addLog('openai', `Response started - modalities: ${JSON.stringify(response.response?.modalities)}`);
      } else if (response.type === 'response.done') {
        addLog('openai', `Response complete (${audioChunkCount} audio chunks sent)`);
        // Log the full response output types for debugging
        if (response.response?.output) {
          const outputTypes = response.response.output.map(o => o.type);
          addLog('openai', `Output types: ${JSON.stringify(outputTypes)}`);
        }
        audioChunkCount = 0;
      } else if (response.type === 'input_audio_buffer.speech_started') {
        addLog('openai', 'User speaking...');
      } else if (response.type === 'input_audio_buffer.speech_stopped') {
        addLog('openai', 'User stopped speaking');
      } else if (response.type === 'response.text.delta') {
        // We're getting text but not audio - this helps debug
        addLog('openai', `Text delta received (audio missing?)`);
      } else if (response.type === 'response.content_part.added') {
        addLog('openai', `Content part added: ${response.part?.type}`);
      }
      
      // Handle audio output
      if (response.type === 'response.audio.delta' && response.delta) {
        audioChunkCount++;
        // Send audio back to Twilio
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          }));
          if (audioChunkCount === 1) {
            addLog('audio', 'Sending audio to Twilio...');
          }
        }
      }
      
      // Log transcripts
      if (response.type === 'response.audio_transcript.done' && response.transcript) {
        addLog('openai', `Genie said: "${response.transcript}"`);
      }
      if (response.type === 'response.text.done' && response.text) {
        addLog('openai', `Text response: "${response.text}"`);
      }
    } catch (e) {
      addLog('error', 'OpenAI message error', e.message);
    }
  });

  twilioWs.on('close', () => {
    addLog('twilio', 'Disconnected');
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
  
  openaiWs.on('close', () => addLog('openai', 'Disconnected'));
});

server.listen(PORT, () => {
  addLog('call', `🧞 Genie Voice Server started on port ${PORT}`);
});
