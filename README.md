# 🤖 DevAgent

**Autonomous AI Development System powered by Claude**

DevAgent è un sistema di sviluppo autonomo che utilizza Claude AI per sviluppare, testare e deployare codice automaticamente.

## ✨ Features

- **🚀 Sviluppo Autonomo**: Claude AI scrive, rivede e corregge codice automaticamente
- **🔄 Loop Iterativo**: Ciclo continuo di sviluppo → review → deploy → test fino al completamento
- **📁 3 Livelli di Autonomia**:
  - **Full Auto**: Operazione completamente autonoma
  - **Confirm Files**: Richiede approvazione prima di modificare file
  - **Manual**: Richiede approvazione ad ogni step
- **🔙 Rollback Automatico**: Ripristina lo stato precedente se il deploy fallisce
- **🧪 Testing Automatico**: Supporto Puppeteer per UI testing
- **📱 Responsive UI**: Accessibile da desktop e mobile
- **🔐 Autenticazione**: Protezione con password singola + JWT

## 🛠️ Tech Stack

- **Backend**: Node.js 20+, Express, WebSocket
- **AI**: Anthropic SDK (Claude Sonnet 4 / Opus 4)
- **Testing**: Puppeteer
- **Auth**: bcrypt + JWT
- **Storage**: JSON files

## 📦 Installazione

### Prerequisiti

- Node.js 20+
- npm o yarn
- Account Anthropic con API key

### Setup Locale

```bash
# Clona il repository
git clone https://github.com/yourusername/devagent.git
cd devagent

# Installa dipendenze
npm install

# Copia e configura environment variables
cp .env.example .env

# Modifica .env con i tuoi valori:
# ANTHROPIC_API_KEY=sk-ant-...
# PASSWORD=your-secure-password

# Avvia il server
npm start
```

Il server sarà disponibile su `http://localhost:3000`

### Environment Variables

| Variable | Descrizione | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Chiave API Anthropic | ✅ |
| `PASSWORD` | Password per accesso | ✅ |
| `JWT_SECRET` | Secret per JWT (auto-generato se assente) | ❌ |
| `PORT` | Porta server (default: 3000) | ❌ |
| `NODE_ENV` | Environment (development/production) | ❌ |
| `MAX_ITERATIONS` | Max iterazioni agent (default: 15) | ❌ |

## 🚀 Deploy su Railway

1. **Push su GitHub**
   ```bash
   git add .
   git commit -m "Initial commit"
   git push origin main
   ```

2. **Connetti Railway**
   - Vai su [railway.app](https://railway.app)
   - Crea nuovo progetto da GitHub
   - Seleziona il repository

3. **Configura Environment Variables**
   - `ANTHROPIC_API_KEY`: La tua API key
   - `PASSWORD`: Password sicura
   - `NODE_ENV`: production

4. **Deploy automatico** - Railway builderà e deployerà automaticamente

## 📖 Uso

### 1. Login

Accedi con la password configurata in `PASSWORD`.

### 2. Crea un Progetto

- Nome del progetto
- Path assoluto alla directory del progetto
- (Opzionale) Comando deploy e URL
- (Opzionale) Comando test

### 3. Avvia l'Agent

1. Apri il workspace del progetto
2. Scrivi l'obiettivo (es. "Aggiungi un bottone per export PDF")
3. Seleziona livello di autonomia
4. Seleziona modello (Sonnet 4 o Opus 4)
5. Clicca "Start Agent"

### 4. Monitora il Progresso

- Timeline real-time degli eventi
- Richieste di autorizzazione (se non Full Auto)
- Notifica di completamento con riepilogo

## 🔌 API Reference

### REST Endpoints

```
POST /api/login              - Autenticazione
GET  /api/config             - Config pubblica
GET  /api/projects           - Lista progetti [AUTH]
POST /api/projects           - Crea progetto [AUTH]
GET  /api/projects/:id       - Dettaglio progetto [AUTH]
PUT  /api/projects/:id       - Aggiorna progetto [AUTH]
DELETE /api/projects/:id     - Elimina progetto [AUTH]
POST /api/agent/stop         - Ferma agent [AUTH]
GET  /api/agent/status       - Stato agent [AUTH]
GET  /api/health             - Health check
```

### WebSocket Events

```javascript
// Client → Server
{ type: 'AUTH', token: 'jwt...' }
{ type: 'START_AGENT', projectId, objective, autonomyLevel, model }
{ type: 'APPROVE_AUTH', requestId, approved, files, feedback }
{ type: 'STOP_AGENT' }

// Server → Client
{ type: 'PROGRESS', stage, message, emoji, timestamp }
{ type: 'REQUEST_AUTH', requestId, files }
{ type: 'READY_FOR_HUMAN', summary }
{ type: 'AGENT_COMPLETE', result }
{ type: 'AGENT_ERROR', error }
```

## 🧩 Architettura

```
devagent/
├── server.js           # Express + WebSocket server
├── lib/
│   ├── agent.js        # Core agent loop
│   ├── claude.js       # Claude API wrapper
│   ├── deployer.js     # Deploy + rollback
│   ├── tester.js       # Puppeteer testing
│   └── auth.js         # Authentication
├── public/             # Frontend
│   ├── index.html      # Login + Dashboard
│   ├── workspace.html  # Project workspace
│   ├── style.css       # Styles
│   └── app.js          # Client JS
├── config/
│   └── global.json     # Global config
└── data/
    └── projects.json   # Projects database
```

## 🔒 Sicurezza

- Password hashata con bcrypt (work factor 10)
- JWT con scadenza 24 ore
- Rate limiting su login (5 tentativi/minuto)
- Validazione path per prevenire path traversal
- Sanitizzazione comandi shell

## 🐛 Troubleshooting

### "ANTHROPIC_API_KEY not configured"
Verifica che la variabile ambiente sia impostata correttamente.

### "Project path does not exist"
Il path deve essere assoluto e la directory deve esistere sul server.

### WebSocket non si connette
Verifica che il server sia raggiungibile e non ci siano firewall che bloccano WebSocket.

### Agent si blocca
L'agent ha un limite di 15 iterazioni. Se raggiunto, prova con un obiettivo più specifico.

## 📄 License

MIT

## 🤝 Contributing

1. Fork il repository
2. Crea un branch (`git checkout -b feature/amazing-feature`)
3. Commit le modifiche (`git commit -m 'Add amazing feature'`)
4. Push il branch (`git push origin feature/amazing-feature`)
5. Apri una Pull Request
