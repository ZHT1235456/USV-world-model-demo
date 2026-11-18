const radians = Math.PI / 180;
export const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export const degrees = (angle) => angle / radians;
export const headingDegrees = (angle) => ((degrees(angle) % 360) + 360) % 360;
export const fixedStep = 1 / 60;

// Local tangent plane in metres. Heading is clockwise from north, sway to starboard.
// Illustrative coefficients for the 2.4 m hull. They have not been fitted to sea trials.
export class SeaTrial {
  constructor() {
    this.reset();
  }

  reset() {
    this.command = { rpm: 1500, rudder: 0 };
    this.state = {
      time: 0,
      east: 0,
      north: 0,
      heading: 0,
      distance: 0,
      surge: 0,
      sway: 0,
      yawRate: 0,
      rpm: 0,
      rudder: 0,
    };
    this.track = [{ east: 0, north: 0 }];
    this.ticks = 0;
  }

  step() {
    const s = this.state;
    const dt = fixedStep;
    s.rpm += (this.command.rpm - s.rpm) * (1 - Math.exp(-dt / 0.72));
    s.rudder += clamp(this.command.rudder - s.rudder, -42 * dt, 42 * dt);
    const throttle = s.rpm / 2400;
    const angle = s.rudder * radians;
    const flow = s.surge * Math.abs(s.surge);
    const sideForce = (0.65 * flow + 0.25 * throttle * throttle) * Math.sin(angle);
    const surgeAcceleration =
      1.8 * throttle * throttle -
      0.27 * s.surge -
      0.14 * flow -
      0.16 * Math.abs(sideForce) +
      s.sway * s.yawRate;
    const swayAcceleration = -1.6 * s.sway - 0.26 * sideForce - s.surge * s.yawRate;
    const yawAcceleration = 0.8 * sideForce - 1.45 * s.yawRate - 0.45 * s.yawRate * Math.abs(s.yawRate);
    s.surge += surgeAcceleration * dt;
    s.sway += swayAcceleration * dt;
    s.yawRate += yawAcceleration * dt;
    s.heading += s.yawRate * dt;
    s.north += (s.surge * Math.cos(s.heading) - s.sway * Math.sin(s.heading)) * dt;
    s.east += (s.surge * Math.sin(s.heading) + s.sway * Math.cos(s.heading)) * dt;
    s.distance += Math.hypot(s.surge, s.sway) * dt;
    s.time = ++this.ticks * dt;
    if (this.ticks % 12 === 0) {
      this.track.push({ east: s.east, north: s.north });
      // Preserve the whole route at progressively lower spatial resolution.
      if (this.track.length > 2400) this.track = this.track.filter((_, i) => i % 2 === 0);
    }
  }

  startExample() {
    this.reset();
    for (let i = 0; i < 18 / fixedStep; i++) {
      this.command.rudder = i < 6 / fixedStep ? 0 : 12;
      this.step();
    }
  }
}
