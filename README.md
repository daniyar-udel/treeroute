# treeroute

`treeroute` is a multi-page Next.js web app for allergy-sensitive New Yorkers. It helps users choose safer walking routes by combining mapped NYC street trees, expected pollen exposure, weather, wind, and grounded Gemini explanations.

## Current product flow

The app now has three user-facing pages:

- `/` — landing page with route intent capture
- `/register` — required registration and allergy onboarding
- `/planner` — route planning workspace, available only after registration

Current experience:

1. A user enters `start` and `end` on the landing page.
2. When they click `Find Safe Route`, the route draft is saved locally.
3. They are redirected to registration.
4. They provide profile details and tree-allergy preferences.
5. After registration, the planner opens with the saved route already prefilled.

If the user knows which tree species trigger symptoms, the route ranking is personalized to those trees. If they do not know, the app minimizes overall tree exposure and still incorporates pollen and weather conditions.

## Why this fits the hackathon

- Civic data anchor: NYC `2015 Street Tree Census`
- Google stack: Google Cloud, Gemini via `@google/genai`, Google Maps APIs
- Clear public-interest framing: safer outdoor movement for allergy-sensitive residents
- Strong demo story: the safest route is not always the fastest route

## Core features

- Dedicated branded landing page in the `treeroute` visual style
- Required registration before using the planner
- Route handoff from landing page to registration to planner
- Tree-species-aware onboarding
- Alternative walking routes ranked by expected pollen exposure
- Signals from tree density, pollen, humidity, and wind
- Grounded Gemini explanations and civic context
- Map-first route comparison with hotspots and route cards

## Architecture

```mermaid
flowchart LR
  A[Landing Page] --> B[Registration Page]
  B --> C[Planner Page]
  C --> D[/api/route-analysis]
  D --> E[Google Routes API]
  D --> F[Google Pollen API]
  D --> G[Google Weather API]
  D --> H[Gemini via Google GenAI SDK]
  D --> I[NYC Tree Grid]
  I --> J[Exposure Scoring]
  E --> J
  F --> J
  G --> J
  J --> H
  H --> C
```

Important implementation areas:

- Landing page: [components/landing-page.tsx](/c:/Users/user/Desktop/Google/components/landing-page.tsx)
- Registration page: [components/register-page.tsx](/c:/Users/user/Desktop/Google/components/register-page.tsx)
- Planner page: [components/pollen-safe-app.tsx](/c:/Users/user/Desktop/Google/components/pollen-safe-app.tsx)
- Route analysis API: [app/api/route-analysis/route.ts](/c:/Users/user/Desktop/Google/app/api/route-analysis/route.ts)
- Scoring engine: [lib/scoring.ts](/c:/Users/user/Desktop/Google/lib/scoring.ts)
- Local profile + route draft persistence: [lib/storage.ts](/c:/Users/user/Desktop/Google/lib/storage.ts)

## Quick start

1. Copy `.env.example` to `.env.local`
2. Add your API keys
3. Install dependencies with `npm install`
4. Run `npm run dev`
5. Open `http://localhost:3000`

Recommended live setup:

- Start on `/`
- Enter a route
- Complete `/register`
- Continue to `/planner`

## Environment variables

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — Maps JavaScript + Places autocomplete for browser UI
- `GOOGLE_MAPS_API_KEY` — backend routing and geocoding
- `GOOGLE_POLLEN_API_KEY` — pollen signal lookup
- `GOOGLE_WEATHER_API_KEY` — weather signal lookup
- `GOOGLE_AI_API_KEY` — Gemini explanation generation
- `GEMINI_MODEL` — optional override, default `gemini-2.5-flash`

If some backend signals are unavailable, the app falls back to local scoring where possible. For the best experience, configure all keys.

## Demo scenario

- Start: `Washington Square Park, New York, NY`
- End: `Lincoln Center, New York, NY`
- Tree triggers: `oak`, `birch`, or `maple`
- Sensitivity: `medium` or `high`

This scenario is tuned to show a visible tradeoff between route speed and expected exposure.

## Tree grid preprocessing

The repo includes a demo tree grid in [data/tree-grid.sample.json](/c:/Users/user/Desktop/Google/data/tree-grid.sample.json).

To build a fresh artifact from the official tree census CSV:

```bash
npm run build-tree-grid -- ./StreetTreeCensus.csv ./data/tree-grid.generated.json
```

## Commands

```bash
npm run dev
npm run test
npm run build
```

## Verification status

At the current repo state:

- `npm run test` passes
- `npm run build` passes

## Deployment

The app is configured for standalone Next.js output and includes a `Dockerfile` suitable for Cloud Run.

```bash
gcloud run deploy treeroute --source .
```
