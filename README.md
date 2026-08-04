# DevAgent

An autonomous coding agent with a web UI. You give it a goal, it reads the
project, writes code, runs tests, deploys, and reacts to whatever breaks — in a
loop, until the job is done or it runs out of attempts. The whole thing is
drivable from a phone browser.

## Why it exists

I wanted to be able to move a project forward while away from my desk. A terminal
agent is no help there. What's needed is a service you can reach from anywhere,
which runs straight into the obvious problem: the files are on a machine at home.

That constraint produced the most interesting piece of the design, and also its
biggest tradeoff — an agent with write access and a shell on a real machine,
sitting behind a single password.

## How it works

The server lives on Render and serves the UI. The filesystem doesn't. A **bridge**
process running on the local PC opens a WebSocket back to the server and executes
filesystem commands there. The server never touches the machine directly; it only
ever sees the result of operations the bridge was willing to run.

Claude Sonnet 4.5 drives it with six tools: `read_file`, `write_file`,
`delete_file`, `list_files`, `search_files`, `run_bash`. Every call is pushed to
the UI as it happens, so you can watch it work instead of guessing.

## Autonomy levels

- **Full auto** — it just goes.
- **Confirm files** — asks before writing anything.
- **Manual** — approval on every step.

## Stack

Node 20+, Express, WebSocket. Anthropic SDK for the model, Puppeteer for UI
tests, bcrypt and JWT for auth, plain JSON files for storage. Deployed to Render
via `render.yaml`.

## Things worth knowing

**Failed deploys roll back.** If a deploy doesn't come up, the previous state is
restored, so an unattended run can't leave the project half-broken.

**There's an iteration ceiling.** `MAX_ITERATIONS` defaults to 15 and bounds the
write → test → fix loop. Without it, an agent that isn't converging will happily
burn tokens forever on a bug it can't solve.

**The singleton bug.** Stopping the agent didn't clear its instance, so every
start after the first one hung. Resetting it explicitly on stop was the fix.

## Setup

```bash
npm install
cp .env.example .env    # ANTHROPIC_API_KEY, PASSWORD
npm start
```

Server comes up on `http://localhost:3000`. For local filesystem access you also
need the bridge running: `node bridge/index.js`, with its own `bridge/.env`.

One warning worth repeating: only point this at projects you have committed
somewhere. The agent can write files and run shell commands on whichever machine
the bridge is running on.
