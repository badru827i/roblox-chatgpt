# Roblox ChatGPT Builder

AI chat web app + Roblox Studio bridge. Chat with an OpenAI model and let it queue safe, structured commands for a Roblox Studio plugin.

## Railway variables

Set:

- `OPENAI_API_KEY` = your OpenAI API key
- `API_KEY` = a private password for the web chat
- `BRIDGE_TOKEN` = a private token for the Roblox Studio plugin (can be the same as `API_KEY`)
- `OPENAI_MODEL` = optional model override

Do not put `OPENAI_API_KEY` in frontend code.

## Railway

Build command: leave default.
Start command: `npm start`

## Roblox Studio

1. Open `roblox-plugin/RobloxChatGPTPlugin.lua`.
2. Install/use it as a Studio plugin.
3. Open **Roblox ChatGPT** from the Plugins toolbar.
4. Enter your Railway URL and `BRIDGE_TOKEN`.
5. Open the web app, enter `API_KEY`, then chat.

The plugin polls `/bridge/poll` and can create instances, set properties, edit script source through `ScriptEditorService:UpdateSourceAsync`, and delete instances. Roblox's current API documents `UpdateSourceAsync` as Plugin Security functionality. 

## Current MVP

The first version is intentionally small: chat, conversation memory, structured Roblox commands, and a Studio bridge. More tools such as output/error feedback, selection inspection, model context, undo checkpoints, and richer property conversion can be added next.
