import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ErpClient } from './erpClient';
import { AssistantAgent } from './agent';
import { ToolExecutor } from './tools';

dotenv.config();

const app = express();
const port = parseInt(process.env.AGENT_PORT || process.env.PORT || '3001', 10);
const laravelUrl = process.env.LARAVEL_API_URL || 'http://localhost:8000';

app.use(cors());
app.use(express.json());

const erpClient = new ErpClient(laravelUrl);
const agent = new AssistantAgent(erpClient);
const toolExecutor = new ToolExecutor(erpClient);

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'SlabERP-TypeScript-Agent',
    connected_erp: laravelUrl,
    timestamp: new Date().toISOString(),
  });
});

// Tool schemas endpoint
app.get('/tools', (req: Request, res: Response) => {
  res.json({
    tools: toolExecutor.getDefinitions(),
  });
});

// Assistant Chat endpoint
app.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message, conversation_id, role, email, password } = req.body;
    let token = req.body.token || req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!message) {
      return res.status(400).json({ error: 'Field "message" is required.' });
    }

    // Auto-login if token is not provided but credentials or default role is given
    let user = req.body.user;
    if (!user) {
      if (!token) {
        const loginEmail = email || (role === 'purchasing' ? 'purchasing@example.com' : 'sales@example.com');
        const loginPassword = password || 'password123';

        try {
          const auth = await erpClient.login(loginEmail, loginPassword);
          token = auth.token;
          user = auth.user;
        } catch (authErr: any) {
          return res.status(401).json({
            error: 'Could not authenticate with Laravel ERP. Ensure credentials or Bearer token is provided.',
            details: authErr.message,
          });
        }
      } else {
        try {
          user = await erpClient.getUser(token);
        } catch (uErr: any) {
          // Graceful fallback profile from role
          user = {
            id: role === 'purchasing' ? 2 : 1,
            name: role === 'purchasing' ? 'Purchasing Manager' : 'Sales Representative',
            email: role === 'purchasing' ? 'purchasing@example.com' : 'sales@example.com',
            role: role || 'sales',
          };
        }
      }
    }

    const convId = conversation_id || `conv-ts-${Date.now()}`;
    const result = await agent.processMessage(message, user, token, convId);

    return res.json(result);
  } catch (err: any) {
    console.error('Agent chat error:', err);
    return res.status(500).json({
      error: 'Failed to process assistant chat message',
      message: err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`TypeScript AI Agent listening on port ${port}`);
  console.log(`Connected to Laravel ERP at: ${laravelUrl}`);
});

