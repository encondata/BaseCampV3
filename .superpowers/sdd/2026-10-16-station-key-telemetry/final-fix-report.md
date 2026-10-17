
## Final fix

- station_key.clear() now silently clears station_status.paused (apply_clear_setup and load_key's unreadable-row drop go through it); the 401 key-drop branch of request_as_station clears it too, only when it actually dropped the key. No event is recorded.
- send_station_heartbeat omits `version` when empty or longer than 40 (MAX_VERSION).
- fixed-reader-report spec: goal line, non-goal, and proxy paragraph updated to say telemetry rides the station-key heartbeat, including with nobody signed in.
- routes/proxy.py: removed the unused `log` and `import logging`.
- Tests added: 401 drop / clear() / apply_clear_setup clear the flag with no extra event and no later "Uploads resumed"; version omitted when empty or 41 chars, kept at 40.
- Command: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Output: 576 passed in 14.47s
