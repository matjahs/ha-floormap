import { describe, expect, it } from "vitest";
import { parseHomeXml } from "../src/import/sweethome3d";

const stripXml = `<?xml version='1.0'?>
<home>
  <environment ambientLightColor='#073E7B' skyColor='#000000' groundColor='#A8A872'
    lightColor='#F1EBD5' ceilingLightColor='#F1EBD5'
    photoWidth='720' photoHeight='405' photoAspectRatio='VIEW_3D_RATIO'/>
  <level id='level-1' name='L1' elevation='0' floorThickness='10' height='250'/>
  <camera attribute='storedCamera' id='cam-1' name='top' lens='PINHOLE'
    x='100' y='100' z='500' yaw='0' pitch='1.57' fieldOfView='1.0'/>
  <light id='led-1' name='Kitchen LED' level='level-1' x='200' y='300' elevation='100'
    angle='0' width='200' depth='10' height='5' power='0.8'>
    <lightSource x='0.05' y='0.5' z='0.5' color='-1' diameter='20'/>
    <lightSource x='0.5' y='0.5' z='0.5' color='-1' diameter='20'/>
    <lightSource x='0.95' y='0.5' z='0.5' color='-1' diameter='20'/>
  </light>
  <light id='spot-1' name='Spot' level='level-1' x='50' y='50' elevation='200'
    angle='0' width='20' depth='20' height='10' power='0.5'>
    <lightSource x='0.5' y='0.5' z='0.5' color='-1' diameter='30'/>
  </light>
</home>
`;

describe("SH3D strip import", () => {
  it("emits one strip fixture for long multi-source lights", () => {
    const ir = parseHomeXml(stripXml, "strip.xml");
    const led = ir.fixtures.find((f) => f.name === "Kitchen LED");
    expect(led?.kind).toBe("strip");
    expect(led?.end).toBeDefined();
    expect(led?.samples).toBeGreaterThanOrEqual(4);
    // Spot remains a point
    const spot = ir.fixtures.find((f) => f.name === "Spot");
    expect(spot?.kind).toBe("point");
    expect(spot?.end).toBeUndefined();
  });
});
