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

// Event types to log
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'session.updated'
];

app.use(express.urlencoded({ extended: true }));

// TwiML for calls - connects to our WebSocket
app.all('/voice', (req, res) => {
  const host = req.headers.host;
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
  console.log('Twilio Media Stream connected');
  let streamSid = null;
  let latestMediaTimestamp = 0;
  
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
    console.log('Sending session update');
    openaiWs.send(JSON.stringify(sessionUpdate));
    
    // Make AI greet the user first
    sendInitialGreeting();
  };
  
  // Send initial greeting
  const sendInitialGreeting = () => {
    const initialItem = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Greet the user warmly. Say something like "Hey there! I\'m Genie. What can I help you with today?"'
          }
        ]
      }
    };
    
    console.log('Sending initial greeting prompt');
    openaiWs.send(JSON.stringify(initialItem));
    openaiWs.send(JSON.stringify({ type: 'response.create' }));
  };

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime connected');
    setTimeout(initializeSession, 100);
  });

  openaiWs.on('error', (err) => console.error('OpenAI error:', err));

  // Handle messages from Twilio (audio from the phone)
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          console.log('Stream started:', streamSid);
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
          
        case 'mark':
          // Handle mark events for audio sync
          break;
          
        default:
          console.log('Twilio event:', msg.event);
      }
    } catch (e) {
      console.error('Twilio message error:', e);
    }
  });

  // Handle messages from OpenAI (AI responses)
  openaiWs.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      
      // Log important events
      if (LOG_EVENT_TYPES.includes(response.type)) {
        console.log('OpenAI event:', response.type, response.type === 'error' ? response.error : '');
      }
      
      // Handle audio output - try both possible event names
      if ((response.type === 'response.audio.delta' || response.type === 'response.output_audio.delta') && response.delta) {
        // Send audio back to Twilio
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: response.delta }
          }));
        }
      }
      
      // Log transcripts
      if (response.type === 'response.audio_transcript.done' || response.type === 'response.content.done') {
        if (response.transcript) {
          console.log('Genie said:', response.transcript);
        }
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
