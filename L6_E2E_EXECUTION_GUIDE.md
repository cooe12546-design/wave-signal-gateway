# L6 E2E Execution Guide — Ready-to-Run Fixtures & Commands

This file exists because I (Claude) cannot execute the real production steps myself — see `L6_FULL_E2E_PRODUCTION_CLOSURE_REPORT_V1.md` for exactly why. Everything below is prepared so the Owner (or Claude, if given the missing access) can run the actual closure quickly, using canonical production fixtures through the real endpoint.

**Every payload below is genuinely valid** against this project's own `validateEvent()` and `classifyEvent()` logic (same shape verified by the L1/L2 test suites) — not fabricated to bypass validation, per the L6 brief's own explicit instruction.

Replace `<SIGNAL_EVENT_API_KEY>` with the real Railway-configured value. Never paste the real key into a shared document — run these directly in a terminal with the env var substituted.

## 0. Create the account binding (once)

```bash
railway run npm run l6:bind -- <your_real_line_user_id>
```
(`<your_real_line_user_id>` — your own LINE userId, e.g. captured earlier via the `/line/webhook` route from L3A.)

## 1. Alert A — `SIGNAL_CREATED`

```bash
curl -X POST https://wave-signal-gateway-production.up.railway.app/signal-events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <SIGNAL_EVENT_API_KEY>" \
  -H "X-Account-Id: L6-OWNER-TEST-001" \
  -d '{
    "schema_version": "WAVE_SIGNAL_EVENT_V1",
    "event_id": "SIG-L6-TEST-001:SIGNAL_CREATED:1",
    "event_key": "SIG-L6-TEST-001:SIGNAL_CREATED:1",
    "event_type": "SIGNAL_CREATED",
    "event_sequence": 1,
    "signal_id": "SIG-L6-TEST-001",
    "market": { "symbol": "XAUUSD", "timeframe": "M5", "digits": 2, "point": 0.01 },
    "signal": { "direction": "BUY", "pattern": "HH_HL", "entry": 2345.60, "tp1": 2350.00, "tp2": 2355.00, "sl": 2340.00 },
    "lifecycle": { "signal_status": "ACTIVE", "entry_status": "AVAILABLE", "reason_codes": [], "replaced_by_signal_id": null, "replaces_signal_id": null },
    "initial_snapshot": { "machine_bias": "BULLISH", "market_structure": "HH_HL" },
    "source": { "engine": "market_sensor_v4" },
    "meta": { "live": true, "historical": false, "analysis_only": true }
  }'
```
Expect: `{"ok":true,"idempotent":false,"id":<n>,"event_key":"SIG-L6-TEST-001:SIGNAL_CREATED:1"}`

## 2. Alert B — `MARKET_CONTEXT_SNAPSHOT`

```bash
curl -X POST https://wave-signal-gateway-production.up.railway.app/signal-events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <SIGNAL_EVENT_API_KEY>" \
  -H "X-Account-Id: L6-OWNER-TEST-001" \
  -d '{
    "schema_version": "WAVE_SIGNAL_EVENT_V1",
    "event_id": "SIG-L6-TEST-001:MARKET_CONTEXT_SNAPSHOT:2",
    "event_key": "SIG-L6-TEST-001:MARKET_CONTEXT_SNAPSHOT:2",
    "event_type": "MARKET_CONTEXT_SNAPSHOT",
    "event_sequence": 2,
    "signal_id": "SIG-L6-TEST-001",
    "market": { "symbol": "XAUUSD", "timeframe": "M5" },
    "signal": { "direction": "BUY" },
    "lifecycle": { "reason_codes": [] },
    "initial_snapshot": { "machine_bias": "BULLISH", "market_structure": "HH_HL" }
  }'
```

## 3. Alert C — `TP1_HIT`

```bash
curl -X POST https://wave-signal-gateway-production.up.railway.app/signal-events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <SIGNAL_EVENT_API_KEY>" \
  -H "X-Account-Id: L6-OWNER-TEST-001" \
  -d '{
    "schema_version": "WAVE_SIGNAL_EVENT_V1",
    "event_id": "SIG-L6-TEST-001:TP1_HIT:3",
    "event_key": "SIG-L6-TEST-001:TP1_HIT:3",
    "event_type": "TP1_HIT",
    "event_sequence": 3,
    "signal_id": "SIG-L6-TEST-001",
    "market": { "symbol": "XAUUSD", "timeframe": "M5" },
    "signal": { "direction": "BUY", "tp1": 2350.00 },
    "lifecycle": { "reason_codes": [] }
  }'
```

## 4. Dedupe proof — resubmit event 1 exactly

```bash
# Re-run the EXACT same curl command from step 1, byte-for-byte.
```
Expect: `{"ok":true,"idempotent":true,"event_key":"SIG-L6-TEST-001:SIGNAL_CREATED:1"}` — and no second LINE message.

## 5. Inspect delivery ledger for each event

```bash
curl https://wave-signal-gateway-production.up.railway.app/deliveries/SIG-L6-TEST-001:SIGNAL_CREATED:1 \
  -H "X-API-Key: <SIGNAL_EVENT_API_KEY>"
```
Repeat with the `MARKET_CONTEXT_SNAPSHOT` and `TP1_HIT` event keys. Confirm: exactly one row per event key, `status: "DELIVERED"`, `attempt_count` matching what was logged.

## 6. Unknown-account zero-send proof (safe — uses a throwaway account id, never touches the real binding)

```bash
curl -X POST https://wave-signal-gateway-production.up.railway.app/signal-events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <SIGNAL_EVENT_API_KEY>" \
  -H "X-Account-Id: ACC-DOES-NOT-EXIST-L6-TEST" \
  -d '{
    "schema_version": "WAVE_SIGNAL_EVENT_V1",
    "event_id": "SIG-L6-UNKNOWN:SIGNAL_CREATED:1",
    "event_key": "SIG-L6-UNKNOWN:SIGNAL_CREATED:1",
    "event_type": "SIGNAL_CREATED",
    "event_sequence": 1,
    "signal_id": "SIG-L6-UNKNOWN",
    "market": { "symbol": "XAUUSD", "timeframe": "M5" },
    "signal": { "direction": "BUY", "entry": 2345.60 }
  }'
```
Expect ingest `200` (event still persisted), but `GET /deliveries/SIG-L6-UNKNOWN:SIGNAL_CREATED:1` should return `deliveries: []` — zero rows, zero LINE sends.

## Health check

```bash
curl https://wave-signal-gateway-production.up.railway.app/health
```
Expect: `{"ok":true,"service":"wave-signal-gateway"}`
