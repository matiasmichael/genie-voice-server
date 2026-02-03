import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// TwiML for calls - connects to our WebSocket
app.all('/voice', (req, res) => {
  const host = req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting you to Genie. Please wait.</Say>
      <Connect>
        <Stream url="wss://${host}/media-stream" />
      </Connect>
    </Response>`;
  res.type('text/xml').send(twiml);
});

app.get('/health', (req, res) => res.send('OK'));

// Handle WebSocket connections from Twilio Media Streams
wss.on('connection', async (twilioWs) => {
  console.log('Twilio Media Stream connected');
  let streamSid = null;
  
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

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime connected');
    // Configure the session for phone audio
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: 'shimmer',
        instructions: `You are Genie, Michael's helpful AI assistant. You have a warm, friendly personality. 
          You're excited because this is your first real voice conversation!
          Keep responses concise and conversational - this is a phone call, not a text chat.
          Be natural and personable.`,
        modalities: ['text', 'audio'],
        temperature: 0.8
      }
    }));
    
    // Prompt the AI to greet the user immediately
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: 'Greet Michael warmly! This is your first voice call with him. Be excited but natural.'
        }
      }));
    }, 500);
  });

  openaiWs.on('error', (err) => console.error('OpenAI error:', err));

  // Handle messages from Twilio (audio from the phone)
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('Stream started:', streamSid);
      }
      
      if (msg.event === 'media' && openaiWs.readyState === WebSocket.OPEN) {
        // Send audio to OpenAI
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }
    } catch (e) {
      console.error('Twilio message error:', e);
    }
  });

  // Handle messages from OpenAI (AI responses)
  openaiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      
      // Log all message types for debugging
      console.log('OpenAI event:', response.type);
      
      // Log errors
      if (response.type === 'error') {
        console.error('OpenAI error:', JSON.stringify(response.error));
      }
      
      // Log session updates
      if (response.type === 'session.created' || response.type === 'session.updated') {
        console.log('Session configured:', response.type);
      }
      
      // Log response creation
      if (response.type === 'response.created') {
        console.log('Response started');
      }
      
      if (response.type === 'response.audio.delta' && response.delta) {
        // Send audio back to Twilio
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          }));
        }
      }
      
      if (response.type === 'response.audio_transcript.done') {
        console.log('Genie said:', response.transcript);
      }
      
      if (response.type === 'response.done') {
        console.log('Response complete');
      }
    } catch (e) {
      console.error('OpenAI message error:', e);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
  
  openaiWs.on('close', () => console.log('OpenAI disconnected'));
});

server.listen(PORT, () => {
  console.log(`🧞 Genie Voice Server running on port ${PORT}`);
});
