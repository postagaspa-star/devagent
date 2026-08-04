# DevAgent

Agente di sviluppo autonomo con interfaccia web: gli descrivi un obiettivo, lui
legge il progetto, scrive il codice, lo testa, lo deploya e reagisce agli errori
in un ciclo continuo. Guidabile dal browser del telefono.

## Perché esiste

L'idea era poter far avanzare un progetto mentre non sono al PC. Un agente da
terminale non serve a questo: serve un servizio raggiungibile da fuori, che però
deve poter toccare i file che stanno sul PC di casa.

Da qui la parte architettonicamente più interessante del progetto — e il suo
compromesso principale, un agente con accesso in scrittura e shell su una
macchina reale, protetto da una sola password.

## Come funziona

Il server sta su Render ed espone la UI. Il filesystem, però, è quello del PC
locale: un **bridge** in esecuzione sul PC si collega al server via WebSocket ed
esegue lì i comandi. Il server non ha mai accesso diretto alla macchina — riceve
solo il risultato delle operazioni che il bridge accetta di eseguire.

Claude Sonnet 4.5 lavora con sei strumenti: `read_file`, `write_file`,
`delete_file`, `list_files`, `search_files`, `run_bash`. Ogni chiamata è
trasmessa alla UI in tempo reale, quindi si vede cosa sta facendo mentre lo fa.

## Livelli di autonomia

- **Full Auto** — opera senza chiedere.
- **Confirm Files** — chiede approvazione prima di modificare i file.
- **Manual** — approvazione a ogni singolo step.

## Stack

Node.js 20+, Express, WebSocket. Anthropic SDK per il modello, Puppeteer per i
test di interfaccia, bcrypt + JWT per l'autenticazione, storage su file JSON.
Deploy su Render tramite `render.yaml`.

## Note tecniche

- **Rollback sul deploy fallito**: se il deploy non va a buon fine lo stato
  precedente viene ripristinato, così un ciclo autonomo non lascia il progetto
  rotto a metà.
- **Tetto di iterazioni**: `MAX_ITERATIONS` (default 15) limita il ciclo
  scrivi → testa → correggi. Senza, un agente che non converge continua a
  bruciare token su un errore che non sa risolvere.
- **Bug del singleton**: allo stop l'istanza dell'agente non veniva azzerata e
  ogni avvio successivo restava bloccato. Il reset esplicito allo stop è stato
  il fix.

## Setup

```bash
npm install
cp .env.example .env    # ANTHROPIC_API_KEY, PASSWORD
npm start
```

Server su `http://localhost:3000`. Per l'accesso al filesystem locale serve anche
il bridge: `node bridge/index.js`, configurato con il proprio `bridge/.env`.

> Progetto personale sperimentale. Da usare solo su progetti di cui si ha una
> copia versionata: l'agente può scrivere ed eseguire comandi sulla macchina su
> cui gira il bridge.
