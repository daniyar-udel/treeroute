# Backend

The backend is a standalone FastAPI project inside `backend/`.

## Structure

```text
backend/
  app/
    api/            FastAPI app and route handlers
    services/       orchestration use cases
    domain/         scoring, geometry, tree-grid logic
    integrations/   Google and Gemini clients
    schemas/        Pydantic models
  tests/            backend tests
  scripts/
    data/           data preparation scripts
    health/         health check scripts
```

## Run

From the repository root:

```bash
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.api.main:app --host 127.0.0.1 --port 8000 --env-file ..\.env.local
```

## Tests

```bash
cd backend
..\.venv\Scripts\python.exe -m unittest discover -s tests
```

## Utility Scripts

Health check:

```bash
cd backend
..\.venv\Scripts\python.exe scripts\health\check_fastapi_ready.py
```

Build a tree grid from raw census data:

```bash
cd backend
..\.venv\Scripts\python.exe scripts\data\build_tree_grid.py ..\StreetTreeCensus.csv ..\data\generated\tree-grid.generated.json
```

Set `TREE_GRID_PATH` in `.env.local` if you want to force a specific grid file. Otherwise the backend prefers `data/generated/tree-grid.generated.json` when present and falls back to the checked-in sample grid.

## Docker

Build from the repository root:

```bash
docker build -f backend/Dockerfile .
```
