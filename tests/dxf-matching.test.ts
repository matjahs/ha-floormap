import { describe, expect, it } from "vitest";
import { importDxf } from "../src/import/dxf";
import { importSvg } from "../src/import/svg";
import { matchFixtures } from "../src/matching";
import { emptyIR } from "../src/import/ir";

const SAMPLE_DXF = `0
SECTION
2
HEADER
9
$INSUNITS
70
5
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
WALLS
10
0
20
0
11
100
21
0
0
LWPOLYLINE
8
ROOMS
70
1
90
4
10
0
20
0
10
100
20
0
10
100
20
80
10
0
20
80
0
ENDSEC
0
EOF
`;

describe("dxf / svg / matching", () => {
  it("imports DXF walls and closed polylines as rooms", () => {
    const ir = importDxf(SAMPLE_DXF, "sample.dxf");
    expect(ir.source.kind).toBe("floorplanner-dxf");
    expect(ir.walls.length).toBeGreaterThanOrEqual(1);
    expect(ir.rooms.length).toBe(1);
  });

  it("imports SVG polygons as rooms", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <polygon id="kitchen" points="0,0 100,0 100,50 0,50" data-area="kitchen"/>
    </svg>`;
    const ir = importSvg(svg);
    expect(ir.rooms).toHaveLength(1);
    expect(ir.rooms[0]?.areaHint).toBe("kitchen");
  });

  it("fuzzy-matches fixture names to light entities", () => {
    const ir = emptyIR("sweethome3d", "x");
    ir.fixtures = [
      {
        id: "f1",
        name: "Dining Table Light",
        position: { x: 0, y: 0, z: 0 },
        color: "#ffffff",
        power: 0.5,
        roomId: "r1",
      },
    ];
    ir.rooms = [
      {
        id: "r1",
        name: "Living Room",
        polygon: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      },
    ];
    const matches = matchFixtures(ir, [
      {
        entity_id: "light.livingroom_light_1",
        friendly_name: "Dining Table Light",
        area_name: "Living Room",
      },
      { entity_id: "light.bedroom_1_light", friendly_name: "Bedroom" },
    ]);
    expect(matches[0]?.best?.entity_id).toBe("light.livingroom_light_1");
    expect(matches[0]?.best?.score).toBeGreaterThanOrEqual(0.45);
  });
});
