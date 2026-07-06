import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:18720/workspaces/c146c6c5-631b-4388-92db-f1112098007a/stream');
ws.on('open', () => { console.log('WS OPEN'); setTimeout(()=>process.exit(0),300); });
ws.on('error', (e) => { console.log('WS ERROR', e.message); process.exit(0); });
