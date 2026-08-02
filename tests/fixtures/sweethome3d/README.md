# SweetHome3D fixtures

- `Home.xml` — minimal synthetic home for unit tests
- `waalbandijk_2024.ir.json` — IR imported from the primary apartment model

To refresh the Waalbandijk IR and enable XML parse tests:

```bash
unzip -p /path/to/waalbandijk_2024.sh3d Home.xml > tests/fixtures/sweethome3d/Home.waalbandijk.xml
node dist/cli/import.js import /path/to/waalbandijk_2024.sh3d --out /tmp/w
cp /tmp/w/ir.json tests/fixtures/sweethome3d/waalbandijk_2024.ir.json
```

Projection ±2% vs hand-placed markers is opt-in until the SunFlow plate camera is
stored in the model:

```bash
CALIBRATE_CAMERA=1 npm test
```
