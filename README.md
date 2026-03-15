# The Infinite Game

A browser-first infinite choose-your-own-adventure built with React, Vite, and WebLLM.

## What it does

- Uses WebLLM in a Web Worker for the dungeon master and NPC dialogue.
- Defers WebLLM catalog and engine loading until the local provider is explicitly selected.
- Adds an optional OpenRouter runtime for mobile or lower-powered devices.
- Adds Supabase-backed accounts with email verification or Google OAuth plus cloud-synced campaign history.
- Restricts the model picker to WebLLM models exported as tool-calling-capable.
- Starts from either one of 24 curated opening conditions or a custom user-written theme.
- Gives the dungeon master a broader structured tool surface for environment state, memory, ruleset mutation, player stats, class changes, spells, inventory, quests, NPCs, enemies, and art generation.
- Starts the player from a DnD-style class and spell baseline, while allowing the dungeon master to improvise or rewrite systems for modern, ancient, hybrid, or fully custom settings.
- Tracks inventory items with generated SVG icons plus rarity, slot, tags, value, modifiers, and custom attributes.
- Tracks active enemies with generated portraits and combat-facing stats.
- Maintains a memory ledger and a mutable ruleset summary so the dungeon master has durable context.

## Accounts and history

- Email/password accounts are handled through Supabase Auth and can require email confirmation.
- Google OAuth is supported through the same Supabase project.
- Campaign history is stored in Supabase and automatically synced for signed-in users.
- Local browser save-state still works even when Supabase is not configured.

Create the table and policies in your Supabase project with [supabase/schema.sql](supabase/schema.sql).

Required Vite environment variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

For Google OAuth, add your Vercel production URL and local dev URL to the Supabase Auth redirect list, then enable the Google provider in the Supabase dashboard.

## Image generation

By default, generated art uses the public Pollinations image endpoint.

Set `VITE_IMAGE_API_BASE` if you want to point the app at a different image generation backend that accepts prompt-in-path requests.

An example environment file is included at `.env.example`.

## Mobile support

- The UI is responsive and optimized for smaller screens.
- On mobile, OpenRouter is recommended over local WebLLM because many phones and tablets will not handle browser-side model execution well.

## OpenRouter key handling

- The app can accept a user-supplied OpenRouter API key.
- That key is stored encrypted at rest in the browser using Web Crypto, with the encryption key material persisted via IndexedDB.
- This is better than plain localStorage, but it is still a client-side secret flow. For stricter production security, prefer a server-side Vercel environment variable and proxy pattern.

## Run it

```bash
npm install
npm run dev
```

## Build it

```bash
npm run build
npm run lint
```

## Free hosting

The project includes `vercel.json` for Vercel's free tier.

Typical deploy flow:

```bash
npm install
npm run build
```

Then import the repository into Vercel, or run `vercel` locally if you use their CLI.

Recommended Vercel environment setup:

- `VITE_IMAGE_API_BASE` if you want a different image backend.
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for verified accounts and cloud history.

Supabase production checklist:

- Run [supabase/schema.sql](supabase/schema.sql) against your project.
- Enable email confirmations if you want verified-email sign-up enforced.
- Enable Google OAuth and add your Vercel URL plus local dev URL as redirect origins.
- Keep the anon key in Vercel env vars only; do not hardcode it.

## Requirements

- A browser with WebGPU support.
- Enough VRAM or shared GPU memory for the selected WebLLM model.
- Initial model downloads can be large and may take time on first load.
